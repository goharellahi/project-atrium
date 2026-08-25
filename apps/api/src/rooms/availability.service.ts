import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { bookings, rooms, venues } from '../db/schema';
import type { Env } from '../config/env';
import {
  openWindowsBetween,
  parseOperatingHours,
  type OperatingHours,
} from '../common/time/operating-hours';
import { addMinutes } from '../common/time/zoned-time';
import { MIN_LEAD_MINUTES, type AvailabilityQuery } from '../bookings/bookings.schemas';

interface BusyInterval {
  /** Start of the occupied period. */
  from: Date;
  /** End INCLUDING the turnaround buffer — the same interval the constraint sees. */
  to: Date;
}

export interface FreeSlot {
  starts_at: string;
  ends_at: string;
}

/**
 * Room availability.
 *
 * This endpoint is advisory and says so. It reports what was free at the moment
 * it ran; between the response and the customer's click, someone else may hold
 * the slot. That is not a defect to be engineered away — it is why the hold
 * path does not consult this code. Availability informs a UI; `no_room_overlap`
 * decides. Any design where a read like this one gates a write has a race in it
 * by construction.
 */
@Injectable()
export class AvailabilityService {
  constructor(
    private readonly db: Db,
    private readonly env: Env,
  ) {}

  async forRoom(roomId: string, query: AvailabilityQuery): Promise<{
    room_id: string;
    timezone: string;
    duration_minutes: number;
    granularity_minutes: number;
    turnaround_minutes: number;
    free_slots: FreeSlot[];
    busy: { from: string; to: string }[];
  }> {
    const [room] = await this.db
      .select({
        id: rooms.id,
        venueId: rooms.venueId,
        minDurationMinutes: rooms.minDurationMinutes,
        maxDurationMinutes: rooms.maxDurationMinutes,
        timezone: venues.timezone,
        operatingHours: venues.operatingHours,
      })
      .from(rooms)
      .innerJoin(venues, eq(venues.id, rooms.venueId))
      .where(eq(rooms.id, roomId))
      .limit(1);

    if (!room) throw new NotFoundException('No such room');

    const hours = parseOperatingHours(room.operatingHours);
    if (!hours) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: 'Unprocessable Entity',
        message: 'This venue has no usable operating hours configured',
        venue_id: room.venueId,
      });
    }

    const duration = query.duration_minutes ?? room.minDurationMinutes;

    if (duration > room.maxDurationMinutes) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: 'Unprocessable Entity',
        message: `This room takes bookings of at most ${room.maxDurationMinutes} minutes`,
      });
    }

    const busy = await this.busyIntervals(roomId, query.from, query.to);

    /**
     * Never enumerate a start time the hold path is going to refuse.
     *
     * Bookings need `MIN_LEAD_MINUTES` of lead time. This endpoint did not know
     * that, so a range beginning today listed every slot from the venue's
     * opening — including the ones that had already happened. The console
     * rendered them as buttons, and clicking the first one answered
     * "Bookings must start at least 60 minutes ahead", which reads as a bug in
     * the console rather than as the rule it is. Found in P8, in a browser, by
     * clicking the first slot of the day.
     *
     * This does not make the endpoint authoritative and it is not meant to. It
     * stays advisory: a slot listed here can still be gone by the time it is
     * clicked, and the hold path still decides. What it stops doing is advising
     * something that could never have worked — which is a different and worse
     * kind of wrong, because no amount of racing produces it.
     */
    const earliest = addMinutes(new Date(), MIN_LEAD_MINUTES);

    const freeSlots = this.enumerate(
      hours,
      room.timezone,
      query.from,
      query.to,
      duration,
      busy,
      earliest,
    );

    return {
      room_id: roomId,
      timezone: room.timezone,
      duration_minutes: duration,
      granularity_minutes: 30,
      turnaround_minutes: this.env.ROOM_TURNAROUND_MINUTES,
      free_slots: freeSlots,
      busy: busy.map((b) => ({ from: b.from.toISOString(), to: b.to.toISOString() })),
    };
  }

  /**
   * The occupied intervals for one room, read straight off `bookings.slot`.
   *
   * `slot` already carries the 15-minute turnaround, so the busy periods
   * returned here are exactly what `no_room_overlap` enforces. Recomputing the
   * buffer in TypeScript would create a second definition of the same rule that
   * could drift from the first — CLAUDE.md is explicit that the buffer is never
   * re-checked in application code, and reading the generated column rather than
   * `ends_at` is how this endpoint honours that.
   *
   * Expired-but-unswept holds are excluded, matching what the hold path will do
   * to them in-transaction, so availability does not advertise a slot as busy
   * that a hold would in fact accept.
   */
  private async busyIntervals(roomId: string, from: Date, to: Date): Promise<BusyInterval[]> {
    const result = await this.db.execute<{ lower: string; upper: string }>(sql`
      SELECT lower(slot) AS lower, upper(slot) AS upper
        FROM bookings
       WHERE room_id = ${roomId}::uuid
         AND status IN ('HELD','PENDING_PAYMENT','CONFIRMED')
         AND NOT (status = 'HELD' AND expires_at IS NOT NULL AND expires_at <= now())
         AND slot && tstzrange(${from.toISOString()}::timestamptz, ${to.toISOString()}::timestamptz, '[)')
       ORDER BY lower(slot)
    `);

    return result.rows.map((r) => ({ from: new Date(r.lower), to: new Date(r.upper) }));
  }

  /**
   * Enumerate bookable start times on the 30-minute grid.
   *
   * A candidate slot is offered iff:
   *   - it lies entirely inside one of the venue's open windows, and
   *   - the interval it would OCCUPY — the slot plus the turnaround — overlaps
   *     no busy interval.
   *
   * The second condition uses the occupied interval, not the requested one,
   * because that is what the constraint compares. Checking `[start, end)`
   * against busy periods would offer a 10:00 start after a booking that ends at
   * 10:00, which the constraint then rejects: the endpoint would be advertising
   * slots the hold path refuses.
   */
  private enumerate(
    hours: OperatingHours,
    timezone: string,
    from: Date,
    to: Date,
    durationMinutes: number,
    busy: BusyInterval[],
    earliest: Date,
  ): FreeSlot[] {
    const slots: FreeSlot[] = [];
    const turnaround = this.env.ROOM_TURNAROUND_MINUTES;

    for (const window of openWindowsBetween(hours, timezone, from, to)) {
      // Start on the first 30-minute boundary at or after both the window
      // opening and the requested `from`.
      const windowStart = window.opensAt > from ? window.opensAt : from;
      let cursor = ceilToGrid(windowStart, 30);

      while (true) {
        const slotEnd = addMinutes(cursor, durationMinutes);
        if (slotEnd > window.closesAt || slotEnd > to) break;

        // The interval the booking would actually occupy.
        const occupiedEnd = addMinutes(slotEnd, turnaround);

        const clashes = busy.some((b) => b.from < occupiedEnd && b.to > cursor);
        // `continue`, not `break`: the cursor still has to advance, and a
        // window whose early slots are too soon may have perfectly good ones
        // later the same day.
        if (!clashes && cursor >= earliest) {
          slots.push({
            starts_at: cursor.toISOString(),
            ends_at: slotEnd.toISOString(),
          });
        }

        cursor = addMinutes(cursor, 30);
        if (cursor >= window.closesAt) break;
      }
    }

    return slots;
  }

  /**
   * Which of `roomIds` have NO active booking overlapping the requested window.
   *
   * Used by cross-venue search. Expressed as a single NOT EXISTS rather than N
   * per-room queries, and it compares `slot` — the occupied interval — against
   * the requested interval extended by the turnaround, which is precisely the
   * predicate `no_room_overlap` would apply.
   */
  async freeRoomIds(roomIds: readonly string[], from: Date, to: Date): Promise<Set<string>> {
    if (roomIds.length === 0) return new Set();

    const busyRows = await this.db
      .selectDistinct({ roomId: bookings.roomId })
      .from(bookings)
      .where(
        and(
          inArray(bookings.roomId, [...roomIds]),
          inArray(bookings.status, ['HELD', 'PENDING_PAYMENT', 'CONFIRMED']),
          sql`NOT (${bookings.status} = 'HELD' AND ${bookings.expiresAt} IS NOT NULL AND ${bookings.expiresAt} <= now())`,
          sql`${bookings.slot} && tstzrange(
                ${from.toISOString()}::timestamptz,
                ${addMinutes(to, this.env.ROOM_TURNAROUND_MINUTES).toISOString()}::timestamptz,
                '[)')`,
        ),
      );

    const busy = new Set(busyRows.map((r) => r.roomId));
    return new Set(roomIds.filter((id) => !busy.has(id)));
  }
}

/** Round `instant` up to the next `step`-minute boundary, in UTC. */
function ceilToGrid(instant: Date, step: number): Date {
  const stepMs = step * 60_000;
  return new Date(Math.ceil(instant.getTime() / stepMs) * stepMs);
}
