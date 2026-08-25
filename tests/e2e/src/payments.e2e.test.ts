import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import {
  api,
  armDelay,
  connect,
  createHold,
  createWorld,
  deliver,
  paygate,
  pay,
  postWebhook,
  signBody,
  waitFor,
  waitForStack,
  waitForStatus,
  type World,
} from './harness.js';

/**
 * Payment integrity, end to end, against the running stack.
 *
 * This is the suite P4 cut and P5 owes. Everything it asserts was DESIGNED for
 * in P4 and none of it had ever executed: the invariants were arguments in
 * comments, not observations.
 *
 * Every scenario forces its own case through Paygate's `_test` control surface
 * rather than waiting for a chaos branch to fire. Chaos is on — the same
 * configuration the stack deploys with — so natural duplicates and delays land
 * in the middle of these tests as well. Absorbing them is the point.
 */

let db: Client;
let world: World;

/**
 * The start of this run, read from Postgres rather than from the test host.
 *
 * Read from the database because the reconciliation window is compared against
 * database timestamps, and borrowing the test process's clock introduces a skew
 * that has nothing to do with what is being measured.
 *
 * No lookback, either. An earlier version reached back 60 seconds and picked up
 * the PREVIOUS run's deliberate orphan — which reconciliation was entirely
 * right to report, since it is a real unmatched delivery that nobody cleaned
 * up. The window has to be this run, not roughly this run.
 */
let cleanWindowFrom: string;

beforeAll(async () => {
  await waitForStack();
  db = await connect();
  world = await createWorld(db);
  const started = await db.query<{ now: string }>(`SELECT now()::text AS now`);
  cleanWindowFrom = new Date(started.rows[0]!.now).toISOString();
}, 180_000);

afterAll(async () => {
  await db?.end();
});

// ---------------------------------------------------------------------------
// 1. The happy path
// ---------------------------------------------------------------------------

