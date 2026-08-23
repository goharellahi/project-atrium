import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import {
  auditEvents,
  bookings,
  type AuditActorType,
  type Booking,
  type BookingStatus,
} from '../db/schema';

/**
 * Any Drizzle handle that can run a statement — the real `Db` or a transaction
 * handle. Every method here takes one explicitly rather than reaching for an
 * ambient connection, because a transition must be able to join the caller's
 * transaction: the status change and its audit row have to commit or roll back
 * together, and a service that owns its own connection cannot do that.
 */
export type Executor = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export interface Actor {
  type: AuditActorType;
  /** NULL for SYSTEM and PAYGATE actors. */
  id: string | null;
}

export const SYSTEM_ACTOR: Actor = { type: 'SYSTEM', id: null };

/**
 * The legal transitions, declared as data.
 *
 * Written as a table rather than as branching code on purpose: the set of legal
 * moves is a property of the domain, and it should be readable in one place,
 * diffable in review, and testable without constructing a request. Anything not
 * in this table is a 409 — never a 500. Being asked for an illegal transition
 * is the NORMAL case under concurrency (two clients racing to confirm the same
 * hold, a webhook arriving after expiry), not a surprise the server should
 * report as its own fault.
 */
export const LEGAL_TRANSITIONS: Readonly<
  Record<BookingStatus, readonly BookingStatus[]>
> = {
  DRAFT: ['HELD'],
  HELD: ['PENDING_PAYMENT', 'EXPIRED', 'CANCELLED'],
  PENDING_PAYMENT: ['CONFIRMED', 'FAILED', 'EXPIRED'],
  CONFIRMED: ['CANCELLED', 'COMPLETED'],
  COMPLETED: [],
  EXPIRED: [],
  FAILED: [],
  CANCELLED: ['REFUNDED'],
  REFUNDED: [],
};

export function isLegalTransition(from: BookingStatus, to: BookingStatus): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

export interface TransitionInput {
  bookingId: string;
  to: BookingStatus;
  actor: Actor;
  reason: string;
  metadata?: Record<string, unknown>;
  /**
   * Refuse the transition unless the booking is currently in one of these
   * states. Not a substitute for the legality table — it is the caller saying
   * "I read this row as HELD and my decision depends on that", which is how a
   * lost update becomes a 409 instead of a silent overwrite.
   */
  expectedFrom?: readonly BookingStatus[];
  /** Additional columns to write in the same UPDATE. Never `status`. */
  patch?: Partial<
    Pick<Booking, 'expiresAt' | 'policySnapshot' | 'totalMinor' | 'rearmCount'>
  >;
}

/**
 * The ONLY place `bookings.status` is written.
 *
 * CLAUDE.md hard rule 1. Every transition here does three things inside the
 * caller's transaction:
 *
 *   1. locks the booking row (FOR UPDATE) so two concurrent transitions
 *      serialise rather than interleave,
 *   2. writes the new status,
 *   3. writes exactly one AuditEvent — not zero, not two.
 *
 * Splitting these across services is what makes an audit trail drift out of
 * step with the rows it claims to describe.
 */
@Injectable()
export class BookingStateMachine {
  /**
   * Create a booking directly in HELD.
   *
   * A creation is not a transition, but it is recorded as DRAFT -> HELD anyway
   * so every booking's audit trail begins at the same place. DRAFT is a state
   * no row is ever persisted in — it exists to name the origin of the arrow.
   *
   * The INSERT is deliberately unguarded: `no_room_overlap` decides whether it
   * is admissible. There is no conflict query before it, because a query and an
   * insert are two operations and the gap between them is the race.
   */
  async createHeld(
    tx: Executor,
    values: {
      venueId: string;
      roomId: string;
      userId: string;
      startsAt: Date;
      endsAt: Date;
      expiresAt: Date;
      totalMinor: bigint;
      currency: string;
    },
    actor: Actor,
    reason: string,
    metadata: Record<string, unknown> = {},
  ): Promise<Booking> {
    const [created] = await tx
      .insert(bookings)
      .values({ ...values, status: 'HELD' })
      .returning();

    if (!created) throw new ConflictException('Booking could not be created');

    await tx.insert(auditEvents).values({
      bookingId: created.id,
      actorType: actor.type,
      actorId: actor.id,
      fromState: 'DRAFT',
      toState: 'HELD',
      reason,
      metadata,
    });

    return created;
  }

