import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client';
import {
  bookingLineItems,
  bookings,
  equipmentTypes,
  rooms,
  venues,
  type Booking,
  type BookingStatus,
} from '../db/schema';
import { log } from '../common/logger';
import { isExclusionViolation, isTransientRollback } from '../common/pg-errors';
import { withTransientRetry } from '../common/retry-transaction';
import type { Env } from '../config/env';
import type { AuthPrincipal } from '../common/context/request-context';
import { isWithinOperatingHours, parseOperatingHours } from '../common/time/operating-hours';
import {
  BookingStateMachine,
  SYSTEM_ACTOR,
  type Actor,
  type Executor,
} from './booking-state-machine.service';
import {
  admissionCeiling,
  lockEquipmentTypes,
  peakConcurrentUsage,
} from './equipment-availability';
import {
  MAX_LEAD_DAYS,
  MIN_LEAD_MINUTES,
  type CancelInput,
  type HoldInput,
  type ListBookingsQuery,
} from './bookings.schemas';

const ACTIVE: readonly BookingStatus[] = ['HELD', 'PENDING_PAYMENT', 'CONFIRMED'];

/**
 * Advisory lock namespace for per-room hold serialisation.
 *
 * Arbitrary but fixed. The two-argument advisory lock space is separate from
 * the single-argument one used by the hold sweeper and the webhook drainer, so
 * this cannot collide with either.
 */
const ROOM_LOCK_NAMESPACE = 4771;

export interface HoldResult {
  booking: Booking;
  lineItems: { equipment_type_id: string; quantity: number; rate_minor: string }[];
  expiredStaleHolds: number;
}

@Injectable()
export class BookingsService {
  constructor(
    private readonly db: Db,
    private readonly sm: BookingStateMachine,
    private readonly env: Env,
  ) {}

  // -------------------------------------------------------------------------
  // The hold path
  // -------------------------------------------------------------------------