describe('happy path: hold -> pay -> webhook -> CONFIRMED -> cancel -> refund', () => {
  let bookingId: string;
  let chargeId: string;

  it('holds, charges, and confirms on the webhook', async () => {
    // 72 hours out, so the cancellation below lands on the top refund tier.
    const hold = await createHold(world, 0, 72);
    bookingId = hold.id;

    // Room 10000 + equipment 5000 for one hour.
    expect(hold.total_minor).toBe('15000');
    expect(hold.status).toBe('HELD');

    const payment = await pay(world, bookingId);
    expect(payment.charge_id).toBeTruthy();
    chargeId = payment.charge_id!;

    // PENDING_PAYMENT the moment the charge is accepted. It may already have
    // become CONFIRMED if the webhook won the race with its own 202 — that is
    // Paygate's 25% branch, and both are correct here.
    const afterPay = await db.query<{ status: string }>(
      `SELECT status FROM bookings WHERE id = $1::uuid`,
      [bookingId],
    );
    expect(['PENDING_PAYMENT', 'CONFIRMED']).toContain(afterPay.rows[0]!.status);

    // Force the capture rather than waiting on a delivery that chaos may have
    // parked for 60-90 seconds. If the natural one already landed, this second
    // delivery is deduped on business effect — which is INV-3, tested properly
    // in the next block.
    await deliver(chargeId, { event: 'charge.succeeded' });
    await waitForStatus(db, bookingId, ['CONFIRMED']);
  });

  it('froze the cancellation policy onto the booking at confirmation', async () => {
    const row = await db.query<{ policy_snapshot: { tiers: unknown[]; resolved_from: string } }>(
      `SELECT policy_snapshot FROM bookings WHERE id = $1::uuid`,
      [bookingId],
    );
    const snapshot = row.rows[0]!.policy_snapshot;

    // Not null is the whole point: cancellation reads this and never the live
    // policy, so a venue changing its terms tomorrow cannot reprice today's
    // booking. A missing snapshot would leave the cancellation path with
    // nothing to read — which is exactly what happened before the seed was
    // fixed to restore the platform default policy row.
    expect(snapshot).toBeTruthy();
    expect(snapshot.tiers.length).toBeGreaterThan(0);
    expect(['platform', 'venue']).toContain(snapshot.resolved_from);
  });

  it('captured exactly one payment for the booking', async () => {
    const rows = await db.query<{ status: string; amount_minor: string; charge_id: string }>(
      `SELECT status, amount_minor::text, charge_id FROM payments WHERE booking_id = $1::uuid`,
      [bookingId],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]!.status).toBe('SUCCEEDED');
    expect(rows.rows[0]!.amount_minor).toBe('15000');
  });

  it('cancels more than 48h out and refunds 100% of both components', async () => {
    const res = await api<{
      status: string;
      refund: { total_refund_minor: string; room_refund_minor: string; equipment_refund_minor: string; tier: { min_hours_before: number } } | null;
    }>('POST', `/bookings/${bookingId}/cancel`, world.customer.token, {
      reason: 'e2e happy path',
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CANCELLED');
    expect(res.body.refund).not.toBeNull();

    // The top tier: room 100%, equipment 100%. Asserted as exact minor units,
    // not as "greater than zero" — the whole reason the calculator works in
    // BigInt is so this number is not approximately right.
    expect(res.body.refund!.tier.min_hours_before).toBe(48);
    expect(res.body.refund!.room_refund_minor).toBe('10000');
    expect(res.body.refund!.equipment_refund_minor).toBe('5000');
    expect(res.body.refund!.total_refund_minor).toBe('15000');
  });

  it('settles the refund and moves the booking to REFUNDED', async () => {
    const settled = await waitFor(
      'the refund to settle',
      async () => {
        const rows = await db.query<{ status: string; refund_id: string | null }>(
          `SELECT status, refund_id FROM payments WHERE booking_id = $1::uuid`,
          [bookingId],
        );
        return rows.rows[0]!;
      },
      (row) => row.refund_id !== null,
    );

    expect(settled.refund_id).toBeTruthy();

    // The refund webhook carries the booking from CANCELLED to REFUNDED. Force
    // it, for the same determinism reason as the capture.
    await deliver(chargeId, { event: 'refund.succeeded' });
    await waitForStatus(db, bookingId, ['REFUNDED']);
  });

  it('double-clicking cancel refunds once', async () => {
    const again = await api('POST', `/bookings/${bookingId}/cancel`, world.customer.token, {
      reason: 'the customer clicked twice',
    });

    // The state machine refuses REFUNDED -> CANCELLED. A 409, never a 500.
    expect(again.status).toBe(409);

    // Asked of Paygate rather than of our own tables: the claim is that the
    // PROVIDER only ever issued one refund, and our row saying so would be the
    // same code under test vouching for itself.
    const charge = await paygate<{ refunds: unknown[] }>(`/paygate/charges/${chargeId}`);
    expect(charge.body.refunds).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 2. INV-3 — charged at most once
// ---------------------------------------------------------------------------

describe('INV-3: one charge and one confirmation, however many deliveries arrive', () => {
  let bookingId: string;
  let chargeId: string;

  it('applies three identical charge.succeeded deliveries exactly once', async () => {
    const hold = await createHold(world, 1, 72);
    bookingId = hold.id;
    const payment = await pay(world, bookingId);
    chargeId = payment.charge_id!;

    // Three deliveries, three distinct delivery ids, one event. This is the
    // case delivery-id deduplication cannot handle, which is why the ledger
    // keys on (charge_id, event) instead.
    const deliveries = await deliver(chargeId, { event: 'charge.succeeded', times: 3 });
    expect(deliveries).toHaveLength(3);
    expect(new Set(deliveries.map((d) => d.delivery_id)).size).toBe(3);
    expect(deliveries.every((d) => d.response_status === 200)).toBe(true);

    await waitForStatus(db, bookingId, ['CONFIRMED']);
  });

  it('wrote exactly one payment_events row for the event', async () => {
    const events = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM payment_events
        WHERE charge_id = $1 AND event = 'charge.succeeded'`,
      [chargeId],
    );
    expect(events.rows[0]!.n).toBe('1');
  });

  it('recorded every delivery, and applied only the first', async () => {
    // Wait for the queue to drain before counting.
    //
    // An unprocessed delivery has error NULL, exactly like an applied one, so
    // grouping by error alone counts work-in-flight as work-done. The first
    // version of this test did that and read 2 applied where there was 1 — the
    // assertion was racing the worker it was meant to be checking.
    await waitFor(
      'every delivery for the charge to be processed',
      async () => {
        const rows = await db.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM webhook_deliveries
            WHERE charge_id = $1 AND processed_at IS NULL`,
          [chargeId],
        );
        return Number(rows.rows[0]!.n);
      },
      (pending) => pending === 0,
    );

    // All of them are recorded — the audit surface is not deduplicated, only
    // the effect is. `duplicate_effect` is the marker the worker leaves.
    const rows = await db.query<{ error: string | null; n: string }>(
      `SELECT error, COUNT(*)::text AS n FROM webhook_deliveries
        WHERE charge_id = $1 AND event = 'charge.succeeded' AND processed_at IS NOT NULL
        GROUP BY error`,
      [chargeId],
    );
    const byError = new Map(rows.rows.map((r) => [r.error ?? 'applied', Number(r.n)]));

    // Exactly one delivery carried the effect. Every other one — the two extra
    // forced deliveries, plus whatever Paygate's 30% duplicate branch added of
    // its own accord — was absorbed.
    expect(byError.get('applied')).toBe(1);
    expect(byError.get('duplicate_effect')).toBeGreaterThanOrEqual(2);
  });

  it('never created a second charge at the provider', async () => {
    const paid = await api<{ payment_id: string; charge_id: string; outcome: string }>(
      'POST',
      `/bookings/${bookingId}/pay`,
      world.customer.token,
    );

    // A retry after settlement returns the same payment, and says so.
    expect(paid.status).toBe(200);
    expect(paid.body.charge_id).toBe(chargeId);
    expect(paid.body.outcome).toBe('replayed');

    const payments = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM payments WHERE booking_id = $1::uuid`,
      [bookingId],
    );
    expect(payments.rows[0]!.n).toBe('1');

    const charges = await db.query<{ n: string }>(
      `SELECT COUNT(DISTINCT charge_id)::text AS n FROM payments WHERE booking_id = $1::uuid`,
      [bookingId],
    );
    expect(charges.rows[0]!.n).toBe('1');
  });
});

// ---------------------------------------------------------------------------
// 3. INV-4 — an expired hold is unconfirmable, and the money goes back
// ---------------------------------------------------------------------------

describe('INV-4: payment succeeds against a hold that has already expired', () => {
  let bookingId: string;
  let chargeId: string;

  it('does not confirm, and refunds automatically', async () => {
    const hold = await createHold(world, 2, 72);
    bookingId = hold.id;

    // Park the delivery so the capture cannot land before the hold lapses.
    await armDelay(600);

    const payment = await pay(world, bookingId);
    chargeId = payment.charge_id!;

    /**
     * Expire the hold by moving its own clock, rather than waiting out
     * HOLD_TTL_SECONDS.
     *
     * The default TTL is eight minutes and the test must not take eight
     * minutes. What is under test here is how the PAYMENT path reacts to an
     * expired hold, not the expiry mechanism — that has its own coverage in the
     * sweeper and the checkout path. Writing expires_at directly puts the row
     * in exactly the state the sweeper would have produced.
     */
    await db.query(
      `UPDATE bookings SET expires_at = now() - interval '1 minute' WHERE id = $1::uuid`,
      [bookingId],
    );

    await deliver(chargeId, { event: 'charge.succeeded' });

    // EXPIRED, never CONFIRMED. The slot may already belong to someone else, so
    // confirming it because the customer paid would be the worse outcome.
    const status = await waitForStatus(db, bookingId, ['EXPIRED', 'CONFIRMED']);
    expect(status).toBe('EXPIRED');
  });

  it('issued a refund against the captured charge', async () => {
    const payment = await waitFor(
      'the automatic refund to be issued',
      async () => {
        const rows = await db.query<{
          status: string;
          refund_id: string | null;
          refund_idempotency_key: string | null;
        }>(
          `SELECT status, refund_id, refund_idempotency_key
             FROM payments WHERE booking_id = $1::uuid`,
          [bookingId],
        );
        return rows.rows[0]!;
      },
      (row) => row.refund_id !== null,
    );

    // Derived from the charge id, not random. Two racing refund paths converge
    // on this one key and therefore on one refund.
    expect(payment.refund_idempotency_key).toBe(`refund:${chargeId}`);

    const charge = await paygate<{ refunds: unknown[] }>(`/paygate/charges/${chargeId}`);
    expect(charge.body.refunds).toHaveLength(1);
  });

  it('recorded the whole sequence in the audit trail, in order', async () => {
    const events = await db.query<{ reason: string; from_state: string; to_state: string }>(
      `SELECT reason, from_state, to_state FROM audit_events
        WHERE booking_id = $1::uuid ORDER BY occurred_at, id`,
      [bookingId],
    );
    const reasons = events.rows.map((r) => r.reason);

    // The narrative INV-4 requires: held, paid, expired late, refunded. Order
    // matters — a refund recorded before the expiry would describe a different
    // and wrong sequence of events.
    expect(reasons).toContain('hold.created');
    expect(reasons).toContain('payment.initiated');
    expect(reasons).toContain('hold.expired.payment_arrived_late');
    expect(reasons).toContain('refund.initiated.unconfirmable_hold');

    expect(reasons.indexOf('hold.created')).toBeLessThan(reasons.indexOf('payment.initiated'));
    expect(reasons.indexOf('payment.initiated')).toBeLessThan(
      reasons.indexOf('hold.expired.payment_arrived_late'),
    );
    expect(reasons.indexOf('hold.expired.payment_arrived_late')).toBeLessThan(
      reasons.indexOf('refund.initiated.unconfirmable_hold'),
    );

    // Exactly one transition wrote the expiry — not zero, not two.
    //
    // `from_state !== 'EXPIRED'` is load bearing, and its absence made this
    // assertion a coin flip. A settled refund against an already-terminal
    // booking writes `EXPIRED -> EXPIRED` with reason
    // `refund.settled.terminal_booking`, which is a deliberate record of the
    // money moving and not a second expiry. Whether that row exists by the time
    // this test runs depends entirely on whether Paygate's own
    // `refund.succeeded` delivery has landed yet — chaos is on, so usually it
    // has not, and occasionally it has. P8 caught it having.
    //
    // The question being asked is "how many times did this booking BECOME
    // expired", so a self-transition is not one of them.
    const expiries = events.rows.filter(
      (r) => r.to_state === 'EXPIRED' && r.from_state !== 'EXPIRED',
    );
    expect(expiries).toHaveLength(1);
    expect(expiries[0]!.from_state).toBe('PENDING_PAYMENT');
  });

  it('settles the refund and records it against the terminal booking', async () => {
    await deliver(chargeId, { event: 'refund.succeeded' });

    await waitFor(
      'the payment to be marked REFUNDED',
      async () => {
        const rows = await db.query<{ status: string }>(
          `SELECT status FROM payments WHERE booking_id = $1::uuid`,
          [bookingId],
        );
        return rows.rows[0]!.status;
      },
      (status) => status === 'REFUNDED',
    );

    // The booking stays EXPIRED — that state is terminal and the money moving
    // does not resurrect it. The audit row is where the settlement is recorded.
    const booking = await db.query<{ status: string }>(
      `SELECT status FROM bookings WHERE id = $1::uuid`,
      [bookingId],
    );
    expect(booking.rows[0]!.status).toBe('EXPIRED');

    const settled = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM audit_events
        WHERE booking_id = $1::uuid AND reason = 'refund.settled.terminal_booking'`,
      [bookingId],
    );
    expect(Number(settled.rows[0]!.n)).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// 4. A bad signature
// ---------------------------------------------------------------------------

describe('a webhook with a bad signature is rejected, logged, and never processed', () => {
  it('answers 401 and records the attempt', async () => {
    const hold = await createHold(world, 3, 72);
    const payment = await pay(world, hold.id);
    const chargeId = payment.charge_id!;

    // Let the legitimate effect land FIRST, and wait for it.
    //
    // This assertion used to snapshot the ledger straight after `pay()` and
    // compare it after the corrupted delivery. That measures "no payment_events
    // row appeared", which is not the claim — Paygate's own NATURAL delivery for
    // this charge is in flight at the same time, and when it arrived between the
    // two counts the test failed with `expected '1' to be '0'` for a reason
    // that has nothing to do with signatures. Found in P6; P5 shipped it green
    // because the natural delivery happened to win the race every time it ran.
    //
    // Forcing a valid delivery and waiting for exactly one ledger row makes the
    // baseline deterministic, and the assertion then says what it means: after
    // the corrupted delivery the count is STILL one. Late natural duplicates
    // cannot disturb it either, because UNIQUE (charge_id, event) is what INV-3
    // rests on — which makes this a stronger test than the one it replaces, not
    // a relaxed one.
    await deliver(chargeId, { event: 'charge.succeeded' });
    const before = await waitFor(
      'the legitimate charge.succeeded to be applied exactly once',
      async () =>
        (
          await db.query<{ n: string }>(
            `SELECT COUNT(*)::text AS n FROM payment_events WHERE charge_id = $1`,
            [chargeId],
          )
        ).rows[0]!,
      (row) => row.n === '1',
    );

    const [delivered] = await deliver(chargeId, {
      event: 'charge.succeeded',
      corruptSignature: true,
    });

    expect(delivered!.signature_corrupted).toBe(true);
    expect(delivered!.response_status).toBe(401);

    const recorded = await db.query<{
      signature_valid: boolean;
      error: string | null;
      processed_at: string | null;
      charge_id: string | null;
    }>(
      `SELECT signature_valid, error, processed_at, charge_id
         FROM webhook_deliveries WHERE delivery_id = $1`,
      [delivered!.delivery_id],
    );

    expect(recorded.rowCount).toBe(1);
    expect(recorded.rows[0]!.signature_valid).toBe(false);
    expect(recorded.rows[0]!.error).toBe('invalid_signature');

    // charge_id is NOT recorded for a rejected delivery. The body was never
    // parsed, and parsing an unverified body to file it more tidily would be
    // trusting exactly the bytes the signature check just refused.
    expect(recorded.rows[0]!.charge_id).toBeNull();

    // And the effect never happened.
    const after = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM payment_events WHERE charge_id = $1`,
      [chargeId],
    );
    expect(after.rows[0]!.n).toBe(before.n);
  });

  it('rejects a webhook with no signature header at all', async () => {
    const raw = JSON.stringify({
      charge_id: 'ch_nonexistent',
      reference: randomUUID(),
      event: 'charge.succeeded',
      amount_minor: 1,
      occurred_at: new Date().toISOString(),
    });

    const res = await postWebhook(raw, { signature: '' });
    expect(res.status).toBe(401);
  });

  it('verifies over the raw bytes — a re-serialised body does not verify', async () => {
    // Same object, different bytes: one has a space after the colon. A receiver
    // that verified a parsed-and-restringified body would accept both, and would
    // then also accept a body an attacker had reshaped. It must accept neither
    // but the original.
    const raw = '{"charge_id":"ch_x","reference":"r","event":"charge.succeeded","amount_minor":1,"occurred_at":"2026-01-01T00:00:00.000Z"}';
    const reshaped = '{"charge_id": "ch_x","reference":"r","event":"charge.succeeded","amount_minor":1,"occurred_at":"2026-01-01T00:00:00.000Z"}';

    const mismatched = await postWebhook(reshaped, { signature: signBody(raw) });
    expect(mismatched.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// 4b. A capture whose webhook never arrives at all
// ---------------------------------------------------------------------------

describe('a charge whose webhook is lost is resolved by asking the provider', () => {
  it('confirms the booking without ever receiving the delivery', async () => {
    // Park the delivery for ten minutes. Nothing will deliver it inside this
    // test, so the only route to CONFIRMED is the API asking Paygate directly.
    //
    // This is not a chaos scenario. It is the deployment: on Render's free tier
    // the API sleeps after fifteen idle minutes and answers 502 while it wakes,
    // and Paygate never retries a refused delivery. Without the poll the
    // booking would sit PENDING_PAYMENT with a captured charge behind it until
    // its hold lapsed.
    await armDelay(600);

    const hold = await createHold(world, 6, 72);
    const payment = await pay(world, hold.id);
    expect(payment.charge_id).toBeTruthy();

    const before = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM webhook_deliveries WHERE charge_id = $1`,
      [payment.charge_id],
    );

    // CHARGE_POLL_AFTER_SECONDS (100s) plus a drain tick, so allow generously.
    await waitForStatus(db, hold.id, ['CONFIRMED'], 170_000);

    // The proof that it was the poll and not a delivery: no webhook for this
    // charge was ever recorded.
    const after = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM webhook_deliveries WHERE charge_id = $1`,
      [payment.charge_id],
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);

    const settled = await db.query<{ status: string }>(
      `SELECT status FROM payments WHERE booking_id = $1::uuid`,
      [hold.id],
    );
    expect(settled.rows[0]!.status).toBe('SUCCEEDED');

    // And the ledger records the effect once, so the parked delivery is
    // absorbed rather than double-applied when it eventually fires.
    const events = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM payment_events
        WHERE charge_id = $1 AND event = 'charge.succeeded'`,
      [payment.charge_id],
    );
    expect(events.rows[0]!.n).toBe('1');
  }, 200_000);
});

// ---------------------------------------------------------------------------
// 5. Reconciliation over the clean window
// ---------------------------------------------------------------------------

describe('INV-5: everything above reconciles to zero', () => {
  it('reports no discrepancies across the whole run', async () => {
    const to = new Date(Date.now() + 60_000).toISOString();

    // grace_seconds=0 means nothing is excused as work-in-flight. Anything the
    // live path left unfinished shows up here.
    const report = await waitFor(
      'reconciliation to settle to zero',
      async () => {
        const res = await api<{
          discrepancy_count: number;
          by_kind: Record<string, number>;
          truncated: boolean;
        }>(
          'GET',
          `/admin/reconciliation?from=${cleanWindowFrom}&to=${to}&grace_seconds=0`,
          world.platformAdmin.token,
        );
        return res.body;
      },
      (body) => body.discrepancy_count === 0,
      60_000,
    );

    expect(report.discrepancy_count).toBe(0);
    expect(report.by_kind).toEqual({});
    expect(report.truncated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5b. The correlation id survives into the webhook path
// ---------------------------------------------------------------------------

describe('a correlation id supplied by the client reaches the webhook', () => {
  /**
   * The brief names this specifically and, until P6, nothing checked it.
   *
   * Every link existed — nginx passes X-Request-Id through, the middleware
   * adopts it, PaygateClient forwards it on the charge, Paygate stores it and
   * echoes it on delivery — but the id lived only in log lines. A chain of five
   * hops with no assertion anywhere on it is a chain that is one refactor away
   * from being four hops and a generated UUID that correlates with nothing, and
   * nothing would have failed.
   *
   * The assertion is made in two places for a reason. Paygate's own record
   * proves the id reached the PROVIDER and was echoed outbound; the
   * `webhook_deliveries` row proves the API adopted it again on the way back
   * IN. Either one alone leaves half the round trip unwitnessed.
   *
   * No separate negative case is needed to rule out the column simply being
   * filled with a locally minted id: the value asserted here is a random UUID
   * this test generated, and a `randomUUID()` in the middleware cannot equal
   * it. The assertion is that the id is THE one that went in, not merely that
   * the column is non-empty.
   */
  it('is stored by the provider, echoed on the delivery, and recorded by the API', async () => {
    const correlationId = `atrium-e2e-${randomUUID()}`;

    const hold = await createHold(world, 7, 96);
    const payment = await pay(world, hold.id, 6, { 'x-request-id': correlationId });
    expect(payment.charge_id).toBeTruthy();

    // Hop 1-3: client -> nginx -> API -> Paygate. Paygate stores what it was
    // sent on the charge request.
    const charge = await paygate<{ correlation_id: string | null }>(
      `/paygate/charges/${payment.charge_id}`,
    );
    expect(charge.status).toBe(200);
    expect(charge.body.correlation_id).toBe(correlationId);

    // Hop 4-5: Paygate -> nginx -> API, on a webhook that may land on a
    // different replica than the one that charged. Forced rather than waited
    // for: the natural delivery is subject to the 25% race and 5% delay
    // branches, and a test that waits on a probability is a coin flip.
    await deliver(payment.charge_id!, { event: 'charge.succeeded' });

    const recorded = await waitFor(
      'a delivery for this charge to be recorded with the correlation id',
      async () => {
        const rows = await db.query<{ correlation_id: string | null; delivery_id: string }>(
          `SELECT correlation_id, delivery_id
             FROM webhook_deliveries
            WHERE charge_id = $1 AND signature_valid
            ORDER BY received_at DESC`,
          [payment.charge_id],
        );
        return rows.rows;
      },
      (rows) => rows.length > 0 && rows.some((r) => r.correlation_id === correlationId),
    );

    // EVERY signed delivery for this charge carries it, not merely one of them.
    // Paygate echoes the id off the charge, so a duplicate delivery drawn from
    // the natural 30% branch is covered by the same assertion — which is the
    // case that matters, since that is the delivery most likely to be traced.
    expect(recorded.every((r) => r.correlation_id === correlationId)).toBe(true);

    await waitForStatus(db, hold.id, ['CONFIRMED']);
  }, 120_000);

});

// ---------------------------------------------------------------------------
// 6. A webhook for a charge we have never heard of
// ---------------------------------------------------------------------------

describe('a webhook for an unknown charge is neither 500ed nor dropped', () => {
  const orphanChargeId = `ch_orphan_${randomUUID().replace(/-/g, '')}`;
  const orphanReference = randomUUID();
  let deliveryId: string;

  it('answers 200 and records the delivery with its reference', async () => {
    deliveryId = randomUUID();
    const raw = JSON.stringify({
      charge_id: orphanChargeId,
      reference: orphanReference,
      event: 'charge.succeeded',
      amount_minor: 12_345,
      occurred_at: new Date().toISOString(),
    });

    const res = await postWebhook(raw, { deliveryId });

    // 200, because a 500 makes Paygate retry forever and a drop loses a
    // captured charge. The signature was valid; this is money that exists.
    expect(res.status).toBe(200);

    const recorded = await waitFor(
      'the orphan delivery to be recorded and attempted',
      async () => {
        const rows = await db.query<{
          charge_id: string | null;
          reference: string | null;
          error: string | null;
          processed_at: string | null;
          signature_valid: boolean;
        }>(
          `SELECT charge_id, reference, error, processed_at, signature_valid
             FROM webhook_deliveries WHERE delivery_id = $1`,
          [deliveryId],
        );
        return rows.rows[0]!;
      },
      (row) => row !== undefined && row.error === 'unknown_charge',
    );

    expect(recorded.signature_valid).toBe(true);
    expect(recorded.charge_id).toBe(orphanChargeId);
    // The reference is the booking id, and keeping it is what lets the money be
    // traced even though no payments row matches the charge.
    expect(recorded.reference).toBe(orphanReference);
    // Left unprocessed on purpose, so the drainer keeps retrying it — the
    // race-on-response case resolves itself this way — and so the reconciler
    // can see it.
    expect(recorded.processed_at).toBeNull();
  });

  it('and reconciliation catches it', async () => {
    const from = new Date(Date.now() - 300_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();

    const res = await api<{
      discrepancy_count: number;
      by_kind: Record<string, number>;
      discrepancies: { kind: string; charge_id: string | null; detail: string }[];
    }>(
      'GET',
      `/admin/reconciliation?from=${from}&to=${to}&grace_seconds=0`,
      world.platformAdmin.token,
    );

    expect(res.status).toBe(200);

    // The report that returned zero a moment ago now returns exactly this. That
    // pair of assertions is the point: a reconciler that cannot go non-zero is
    // not evidence of anything.
    expect(res.body.by_kind.unmatched_delivery).toBeGreaterThanOrEqual(1);

    const mine = res.body.discrepancies.filter((d) => d.charge_id === orphanChargeId);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.kind).toBe('unmatched_delivery');
    expect(mine[0]!.detail).toContain(orphanReference);
  });
});