  /** Apply one transition. 409 if it is not legal from the row's current state. */
  async transition(tx: Executor, input: TransitionInput): Promise<Booking> {
    const locked = await this.lockForUpdate(tx, input.bookingId);
    const from = locked.status;

    if (input.expectedFrom && !input.expectedFrom.includes(from)) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: `Booking is ${from}, expected one of ${input.expectedFrom.join(', ')}`,
        booking_id: input.bookingId,
        current_status: from,
      });
    }

    if (!isLegalTransition(from, input.to)) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: `Illegal transition ${from} -> ${input.to}`,
        booking_id: input.bookingId,
        current_status: from,
        attempted_status: input.to,
        legal_next: LEGAL_TRANSITIONS[from],
      });
    }

    const [updated] = await tx
      .update(bookings)
      .set({ status: input.to, updatedAt: new Date(), ...(input.patch ?? {}) })
      .where(eq(bookings.id, input.bookingId))
      .returning();

    if (!updated) throw new NotFoundException();

    await tx.insert(auditEvents).values({
      bookingId: updated.id,
      actorType: input.actor.type,
      actorId: input.actor.id,
      fromState: from,
      toState: input.to,
      reason: input.reason,
      metadata: input.metadata ?? {},
    });

    return updated;
  }

  /**
   * Record something that happened to a booking without changing its state.
   *
   * Used by the checkout re-arm, which moves `expires_at` but not `status`. The
   * audit row has `from_state === to_state`, which reads correctly: the hold's
   * life changed, its state did not. It lives here rather than in the booking
   * service so `bookings.expires_at` — the other field the hold mechanism
   * depends on — is also written in exactly one place.
   */
  async recordSideEffect(
    tx: Executor,
    input: {
      bookingId: string;
      actor: Actor;
      reason: string;
      metadata?: Record<string, unknown>;
      patch: Partial<
        Pick<Booking, 'expiresAt' | 'rearmCount' | 'policySnapshot' | 'totalMinor'>
      >;
      expectedFrom?: readonly BookingStatus[];
    },
  ): Promise<Booking> {
    const locked = await this.lockForUpdate(tx, input.bookingId);

    if (input.expectedFrom && !input.expectedFrom.includes(locked.status)) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: `Booking is ${locked.status}, expected one of ${input.expectedFrom.join(', ')}`,
        booking_id: input.bookingId,
        current_status: locked.status,
      });
    }

    const [updated] = await tx
      .update(bookings)
      .set({ ...input.patch, updatedAt: new Date() })
      .where(eq(bookings.id, input.bookingId))
      .returning();

    if (!updated) throw new NotFoundException();

    await tx.insert(auditEvents).values({
      bookingId: updated.id,
      actorType: input.actor.type,
      actorId: input.actor.id,
      fromState: locked.status,
      toState: locked.status,
      reason: input.reason,
      metadata: input.metadata ?? {},
    });

    return updated;
  }

  /**
   * Flip every stale HELD row for one room to EXPIRED, in the caller's
   * transaction, and audit each one.
   *
   * This exists because an exclusion constraint cannot carry a time-varying
   * predicate. `no_room_overlap` keys off `status IN ('HELD',...)`, so a hold
   * whose `expires_at` passed thirty seconds ago is still, as far as the
   * constraint is concerned, live — and it will reject a booking that ought to
   * succeed. The background sweeper alone is therefore NOT sufficient: it
   * closes the window on average, but the hold path needs it closed for this
   * room, right now, before the insert.
   *
   * Returns the ids expired, so the caller can log what it cleared.
   */
  async expireStaleHoldsForRoom(
    tx: Executor,
    roomId: string,
    actor: Actor = SYSTEM_ACTOR,
    reason = 'hold.expired.in_transaction',
  ): Promise<string[]> {
    const expired = await tx
      .update(bookings)
      .set({ status: 'EXPIRED', updatedAt: new Date() })
      .where(
        and(
          eq(bookings.roomId, roomId),
          eq(bookings.status, 'HELD'),
          lt(bookings.expiresAt, sql`now()`),
        ),
      )
      .returning({ id: bookings.id });

    for (const row of expired) {
      await tx.insert(auditEvents).values({
        bookingId: row.id,
        actorType: actor.type,
        actorId: actor.id,
        fromState: 'HELD',
        toState: 'EXPIRED',
        reason,
        metadata: { room_id: roomId },
      });
    }

    return expired.map((r) => r.id);
  }

  /**
   * Flip up to `limit` stale HELD rows platform-wide. The background sweeper's
   * half of the same job — see `HoldSweeper`.
   */
  async expireStaleHolds(
    tx: Executor,
    limit: number,
    actor: Actor = SYSTEM_ACTOR,
  ): Promise<string[]> {
    // A CTE rather than UPDATE ... LIMIT, which Postgres does not support.
    // SKIP LOCKED so a sweep never blocks behind a hold path mid-insert on one
    // of these rows: that row is about to be dealt with anyway.
    const result = await tx.execute<{ id: string }>(sql`
      WITH stale AS (
        SELECT id FROM bookings
        WHERE status = 'HELD' AND expires_at < now()
        ORDER BY expires_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE bookings b
         SET status = 'EXPIRED', updated_at = now()
        FROM stale
       WHERE b.id = stale.id
      RETURNING b.id
    `);

    const ids = result.rows.map((r) => r.id);

    for (const id of ids) {
      await tx.insert(auditEvents).values({
        bookingId: id,
        actorType: actor.type,
        actorId: actor.id,
        fromState: 'HELD',
        toState: 'EXPIRED',
        reason: 'hold.expired.sweeper',
        metadata: {},
      });
    }

    return ids;
  }

  private async lockForUpdate(tx: Executor, bookingId: string): Promise<Booking> {
    const rows = await tx
      .select()
      .from(bookings)
      .where(eq(bookings.id, bookingId))
      .for('update')
      .limit(1);

    const row = rows[0];
    if (!row) throw new NotFoundException();
    return row;
  }
}