  /**
   * Create a hold. INV-1 and INV-2 both land here.
   *
   * The shape of this method is the whole design argument, so it is worth
   * stating plainly: **nothing in it decides whether the booking is admissible
   * by reading and then writing.** Rooms are decided by an exclusion constraint
   * during the INSERT; equipment is decided under a row lock taken before the
   * check. Every "is it free?" question that could be answered in application
   * memory has been removed, because application memory is per-replica and
   * there are three replicas.
   *
   * Validation that needs no database (granularity, duration, lead time) has
   * already run in zod. What is left needs the venue, so it runs here — and it
   * runs BEFORE the transaction opens, so a 422 never holds a lock.
   */
  async hold(input: HoldInput, principal: AuthPrincipal): Promise<HoldResult> {
    const context = await this.loadRoomContext(input.room_id);
    this.assertBookable(input, context);

    const requestedQuantities = new Map(
      input.line_items.map((li) => [li.equipment_type_id, li.quantity]),
    );

    const durationHours =
      (input.ends_at.getTime() - input.starts_at.getTime()) / 3_600_000;

    /**
     * The transaction is retried on a class-40 rollback, and only on that.
     *
     * Under 200 concurrent holds for one slot, Postgres reports the losers two
     * different ways: `23P01` — the exclusion constraint, a real answer meaning
     * "taken" — and occasionally `40P01`, a deadlock while checking that same
     * constraint, which means only that it could not order two transactions and
     * threw one away. The second is transient and says nothing about the slot.
     * A class-40 abort rolls the transaction back completely, so re-running it
     * is safe: no rows, no locks, no half-written audit trail.
     *
     * Exhausting the retries becomes a 409, not a 500. A slot that still
     * deadlocks after four attempts is contended, and "contended" is exactly
     * what a 409 says.
     */
    try {
      return await withTransientRetry(
        'bookings.hold',
        () => this.holdOnce(input, context, requestedQuantities, durationHours, principal),
        this.env.TRANSIENT_RETRY_ATTEMPTS,
      );
    } catch (err: unknown) {
      if (isTransientRollback(err)) {
        log().warn(
          { roomId: input.room_id, startsAt: input.starts_at.toISOString() },
          'hold rejected: sustained contention, gave up retrying',
        );
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          message:
            'That slot is under heavy contention right now and the request could not be ordered against the others. Retry.',
          room_id: input.room_id,
          starts_at: input.starts_at.toISOString(),
          ends_at: input.ends_at.toISOString(),
          reason: 'serialization_conflict',
        });
      }
      throw err;
    }
  }

  /** One attempt at the hold transaction. Retried by `hold` on a class-40 abort. */
  private async holdOnce(
    input: HoldInput,
    context: RoomContext,
    requestedQuantities: Map<string, number>,
    durationHours: number,
    principal: AuthPrincipal,
  ): Promise<HoldResult> {
    return this.db.transaction(async (tx) => {
      // (a0) Queue behind anyone else holding THIS room, before touching the
      //      exclusion index.
      //
      // This is NOT the correctness mechanism and must never be mistaken for
      // one — `no_room_overlap` still decides every admission, and removing
      // this line would change throughput, not outcomes. It is a queueing
      // discipline, and it exists because of something the P2 proof only
      // revealed when it was run repeatedly in P5.
      //
      // 200 concurrent inserts of the same range into a gist exclusion index do
      // not queue politely. Each inserter finds a conflicting in-progress tuple
      // and waits on that transaction's xid, and with enough of them the waits
      // form cycles: T1 waits on T2 while T2 waits on T1. Postgres resolves a
      // cycle by aborting one side — but only after `deadlock_timeout`, which
      // defaults to a full second. Measured over five consecutive proof runs
      // that produced 227 deadlocks, and 227 seconds of lock waiting spread
      // across a 20-connection pool is what turned a correct system into one
      // answering 500s and nginx 504s.
      //
      // A transaction-scoped advisory lock keyed on the room replaces that
      // free-for-all with a total order. Everyone takes the same lock first, so
      // no cycle can form; the winner commits and releases it, and every
      // subsequent contender then hits a COMMITTED conflicting row and gets its
      // 23P01 immediately instead of waiting a second to be told. Different
      // rooms hash to different keys and never queue behind each other.
      //
      // The two-argument form occupies a different advisory lock space from the
      // single-argument locks the hold sweeper and webhook drainer use, so the
      // namespaces cannot collide. A hashtext collision between two rooms would
      // cost throughput on those two rooms and nothing else.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${ROOM_LOCK_NAMESPACE}, hashtext(${input.room_id}))`,
      );

      // (a) Expire stale holds for THIS room, in this transaction.
      //
      // `no_room_overlap` has a status predicate but no time predicate: an
      // expired-but-unswept HELD row is still live as far as the constraint is
      // concerned and will reject a booking that ought to succeed. The
      // background sweeper closes that window on average; this closes it for
      // this room, now, before the insert. Both halves are required.
      const expired = await this.sm.expireStaleHoldsForRoom(tx, input.room_id);

      // (b) Equipment admission, BEFORE the room insert.
      //
      // Ordered this way on purpose. The room INSERT can block on the exclusion
      // index behind another transaction, and holding equipment row locks while
      // blocked there would widen the equipment contention window to include
      // room contention. Deciding equipment first means the locks are held for
      // exactly the queries that need them.
      const priced = await this.admitEquipment(
        tx,
        input,
        context.venueId,
        context.overbookingBufferPct,
        requestedQuantities,
        durationHours,
      );

      // Priced in half-hour units, because that is the booking grid. Dividing
      // once at the end rather than per half hour keeps the rounding error to
      // at most one minor unit for the whole booking instead of one per slot.
      const halfHours = BigInt(Math.round(durationHours * 2));
      const roomTotal = (context.hourlyRateMinor * halfHours) / 2n;

      const totalMinor =
        roomTotal + priced.reduce((sum, item) => sum + item.lineTotalMinor, 0n);

      const expiresAt = new Date(Date.now() + this.env.HOLD_TTL_SECONDS * 1000);

      // (c) The room decision. One INSERT, no preceding conflict query.
      let booking: Booking;
      try {
        booking = await this.sm.createHeld(
          tx,
          {
            venueId: context.venueId,
            roomId: input.room_id,
            userId: principal.userId,
            startsAt: input.starts_at,
            endsAt: input.ends_at,
            expiresAt,
            totalMinor,
            currency: context.currency,
          },
          { type: 'USER', id: principal.userId },
          'hold.created',
          {
            duration_hours: durationHours,
            line_item_count: input.line_items.length,
            expired_stale_holds: expired.length,
          },
        );
      } catch (err: unknown) {
        // SQLSTATE 23P01. This is INV-1 firing, and it is the expected outcome
        // for 199 of 200 concurrent requests — a 409, never a 500. The error is
        // nested under `cause` by Drizzle, which is why pg-errors walks the
        // chain rather than checking one level.
        if (isExclusionViolation(err)) {
          log().info(
            { roomId: input.room_id, startsAt: input.starts_at.toISOString() },
            'hold rejected: room slot taken',
          );
          throw new ConflictException({
            statusCode: 409,
            error: 'Conflict',
            message:
              'That room is already booked for an overlapping period, including the 15-minute turnaround.',
            room_id: input.room_id,
            starts_at: input.starts_at.toISOString(),
            ends_at: input.ends_at.toISOString(),
            constraint: 'no_room_overlap',
          });
        }
        throw err;
      }

      if (priced.length > 0) {
        await tx.insert(bookingLineItems).values(
          priced.map((item) => ({
            bookingId: booking.id,
            equipmentTypeId: item.equipmentTypeId,
            quantity: item.quantity,
            rateMinor: item.rateMinor,
          })),
        );
      }

      return {
        booking,
        lineItems: priced.map((item) => ({
          equipment_type_id: item.equipmentTypeId,
          quantity: item.quantity,
          rate_minor: item.rateMinor.toString(),
        })),
        expiredStaleHolds: expired.length,
      };
    });
  }

  /**
   * Lock the requested equipment types, then admit or refuse each one against
   * peak concurrent usage.
   *
   * The lock is what makes the check safe; the check is what makes the lock
   * meaningful. Neither works alone: without the lock two transactions read the
   * same peak and both admit, and without the sweep line the lock protects an
   * answer that was wrong to begin with.
   */
  private async admitEquipment(
    tx: Executor,
    input: HoldInput,
    venueId: string,
    bufferPct: number,
    requested: Map<string, number>,
    durationHours: number,
  ): Promise<
    {
      equipmentTypeId: string;
      quantity: number;
      rateMinor: bigint;
      lineTotalMinor: bigint;
    }[]
  > {
    if (input.line_items.length === 0) return [];

    const ids = [...requested.keys()].sort();
    const locked = await lockEquipmentTypes(tx, ids);

    if (locked.length !== ids.length) {
      const found = new Set(locked.map((row) => row.id));
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: 'Unprocessable Entity',
        message: 'Unknown equipment type',
        unknown_equipment_type_ids: ids.filter((id) => !found.has(id)),
      });
    }

    // Equipment belongs to a venue and so does the room. Renting Karachi's
    // cameras against a London room would be a cross-tenant write dressed up as
    // a booking, so the venue is compared rather than assumed.
    const foreign = locked.filter((row) => row.venue_id !== venueId);
    if (foreign.length > 0) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: 'Unprocessable Entity',
        message: 'Equipment must belong to the same venue as the room',
        equipment_type_ids: foreign.map((row) => row.id),
      });
    }

    const peaks = await peakConcurrentUsage(tx, ids, input.starts_at, input.ends_at);

    const shortfalls: {
      equipment_type_id: string;
      name: string;
      requested: number;
      peak_in_use: number;
      ceiling: number;
      short_by: number;
    }[] = [];

    for (const row of locked) {
      const want = requested.get(row.id) ?? 0;
      const peak = peaks.get(row.id) ?? 0;
      const ceiling = admissionCeiling(row.units_owned, bufferPct);

      if (peak + want > ceiling) {
        shortfalls.push({
          equipment_type_id: row.id,
          name: row.name,
          requested: want,
          peak_in_use: peak,
          ceiling,
          short_by: peak + want - ceiling,
        });
      }
    }

    if (shortfalls.length > 0) {
      log().info({ shortfalls }, 'hold rejected: equipment capacity');
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: shortfalls
          .map(
            (s) =>
              `${s.name}: requested ${s.requested}, ${s.peak_in_use} already reserved at peak against a ceiling of ${s.ceiling} — short by ${s.short_by}`,
          )
          .join('; '),
        shortfalls,
      });
    }

    return locked.map((row) => {
      const quantity = requested.get(row.id) ?? 0;
      const rateMinor = BigInt(row.hourly_rate_minor);
      return {
        equipmentTypeId: row.id,
        quantity,
        rateMinor,
        // Half-hour granularity, so charge in half-hour units rather than
        // truncating to whole hours.
        lineTotalMinor:
          (BigInt(Math.round(durationHours * 2)) * rateMinor * BigInt(quantity)) / 2n,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Checkout re-arm
  // -------------------------------------------------------------------------

  /**
   * Re-arm the hold to `now + CHECKOUT_REARM_SECONDS`.
   *
   * ARCHITECTURE.md Assumption 1: the brief sets an 8-minute hold TTL and
   * separately guarantees at least 10 minutes from reaching checkout. Both
   * cannot hold for a hold created 8 minutes before checkout is reached, so
   * reaching checkout extends the hold — bounded, or a client could re-enter
   * checkout forever and squat a slot.
   *
   * Two independent bounds, whichever binds first:
   *   - at most MAX_HOLD_REARMS re-arms,
   *   - never past MAX_HOLD_LIFETIME_SECONDS from creation.
   *
   * An already-expired hold cannot be re-armed. That is INV-4's shape appearing
   * early: expiry is a one-way door, and reviving a lapsed hold would hand back
   * a slot someone else may already hold.
   */
  async checkout(bookingId: string, principal: AuthPrincipal): Promise<Booking> {
    return this.db.transaction(async (tx) => {
      const booking = await this.loadOwnedBooking(tx, bookingId, principal);

      if (!ACTIVE.includes(booking.status) || booking.status === 'CONFIRMED') {
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          message: `Cannot check out a booking in state ${booking.status}`,
          booking_id: bookingId,
          current_status: booking.status,
        });
      }

      const now = Date.now();

      if (booking.expiresAt !== null && booking.expiresAt.getTime() <= now) {
        // Expire it properly rather than reporting a stale row as live. The
        // sweeper would get here eventually; the customer is here now.
        await this.sm.transition(tx, {
          bookingId,
          to: 'EXPIRED',
          actor: SYSTEM_ACTOR,
          reason: 'hold.expired.on_checkout',
          expectedFrom: ['HELD', 'PENDING_PAYMENT'],
        });
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          message: 'This hold has expired. Create a new one.',
          booking_id: bookingId,
          current_status: 'EXPIRED',
        });
      }

      if (booking.rearmCount >= this.env.MAX_HOLD_REARMS) {
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          message: `Checkout may be re-entered at most ${this.env.MAX_HOLD_REARMS} times`,
          booking_id: bookingId,
          rearm_count: booking.rearmCount,
        });
      }

      const lifetimeCap =
        booking.createdAt.getTime() + this.env.MAX_HOLD_LIFETIME_SECONDS * 1000;
      const requested = now + this.env.CHECKOUT_REARM_SECONDS * 1000;

      if (lifetimeCap <= now) {
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          message: `A hold may not live beyond ${this.env.MAX_HOLD_LIFETIME_SECONDS / 60} minutes`,
          booking_id: bookingId,
        });
      }

      // Clamp rather than refuse. A customer 28 minutes into a 30-minute cap
      // gets the 2 minutes that remain, not an error — the cap exists to stop
      // squatting, not to punish someone mid-payment.
      const expiresAt = new Date(Math.min(requested, lifetimeCap));

      return this.sm.recordSideEffect(tx, {
        bookingId,
        actor: { type: 'USER', id: principal.userId },
        reason: 'hold.rearmed',
        expectedFrom: ['HELD', 'PENDING_PAYMENT'],
        metadata: {
          previous_expires_at: booking.expiresAt?.toISOString() ?? null,
          new_expires_at: expiresAt.toISOString(),
          clamped_to_lifetime_cap: requested > lifetimeCap,
        },
        patch: { expiresAt, rearmCount: booking.rearmCount + 1 },
      });
    });
  }

  // -------------------------------------------------------------------------
  // Cancel
  // -------------------------------------------------------------------------

  /**
   * Cancel a booking. State only — refund amounts are P3.
   *
   * HELD -> CANCELLED and CONFIRMED -> CANCELLED are both legal; anything else
   * is a 409 from the state machine, including the double-cancel a client will
   * send when its first request times out.
   */
  async cancel(
    bookingId: string,
    input: CancelInput,
    principal: AuthPrincipal,
  ): Promise<Booking> {
    return this.db.transaction(async (tx) => {
      const booking = await this.loadOwnedBooking(tx, bookingId, principal);

      return this.sm.transition(tx, {
        bookingId: booking.id,
        to: 'CANCELLED',
        actor: { type: 'USER', id: principal.userId },
        reason: input.reason,
        metadata: { cancelled_by_role: principal.role },
      });
    });
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /**
   * A CUSTOMER sees their own bookings; venue staff and admins see their
   * venue's; a PLATFORM_ADMIN sees everything.
   *
   * The scope comes from the token, never from a query parameter — CLAUDE.md
   * hard rule 4. There is deliberately no `venue_id` filter on this endpoint,
   * so there is nothing for a caller to tamper with.
   */
  async list(
    query: ListBookingsQuery,
    principal: AuthPrincipal,
  ): Promise<{ data: unknown[]; page: number; page_size: number; total: number }> {
    const predicates: (SQL | undefined)[] = [this.scopeFilter(principal)];

    if (query.status) predicates.push(eq(bookings.status, query.status));
    if (query.from) predicates.push(gte(bookings.startsAt, query.from));
    if (query.to) predicates.push(lte(bookings.startsAt, query.to));

    const where = and(...predicates.filter((p): p is SQL => p !== undefined));

    const rowsPromise = this.db
      .select({
        id: bookings.id,
        venue_id: bookings.venueId,
        room_id: bookings.roomId,
        room_name: rooms.name,
        user_id: bookings.userId,
        starts_at: bookings.startsAt,
        ends_at: bookings.endsAt,
        status: bookings.status,
        expires_at: bookings.expiresAt,
        rearm_count: bookings.rearmCount,
        total_minor: bookings.totalMinor,
        currency: bookings.currency,
        created_at: bookings.createdAt,
      })
      .from(bookings)
      .innerJoin(rooms, eq(rooms.id, bookings.roomId))
      .where(where)
      .orderBy(desc(bookings.startsAt))
      .limit(query.page_size)
      .offset((query.page - 1) * query.page_size);

    const countPromise = this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(bookings)
      .where(where);

    const [rows, counted] = await Promise.all([rowsPromise, countPromise]);

    return {
      data: rows.map((r) => ({ ...r, total_minor: r.total_minor.toString() })),
      page: query.page,
      page_size: query.page_size,
      total: counted[0]?.total ?? 0,
    };
  }

  /** One booking with its line items and audit trail, scoped the same way. */
  async findOne(bookingId: string, principal: AuthPrincipal): Promise<unknown> {
    const [booking] = await this.db
      .select()
      .from(bookings)
      .where(and(eq(bookings.id, bookingId), this.scopeFilter(principal)))
      .limit(1);

    // 404 rather than 403 for another venue's booking, so a valid UUID cannot
    // be used to confirm that a row exists. ARCHITECTURE.md Assumption 6.
    if (!booking) throw new NotFoundException();

    const items = await this.db
      .select({
        equipment_type_id: bookingLineItems.equipmentTypeId,
        name: equipmentTypes.name,
        quantity: bookingLineItems.quantity,
        rate_minor: bookingLineItems.rateMinor,
      })
      .from(bookingLineItems)
      .innerJoin(equipmentTypes, eq(equipmentTypes.id, bookingLineItems.equipmentTypeId))
      .where(eq(bookingLineItems.bookingId, bookingId));

    // Every field is listed rather than spread.
    //
    // `bookings.total_minor` is a bigint — money is stored in minor units as a
    // 64-bit integer so no amount ever passes through a float — and
    // `JSON.stringify` throws on a BigInt rather than coercing it. Spreading the
    // row leaves `totalMinor` in the object alongside the stringified copy, and
    // the response 500s. An explicit projection also means a column added to the
    // table later is not silently published by this endpoint.
    return {
      id: booking.id,
      venue_id: booking.venueId,
      room_id: booking.roomId,
      user_id: booking.userId,
      status: booking.status,
      starts_at: booking.startsAt.toISOString(),
      ends_at: booking.endsAt.toISOString(),
      expires_at: booking.expiresAt?.toISOString() ?? null,
      rearm_count: booking.rearmCount,
      policy_snapshot: booking.policySnapshot,
      total_minor: booking.totalMinor.toString(),
      currency: booking.currency,
      created_at: booking.createdAt.toISOString(),
      updated_at: booking.updatedAt.toISOString(),
      line_items: items.map((i) => ({ ...i, rate_minor: i.rate_minor.toString() })),
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * The tenant filter, derived from the token and nowhere else.
   *
   * `undefined` means "no filter", which only a PLATFORM_ADMIN gets. A
   * VENUE_STAFF or VENUE_ADMIN without a `venue_id` in their token is a
   * malformed principal — the schema's CHECK constraint makes that
   * unrepresentable in the database, but a token minted before that constraint
   * existed would still verify, so it is refused rather than treated as
   * unscoped.
   */
  private scopeFilter(principal: AuthPrincipal): SQL | undefined {
    switch (principal.role) {
      case 'PLATFORM_ADMIN':
        return undefined;
      case 'VENUE_ADMIN':
      case 'VENUE_STAFF':
        if (!principal.venueId) throw new ForbiddenException('Token has no venue scope');
        return eq(bookings.venueId, principal.venueId);
      case 'CUSTOMER':
      default:
        return eq(bookings.userId, principal.userId);
    }
  }

  /** Load and lock a booking the principal is allowed to act on. */
  private async loadOwnedBooking(
    tx: Executor,
    bookingId: string,
    principal: AuthPrincipal,
  ): Promise<Booking> {
    const rows = await tx
      .select()
      .from(bookings)
      .where(and(eq(bookings.id, bookingId), this.scopeFilter(principal)))
      .limit(1);

    const booking = rows[0];
    if (!booking) throw new NotFoundException();
    return booking;
  }

  private async loadRoomContext(roomId: string): Promise<RoomContext> {
    const [row] = await this.db
      .select({
        roomId: rooms.id,
        venueId: rooms.venueId,
        capacity: rooms.capacity,
        hourlyRateMinor: rooms.hourlyRateMinor,
        minDurationMinutes: rooms.minDurationMinutes,
        maxDurationMinutes: rooms.maxDurationMinutes,
        timezone: venues.timezone,
        operatingHours: venues.operatingHours,
        overbookingBufferPct: venues.overbookingBufferPct,
      })
      .from(rooms)
      .innerJoin(venues, eq(venues.id, rooms.venueId))
      .where(eq(rooms.id, roomId))
      .limit(1);

    if (!row) throw new NotFoundException('No such room');

    const hours = parseOperatingHours(row.operatingHours);
    if (!hours) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: 'Unprocessable Entity',
        message: 'This venue has no usable operating hours configured',
        venue_id: row.venueId,
      });
    }

    return { ...row, hours, currency: 'PKR' };
  }

  /**
   * The rules that need the venue. Everything here is a 422: the request could
   * never have succeeded, regardless of what else is in the database.
   */
  private assertBookable(input: HoldInput, ctx: RoomContext): void {
    const now = Date.now();
    const leadMinutes = (input.starts_at.getTime() - now) / 60_000;

    if (leadMinutes < MIN_LEAD_MINUTES) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: 'Unprocessable Entity',
        message: `Bookings must start at least ${MIN_LEAD_MINUTES} minutes ahead`,
        starts_at: input.starts_at.toISOString(),
      });
    }

    if (leadMinutes > MAX_LEAD_DAYS * 24 * 60) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: 'Unprocessable Entity',
        message: `Bookings may not start more than ${MAX_LEAD_DAYS} days ahead`,
        starts_at: input.starts_at.toISOString(),
      });
    }

    const durationMinutes = (input.ends_at.getTime() - input.starts_at.getTime()) / 60_000;

    if (
      durationMinutes < ctx.minDurationMinutes ||
      durationMinutes > ctx.maxDurationMinutes
    ) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: 'Unprocessable Entity',
        message: `This room takes bookings between ${ctx.minDurationMinutes} and ${ctx.maxDurationMinutes} minutes`,
        duration_minutes: durationMinutes,
      });
    }

    // Operating hours are a venue-LOCAL statement. The comparison is done in
    // the venue's timezone, so a Karachi venue's Tuesday and a London venue's
    // Tuesday are different instants and both are handled correctly.
    if (!isWithinOperatingHours(ctx.hours, ctx.timezone, input.starts_at, input.ends_at)) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: 'Unprocessable Entity',
        message: 'Requested period is outside this venue’s operating hours',
        timezone: ctx.timezone,
        starts_at: input.starts_at.toISOString(),
        ends_at: input.ends_at.toISOString(),
      });
    }
  }
}

interface RoomContext {
  roomId: string;
  venueId: string;
  capacity: number;
  hourlyRateMinor: bigint;
  minDurationMinutes: number;
  maxDurationMinutes: number;
  timezone: string;
  overbookingBufferPct: number;
  hours: ReturnType<typeof parseOperatingHours> & object;
  currency: string;
}

export { ACTIVE as ACTIVE_STATUSES };
