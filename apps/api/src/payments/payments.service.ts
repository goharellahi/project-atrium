import {
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import {
  auditEvents,
  bookingLineItems,
  bookings,
  cancellationPolicies,
  paymentEvents,
  payments,
  webhookDeliveries,
  type Booking,
  type Payment,
} from '../db/schema';
import { log } from '../common/logger';
import type { Env } from '../config/env';
import type { AuthPrincipal } from '../common/context/request-context';
import { getCorrelationId } from '../common/context/request-context';
import { withTransientRetry } from '../common/retry-transaction';
import {
  BookingStateMachine,
  SYSTEM_ACTOR,
  type Executor,
} from '../bookings/booking-state-machine.service';
import { PAYGATE_ACTOR } from './payments.constants';
import {
  computeRefund,
  parseSnapshot,
  TiersSchema,
  type PolicySnapshot,
  type Tier,
} from './refund-policy';
import type { PaymentProvider } from './payment-provider';

/**
 * The webhook body Paygate sends. Parsed only AFTER the signature verifies.
 *
 * Note there is no zod schema import here on purpose — the fields are read
 * defensively, because an unsigned or malformed body must produce a recorded
 * rejection rather than an exception from a validator.
 */
export interface WebhookBody {
  charge_id?: unknown;
  reference?: unknown;
  event?: unknown;
  amount_minor?: unknown;
  occurred_at?: unknown;
  refund_id?: unknown;
}

/** What the transactional half of a delivery decided the async half must do. */
interface RefundInstruction {
  paymentId: string;
  chargeId: string;
  bookingId: string;
  amountMinor: bigint;
  idempotencyKey: string;
  reason: string;
}

const SUPPORTED_EVENTS = new Set(['charge.succeeded', 'charge.failed', 'refund.succeeded']);

/**
 * Payment integrity — INV-3, INV-4 and the money half of INV-5.
 *
 * Three properties this file exists to hold, and the mechanism for each:
 *
 * **INV-3, charged at most once.** The idempotency key is derived from the
 * booking id (`charge:<booking_id>`), not generated per attempt, and it is
 * written to `payments` and COMMITTED before Paygate is called. A client retry,
 * a replica crash between the insert and the HTTP call, or two replicas racing
 * all converge on one key, and Paygate's own idempotency turns that into one
 * charge. On the inbound side, the effect of an event is gated on inserting
 * `payment_events (charge_id, event)`, which is UNIQUE — so thirty redeliveries
 * of `charge.succeeded` apply once.
 *
 * **INV-4, expired holds are unconfirmable.** The confirmation decision reads
 * the booking row under `FOR UPDATE` and refuses to confirm anything that is
 * not a live, unexpired hold. A payment that succeeds against a lapsed hold is
 * refunded automatically with a key derived from the charge id, and every step
 * of the sequence is audited.
 *
 * **A webhook is answered in milliseconds.** Paygate retries on timeout, so a
 * handler that did the work inline would manufacture exactly the duplicates
 * this file exists to prevent. `ingest` verifies, records, and returns; the work
 * happens after, driven by `webhook_deliveries.processed_at IS NULL`, which is
 * a durable queue rather than an in-memory one — a replica that dies mid-apply
 * leaves the row unprocessed and another replica picks it up.
 */
@Injectable()
export class PaymentsService {
  constructor(
    private readonly db: Db,
    private readonly sm: BookingStateMachine,
    private readonly env: Env,
    private readonly provider: PaymentProvider,
  ) {}

  // -------------------------------------------------------------------------
  // Outbound: POST /bookings/:id/pay
  // -------------------------------------------------------------------------

  /**
   * Charge a held booking.
   *
   * Legal only from HELD, and only while the hold is live. The ordering below
   * is the whole point and is not an implementation detail:
   *
   *   1. persist the payments row, with its idempotency key, and COMMIT
   *   2. only then call Paygate
   *
   * A crash between the two leaves a PENDING payment carrying the key that a
   * retry will reuse — recoverable. The reverse order leaves a charge at the
   * provider that this system has no record of, which is money lost silently
   * and a direct INV-5 violation.
   */
  async pay(bookingId: string, principal: AuthPrincipal): Promise<unknown> {
    const idempotencyKey = chargeKey(bookingId);

    // Retried on a class-40 rollback like the hold path, and safe for the same
    // reason: everything in here is inside one transaction, and Paygate is not
    // called until after it commits. A deadlock leaves nothing behind.
    const prepared = await withTransientRetry(
      'payments.pay',
      () =>
      this.db.transaction(async (tx) => {
      const booking = await this.loadOwned(tx, bookingId, principal);

      const existing = await this.findPaymentByKey(tx, idempotencyKey);

      // A retry. Return the same payment; never mint a second key, never call
      // the provider again for a settled charge.
      if (existing && existing.status !== 'PENDING') {
        return { booking, payment: existing, alreadySettled: true };
      }

      if (booking.status === 'HELD') {
        const now = Date.now();
        if (booking.expiresAt !== null && booking.expiresAt.getTime() <= now) {
          // The hold lapsed while the customer sat on the checkout page. Expire
          // it properly rather than charging against a slot we no longer hold.
          await this.sm.transition(tx, {
            bookingId,
            to: 'EXPIRED',
            actor: SYSTEM_ACTOR,
            reason: 'hold.expired.on_pay',
            expectedFrom: ['HELD'],
          });
          throw new ConflictException({
            statusCode: 409,
            error: 'Conflict',
            message: 'This hold has expired and cannot be paid for. Create a new one.',
            booking_id: bookingId,
            current_status: 'EXPIRED',
          });
        }
      } else if (booking.status !== 'PENDING_PAYMENT') {
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          message: `Cannot pay for a booking in state ${booking.status}`,
          booking_id: bookingId,
          current_status: booking.status,
        });
      }

      // The row first, always. `ON CONFLICT DO NOTHING` on the unique key makes
      // two replicas racing the same booking produce one payment, not two.
      await tx
        .insert(payments)
        .values({
          bookingId,
          idempotencyKey,
          amountMinor: booking.totalMinor,
          status: 'PENDING',
        })
        .onConflictDoNothing({ target: payments.idempotencyKey });

      const payment = await this.findPaymentByKey(tx, idempotencyKey);
      if (!payment) throw new ConflictException('Could not record the payment attempt');

      if (booking.status === 'HELD') {
        await this.sm.transition(tx, {
          bookingId,
          to: 'PENDING_PAYMENT',
          actor: { type: 'USER', id: principal.userId },
          reason: 'payment.initiated',
          expectedFrom: ['HELD'],
          metadata: { payment_id: payment.id, idempotency_key: idempotencyKey },
        });
      }

        return { booking, payment, alreadySettled: false };
      }),
      this.env.TRANSIENT_RETRY_ATTEMPTS,
    );

    if (prepared.alreadySettled) {
      return this.presentPayment(prepared.payment, 'replayed');
    }

    // Outside the transaction, and after the commit. Holding a booking row lock
    // across a network call to a provider that deliberately hangs would put the
    // hold path behind Paygate's latency.
    const accepted = await this.provider.charge({
      idempotencyKey,
      bookingId,
      amountMinor: prepared.payment.amountMinor,
      currency: prepared.booking.currency,
      correlationId: getCorrelationId(),
    });

    // `charge_id IS NULL` guard: the webhook may already have landed and
    // adopted this row (the 25% race-on-response branch), in which case the id
    // is already set and this must not clobber it.
    const [updated] = await this.db
      .update(payments)
      .set({ chargeId: accepted.chargeId, updatedAt: new Date() })
      .where(and(eq(payments.id, prepared.payment.id), isNull(payments.chargeId)))
      .returning();

    const current = updated ?? (await this.findPaymentById(this.db, prepared.payment.id));

    log().info(
      { bookingId, chargeId: accepted.chargeId, paymentId: prepared.payment.id },
      'payment.charge.accepted',
    );

    return this.presentPayment(current ?? prepared.payment, 'accepted');
  }

  // -------------------------------------------------------------------------
  // Inbound: POST /webhooks/paygate
  // -------------------------------------------------------------------------

  /**
   * Record an inbound delivery and return. Nothing heavy happens here.
   *
   * Order matters and is the order the brief specifies:
   *   1. verify the signature over the RAW bytes — reject 401, log, record
   *   2. record the delivery, keyed on the provider's delivery id
   *   3. dedupe the EFFECT later, on (charge_id, event), never on delivery id —
   *      a delivery id is new on every attempt and is therefore useless for it
   *   4. return 200 immediately; the work is drained asynchronously
   */
  async ingest(
    rawBody: Buffer,
    signature: string | undefined,
    deliveryIdHeader: string | undefined,
  ): Promise<{ deliveryRowId: string | null; status: 'accepted' | 'duplicate' }> {
    const secret = this.env.PAYGATE_SECRET;
    if (!secret) {
      // Refusing is the only honest answer: without the secret every signature
      // fails, and processing unverified bodies would be worse than a 503.
      throw new ServiceUnavailableException('PAYGATE_SECRET is not configured');
    }

    const raw = rawBody.toString('utf8');
    const valid = verifySignature(raw, secret, signature);
    const deliveryId = deliveryIdHeader ?? `unsigned-${cryptoRandom()}`;

    if (!valid) {
      log().warn(
        { deliveryId, bytes: raw.length },
        'webhook.rejected.invalid_signature',
      );
      await this.recordDelivery({
        deliveryId,
        chargeId: null,
        reference: null,
        event: null,
        signatureValid: false,
        raw,
        error: 'invalid_signature',
        // Never processed. Marking it processed keeps it out of the drain queue
        // and out of the reconciler's "stuck deliveries" list, where a burst of
        // bad signatures genuinely belongs.
        processedAt: new Date(),
      });
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Invalid webhook signature',
      });
    }

    let body: WebhookBody;
    try {
      body = JSON.parse(raw) as WebhookBody;
    } catch {
      await this.recordDelivery({
        deliveryId,
        chargeId: null,
        reference: null,
        event: null,
        signatureValid: true,
        raw,
        error: 'unparseable_body',
        processedAt: new Date(),
      });
      // A signed but unparseable body is Paygate's bug, not the caller's. 200
      // stops it retrying forever; the row is the evidence.
      return { deliveryRowId: null, status: 'accepted' };
    }

    const chargeId = asString(body.charge_id);
    const reference = asString(body.reference);
    const event = asString(body.event);

    const row = await this.recordDelivery({
      deliveryId,
      chargeId,
      reference,
      event,
      signatureValid: true,
      raw,
      error: event !== null && !SUPPORTED_EVENTS.has(event) ? 'unsupported_event' : null,
      processedAt: event !== null && !SUPPORTED_EVENTS.has(event) ? new Date() : null,
    });

    // A literal retry of the SAME delivery id. Nothing to do; the original row
    // is already queued or already applied.
    if (row === null) return { deliveryRowId: null, status: 'duplicate' };

    return { deliveryRowId: row.id, status: 'accepted' };
  }

  private async recordDelivery(input: {
    deliveryId: string;
    chargeId: string | null;
    reference: string | null;
    event: string | null;
    signatureValid: boolean;
    raw: string;
    error: string | null;
    processedAt: Date | null;
  }): Promise<{ id: string } | null> {
    const [row] = await this.db
      .insert(webhookDeliveries)
      .values({
        deliveryId: input.deliveryId,
        chargeId: input.chargeId,
        reference: input.reference,
        event: input.event,
        signatureValid: input.signatureValid,
        // The exact bytes, in a text column. The parsed form is a lossy
        // re-encoding of what was signed, and when a signature dispute happens
        // those bytes are the only useful evidence.
        rawBody: input.raw,
        error: input.error,
        processedAt: input.processedAt,
      })
      .onConflictDoNothing({ target: webhookDeliveries.deliveryId })
      .returning({ id: webhookDeliveries.id });

    return row ?? null;
  }

  // -------------------------------------------------------------------------
  // The worker
  // -------------------------------------------------------------------------

  /**
   * Apply one recorded delivery. Safe to call twice, from any replica.
   *
   * Split in two on purpose: a transaction decides what must happen and records
   * the decision, then any provider call happens outside it. A refund issued
   * while holding the booking row lock would keep that lock for the duration of
   * an HTTP round trip to a provider that deliberately hangs.
   */
  async applyDelivery(deliveryRowId: string): Promise<void> {
    // Three replicas drain the same queue and each apply takes a booking row
    // lock, so two deliveries for two bookings that share a room can deadlock.
    // Transient, fully rolled back, and the delivery is still unprocessed —
    // retrying here just saves waiting for the next sweep.
    const instruction = await withTransientRetry(
      'payments.applyDelivery',
      () => this.db.transaction(async (tx) => this.applyInTransaction(tx, deliveryRowId)),
      this.env.TRANSIENT_RETRY_ATTEMPTS,
    );

    if (instruction) await this.settleRefund(instruction);
  }

  private async applyInTransaction(
    tx: Executor,
    deliveryRowId: string,
  ): Promise<RefundInstruction | null> {
    const [delivery] = await tx
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, deliveryRowId))
      .for('update')
      .limit(1);

    if (!delivery || delivery.processedAt !== null) return null;

    // `raw_body` is text — the exact bytes received. See the schema comment for
    // why it must not be jsonb, and what broke when it was.
    const body = JSON.parse(delivery.rawBody) as WebhookBody;
    const chargeId = asString(body.charge_id);
    const event = asString(body.event);
    const reference = asString(body.reference);
    const occurredAt = parseDate(body.occurred_at) ?? new Date();

    if (chargeId === null || event === null || !SUPPORTED_EVENTS.has(event)) {
      await this.finishDelivery(tx, deliveryRowId, 'unsupported_event');
      return null;
    }

    // Find the payment. `charge_id` first; `reference` second.
    //
    // The second lookup is the 25% race-on-response branch: Paygate can deliver
    // the webhook before the 202 that names the charge, so at this instant the
    // payments row exists but its charge_id is still NULL. Correlating by
    // reference — the booking id — recovers it, and adopting the charge id here
    // means the pay() path's own guarded UPDATE later becomes a no-op rather
    // than a conflict.
    let payment = chargeId ? await this.findPaymentByChargeId(tx, chargeId) : null;

    if (!payment && reference) {
      payment = await this.adoptChargeByReference(tx, reference, chargeId);
    }

    if (!payment) {
      // Neither 500 nor dropped. The row keeps the reference and stays
      // unprocessed, so the drainer retries it — the payments row is usually
      // milliseconds behind — and the reconciler reports it if it never lands.
      await tx
        .update(webhookDeliveries)
        .set({ chargeId, reference, error: 'unknown_charge' })
        .where(eq(webhookDeliveries.id, deliveryRowId));

      log().warn({ chargeId, reference, event }, 'webhook.unknown_charge');
      return null;
    }

    // The idempotency gate for BUSINESS EFFECT. Everything below runs only if
    // this insert wins. Deduping on the delivery id instead would be useless:
    // Paygate mints a fresh delivery id per attempt, so every redelivery of the
    // same event would look new.
    const [claimed] = await tx
      .insert(paymentEvents)
      .values({ chargeId, event, occurredAt })
      .onConflictDoNothing({ target: [paymentEvents.chargeId, paymentEvents.event] })
      .returning({ id: paymentEvents.id });

    if (!claimed) {
      await this.finishDelivery(tx, deliveryRowId, 'duplicate_effect');
      log().info({ chargeId, event }, 'webhook.duplicate_effect.ignored');
      return null;
    }

    let instruction: RefundInstruction | null = null;

    switch (event) {
      case 'charge.succeeded':
        instruction = await this.onChargeSucceeded(tx, payment, chargeId, occurredAt);
        break;
      case 'charge.failed':
        await this.onChargeFailed(tx, payment);
        break;
      case 'refund.succeeded':
        await this.onRefundSucceeded(tx, payment, asString(body.refund_id), body.amount_minor);
        break;
      default:
        break;
    }

    await this.finishDelivery(tx, deliveryRowId, null);
    return instruction;
  }

  /**
   * The INV-4 fork.
   *
   * A captured charge lands on a booking that is either still a live hold — in
   * which case it confirms and freezes the cancellation policy — or is not, in
   * which case it must NOT confirm and the money goes back automatically. There
   * is no third branch, and in particular there is no branch that confirms an
   * expired hold "because the customer paid": the slot may already belong to
   * someone else, and a double-booked room is a worse outcome than a refund.
   */
  private async onChargeSucceeded(
    tx: Executor,
    payment: Payment,
    chargeId: string,
    occurredAt: Date,
  ): Promise<RefundInstruction | null> {
    await tx
      .update(payments)
      .set({ status: 'SUCCEEDED', chargeId, updatedAt: new Date() })
      .where(eq(payments.id, payment.id));

    const [booking] = await tx
      .select()
      .from(bookings)
      .where(eq(bookings.id, payment.bookingId))
      .for('update')
      .limit(1);

    if (!booking) throw new NotFoundException();

    const lapsed =
      booking.expiresAt !== null && booking.expiresAt.getTime() <= Date.now();
    const confirmable = booking.status === 'PENDING_PAYMENT' && !lapsed;

    if (confirmable) {
      const snapshot = await this.resolvePolicySnapshot(tx, booking.venueId);

      await this.sm.transition(tx, {
        bookingId: booking.id,
        to: 'CONFIRMED',
        actor: PAYGATE_ACTOR,
        reason: 'payment.captured',
        expectedFrom: ['PENDING_PAYMENT'],
        metadata: {
          charge_id: chargeId,
          payment_id: payment.id,
          occurred_at: occurredAt.toISOString(),
        },
        patch: {
          // The hold is now a confirmed booking; it has no TTL any more.
          expiresAt: null,
          // Frozen HERE, at the instant of confirmation, and never re-read.
          // A venue tightening its terms tomorrow cannot change what this
          // customer agreed to today.
          policySnapshot: snapshot,
        },
      });

      return null;
    }

    // Not confirmable. Move a lapsed PENDING_PAYMENT to EXPIRED first so the
    // booking's own state says why, then refund.
    if (booking.status === 'PENDING_PAYMENT') {
      await this.sm.transition(tx, {
        bookingId: booking.id,
        to: 'EXPIRED',
        actor: SYSTEM_ACTOR,
        reason: 'hold.expired.payment_arrived_late',
        expectedFrom: ['PENDING_PAYMENT'],
        metadata: { charge_id: chargeId, expires_at: booking.expiresAt?.toISOString() ?? null },
      });
    }

    const idempotencyKey = refundKey(chargeId);

    // Persisted before the provider is called, exactly as the charge key was,
    // and for the same reason: a crash between here and Paygate must not let a
    // retry mint a second refund.
    await tx
      .update(payments)
      .set({ refundIdempotencyKey: idempotencyKey, updatedAt: new Date() })
      .where(and(eq(payments.id, payment.id), isNull(payments.refundIdempotencyKey)));

    await tx.insert(auditEvents).values({
      bookingId: booking.id,
      actorType: 'SYSTEM',
      actorId: null,
      fromState: booking.status,
      toState: booking.status,
      reason: 'refund.initiated.unconfirmable_hold',
      metadata: {
        charge_id: chargeId,
        payment_id: payment.id,
        amount_minor: payment.amountMinor.toString(),
        booking_status: booking.status,
        invariant: 'INV-4',
      },
    });

    log().warn(
      { bookingId: booking.id, chargeId, status: booking.status },
      'payment.captured_against_unconfirmable_hold',
    );

    return {
      paymentId: payment.id,
      chargeId,
      bookingId: booking.id,
      amountMinor: payment.amountMinor,
      idempotencyKey,
      reason: 'hold_not_confirmable',
    };
  }

  private async onChargeFailed(tx: Executor, payment: Payment): Promise<void> {
    await tx
      .update(payments)
      .set({ status: 'FAILED', failureReason: 'provider_declined', updatedAt: new Date() })
      .where(eq(payments.id, payment.id));

    const [booking] = await tx
      .select()
      .from(bookings)
      .where(eq(bookings.id, payment.bookingId))
      .for('update')
      .limit(1);

    if (booking && booking.status === 'PENDING_PAYMENT') {
      await this.sm.transition(tx, {
        bookingId: booking.id,
        to: 'FAILED',
        actor: PAYGATE_ACTOR,
        reason: 'payment.declined',
        expectedFrom: ['PENDING_PAYMENT'],
        metadata: { payment_id: payment.id },
      });
    }
  }

  private async onRefundSucceeded(
    tx: Executor,
    payment: Payment,
    refundId: string | null,
    amountMinor: unknown,
  ): Promise<void> {
    const amount =
      typeof amountMinor === 'number' ? BigInt(Math.round(amountMinor)) : payment.amountMinor;

    await tx
      .update(payments)
      .set({
        status: 'REFUNDED',
        refundId: refundId ?? payment.refundId,
        refundedMinor: amount,
        updatedAt: new Date(),
      })
      .where(eq(payments.id, payment.id));

    const [booking] = await tx
      .select()
      .from(bookings)
      .where(eq(bookings.id, payment.bookingId))
      .for('update')
      .limit(1);

    if (!booking) return;

    if (booking.status === 'CANCELLED') {
      await this.sm.transition(tx, {
        bookingId: booking.id,
        to: 'REFUNDED',
        actor: PAYGATE_ACTOR,
        reason: 'refund.settled',
        expectedFrom: ['CANCELLED'],
        metadata: { refund_id: refundId, amount_minor: amount.toString() },
      });
      return;
    }

    // EXPIRED and FAILED are terminal states — the INV-4 case. The booking does
    // not move; the money did, and the audit row is where that is recorded.
    await tx.insert(auditEvents).values({
      bookingId: booking.id,
      actorType: 'PAYGATE',
      actorId: null,
      fromState: booking.status,
      toState: booking.status,
      reason: 'refund.settled.terminal_booking',
      metadata: {
        refund_id: refundId,
        amount_minor: amount.toString(),
        booking_status: booking.status,
        invariant: 'INV-4',
      },
    });
  }

  private async finishDelivery(
    tx: Executor,
    deliveryRowId: string,
    error: string | null,
  ): Promise<void> {
    await tx
      .update(webhookDeliveries)
      .set({ processedAt: new Date(), error })
      .where(eq(webhookDeliveries.id, deliveryRowId));
  }

  // -------------------------------------------------------------------------
  // Refunds
  // -------------------------------------------------------------------------

  /**
   * Call the provider and record the outcome.
   *
   * Idempotent by the key alone, which is derived from the charge id — so the
   * INV-4 automatic refund and a double-clicked cancel converge on ONE refund
   * at the provider even if they race. `refund.succeeded` will also arrive by
   * webhook and set the same columns; both paths are written to be safe to
   * apply twice.
   */
  async settleRefund(instruction: RefundInstruction): Promise<void> {
    if (instruction.amountMinor <= 0n) return;

    try {
      const accepted = await this.provider.refund({
        idempotencyKey: instruction.idempotencyKey,
        chargeId: instruction.chargeId,
        amountMinor: instruction.amountMinor,
        reason: instruction.reason,
        correlationId: getCorrelationId(),
      });

      await this.db
        .update(payments)
        .set({ refundId: accepted.refundId, updatedAt: new Date() })
        .where(and(eq(payments.id, instruction.paymentId), isNull(payments.refundId)));

      log().info(
        {
          bookingId: instruction.bookingId,
          chargeId: instruction.chargeId,
          refundId: accepted.refundId,
          amountMinor: instruction.amountMinor.toString(),
        },
        'payment.refund.accepted',
      );
    } catch (err: unknown) {
      // The key is already persisted, so this is recoverable: the reconciler
      // reports a captured charge whose refund never settled, and a retry with
      // the same key cannot double-refund.
      log().error(
        {
          bookingId: instruction.bookingId,
          chargeId: instruction.chargeId,
          err: err instanceof Error ? err.message : String(err),
        },
        'payment.refund.failed',
      );
    }
  }

  /**
   * The money half of a cancellation, run after the state transition commits.
   *
   * Reads the SNAPSHOT on the booking, never the live policy — the whole reason
   * the snapshot exists. A booking that never confirmed has no snapshot and no
   * captured charge, so there is nothing to refund and this is a no-op.
   */
  async settleCancellation(bookingId: string): Promise<RefundBreakdownView | null> {
    const instruction = await withTransientRetry(
      'payments.settleCancellation',
      () =>
      this.db.transaction(async (tx) => {
      const [booking] = await tx
        .select()
        .from(bookings)
        .where(eq(bookings.id, bookingId))
        .for('update')
        .limit(1);

      if (!booking) return null;

      const payment = await this.findCapturedPayment(tx, bookingId);
      if (!payment || payment.chargeId === null) return null;

      // Already refunded, or a refund already in flight under a key we minted.
      // Double-clicking cancel refunds once.
      if (payment.status === 'REFUNDED' || payment.refundIdempotencyKey !== null) {
        return null;
      }

      const snapshot = parseSnapshot(booking.policySnapshot);
      if (!snapshot) {
        log().warn({ bookingId }, 'cancellation.no_policy_snapshot');
        return null;
      }

      const split = await this.splitTotals(tx, booking);
      const breakdown = computeRefund({
        roomMinor: split.roomMinor,
        equipmentMinor: split.equipmentMinor,
        tiers: snapshot.tiers,
        startsAt: booking.startsAt,
        at: new Date(),
      });

      const idempotencyKey = refundKey(payment.chargeId);

      await tx
        .update(payments)
        .set({ refundIdempotencyKey: idempotencyKey, updatedAt: new Date() })
        .where(and(eq(payments.id, payment.id), isNull(payments.refundIdempotencyKey)));

      await tx.insert(auditEvents).values({
        bookingId,
        actorType: 'SYSTEM',
        actorId: null,
        fromState: booking.status,
        toState: booking.status,
        reason: 'refund.initiated.cancellation',
        metadata: {
          charge_id: payment.chargeId,
          tier: breakdown.tier,
          hours_before: breakdown.hours_before,
          room_refund_minor: breakdown.room_refund_minor.toString(),
          equipment_refund_minor: breakdown.equipment_refund_minor.toString(),
          total_refund_minor: breakdown.total_refund_minor.toString(),
          policy_id: snapshot.policy_id,
        },
      });

      return {
        instruction: {
          paymentId: payment.id,
          chargeId: payment.chargeId,
          bookingId,
          amountMinor: breakdown.total_refund_minor,
          idempotencyKey,
          reason: 'cancellation',
        } satisfies RefundInstruction,
        breakdown,
      };
      }),
      this.env.TRANSIENT_RETRY_ATTEMPTS,
    );

    if (!instruction) return null;

    await this.settleRefund(instruction.instruction);

    return {
      hours_before: instruction.breakdown.hours_before,
      tier: instruction.breakdown.tier,
      room_refund_minor: instruction.breakdown.room_refund_minor.toString(),
      equipment_refund_minor: instruction.breakdown.equipment_refund_minor.toString(),
      total_refund_minor: instruction.breakdown.total_refund_minor.toString(),
    };
  }

  // -------------------------------------------------------------------------
  // Policy resolution
  // -------------------------------------------------------------------------

  /**
   * The venue's newest policy if it has one, otherwise the platform's newest.
   *
   * One ORDER BY, no fallback constant in code. `cancellation_policies` is
   * append-only by convention, so "newest" is what a venue admin last wrote and
   * the older rows remain auditable.
   */
  async resolveTiers(
    tx: Executor,
    venueId: string | null,
  ): Promise<{ tiers: Tier[]; policyId: string; from: 'venue' | 'platform' }> {
    if (venueId) {
      const [row] = await tx
        .select()
        .from(cancellationPolicies)
        .where(eq(cancellationPolicies.venueId, venueId))
        .orderBy(desc(cancellationPolicies.createdAt))
        .limit(1);

      if (row) {
        return { tiers: TiersSchema.parse(row.tiers), policyId: row.id, from: 'venue' };
      }
    }

    const [platform] = await tx
      .select()
      .from(cancellationPolicies)
      .where(isNull(cancellationPolicies.venueId))
      .orderBy(desc(cancellationPolicies.createdAt))
      .limit(1);

    if (!platform) {
      /**
       * Migration 0003 inserts this row and the seed restores it after its
       * truncate. Its absence is a broken deployment, not a business case to
       * guess a default for — refunding nothing and refunding everything are
       * both defensible here and both wrong to choose silently.
       *
       * 503, not 500. A 500 says the server was surprised; this is a known,
       * named, fixable state and the response says exactly how to fix it. In
       * P4 this threw a bare Error, which meant a freshly seeded database
       * answered `GET /venues/cancellation-policy` with an opaque 500 and — far
       * worse — every `charge.succeeded` threw inside the worker transaction,
       * so no booking could reach CONFIRMED at all. Found in P5 by running it.
       */
      throw new ServiceUnavailableException({
        statusCode: 503,
        error: 'Service Unavailable',
        message:
          'No platform default cancellation policy exists. Migration 0003 inserts it; re-run migrations or re-seed. Bookings cannot be confirmed until it is present.',
        remedy: 'node dist/db/migrate.js, or pnpm seed',
      });
    }

    return { tiers: TiersSchema.parse(platform.tiers), policyId: platform.id, from: 'platform' };
  }

  private async resolvePolicySnapshot(
    tx: Executor,
    venueId: string,
  ): Promise<PolicySnapshot> {
    const resolved = await this.resolveTiers(tx, venueId);
    return {
      tiers: resolved.tiers,
      policy_id: resolved.policyId,
      resolved_from: resolved.from,
      snapshot_at: new Date().toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Split a booking total back into its room and equipment components.
   *
   * Recomputed from the line items using the same half-hour arithmetic the hold
   * path used, and the room share is the remainder — so the two components
   * always add back up to exactly `total_minor` and a refund can never exceed
   * what was charged.
   */
  private async splitTotals(
    tx: Executor,
    booking: Booking,
  ): Promise<{ roomMinor: bigint; equipmentMinor: bigint }> {
    const items = await tx
      .select()
      .from(bookingLineItems)
      .where(eq(bookingLineItems.bookingId, booking.id));

    const halfHours = BigInt(
      Math.round(((booking.endsAt.getTime() - booking.startsAt.getTime()) / 3_600_000) * 2),
    );

    const equipmentMinor = items.reduce(
      (sum, item) => sum + (halfHours * item.rateMinor * BigInt(item.quantity)) / 2n,
      0n,
    );

    const roomMinor = booking.totalMinor - equipmentMinor;
    return { roomMinor: roomMinor < 0n ? 0n : roomMinor, equipmentMinor };
  }

  private async loadOwned(
    tx: Executor,
    bookingId: string,
    principal: AuthPrincipal,
  ): Promise<Booking> {
    const rows = await tx
      .select()
      .from(bookings)
      .where(and(eq(bookings.id, bookingId), scopeFilter(principal)))
      .limit(1);

    const booking = rows[0];
    // 404, never 403 — a valid UUID from another venue must not be
    // distinguishable from one that does not exist (INV-6).
    if (!booking) throw new NotFoundException();
    return booking;
  }

  private async findPaymentByKey(tx: Executor, key: string): Promise<Payment | null> {
    const [row] = await tx
      .select()
      .from(payments)
      .where(eq(payments.idempotencyKey, key))
      .limit(1);
    return row ?? null;
  }

  private async findPaymentById(tx: Executor, id: string): Promise<Payment | null> {
    const [row] = await tx.select().from(payments).where(eq(payments.id, id)).limit(1);
    return row ?? null;
  }

  private async findPaymentByChargeId(tx: Executor, chargeId: string): Promise<Payment | null> {
    const [row] = await tx
      .select()
      .from(payments)
      .where(eq(payments.chargeId, chargeId))
      .for('update')
      .limit(1);
    return row ?? null;
  }

  private async findCapturedPayment(tx: Executor, bookingId: string): Promise<Payment | null> {
    const [row] = await tx
      .select()
      .from(payments)
      .where(and(eq(payments.bookingId, bookingId), eq(payments.status, 'SUCCEEDED')))
      .for('update')
      .limit(1);
    return row ?? null;
  }

  /** The race branch: claim the pending payment for this booking by reference. */
  private async adoptChargeByReference(
    tx: Executor,
    reference: string,
    chargeId: string,
  ): Promise<Payment | null> {
    if (!isUuid(reference)) return null;

    const [row] = await tx
      .select()
      .from(payments)
      .where(and(eq(payments.bookingId, reference), eq(payments.idempotencyKey, chargeKey(reference))))
      .for('update')
      .limit(1);

    if (!row) return null;

    if (row.chargeId === null) {
      const [adopted] = await tx
        .update(payments)
        .set({ chargeId, updatedAt: new Date() })
        .where(and(eq(payments.id, row.id), isNull(payments.chargeId)))
        .returning();
      return adopted ?? row;
    }

    return row.chargeId === chargeId ? row : null;
  }

  private presentPayment(payment: Payment, outcome: 'accepted' | 'replayed'): unknown {
    return {
      payment_id: payment.id,
      booking_id: payment.bookingId,
      charge_id: payment.chargeId,
      status: payment.status,
      amount_minor: payment.amountMinor.toString(),
      refunded_minor: payment.refundedMinor.toString(),
      idempotency_key: payment.idempotencyKey,
      outcome,
    };
  }
}

export interface RefundBreakdownView {
  hours_before: number;
  tier: Tier;
  room_refund_minor: string;
  equipment_refund_minor: string;
  total_refund_minor: string;
}

// ---------------------------------------------------------------------------
// Keys and helpers
// ---------------------------------------------------------------------------

/**
 * One booking, one charge key. Derived, never random.
 *
 * This is the single most load-bearing line in the payment path. A key
 * generated per attempt makes the provider's idempotency useless, because every
 * retry presents a key the provider has never seen. Deriving it from the
 * booking id means a client retry, a replica restart mid-flight, and two
 * replicas racing all present the same key.
 *
 * The cost: a booking whose charge was declined cannot be re-attempted under a
 * new charge — FAILED is terminal and the customer books again. That is the
 * accepted trade, recorded in DECISIONS.md.
 */
export function chargeKey(bookingId: string): string {
  return `charge:${bookingId}`;
}

/** One charge, one refund key. Same argument, applied to the money going back. */
export function refundKey(chargeId: string): string {
  return `refund:${chargeId}`;
}

/** Constant-time HMAC comparison over the RAW bytes. */
export function verifySignature(
  raw: string,
  secret: string,
  signature: string | undefined,
): boolean {
  if (!signature) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(raw, 'utf8').digest('hex'), 'utf8');
  const actual = Buffer.from(signature, 'utf8');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

function scopeFilter(principal: AuthPrincipal) {
  switch (principal.role) {
    case 'PLATFORM_ADMIN':
      return undefined;
    case 'VENUE_ADMIN':
    case 'VENUE_STAFF':
      return principal.venueId
        ? eq(bookings.venueId, principal.venueId)
        : sql`false`;
    default:
      return eq(bookings.userId, principal.userId);
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function cryptoRandom(): string {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}
