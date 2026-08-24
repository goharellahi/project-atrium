import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { venues } from '../db/schema';
import { VenueScopedRepository } from '../repositories/venue-scoped.repository';
import { openWindowsBetween, parseOperatingHours } from '../common/time/operating-hours';
import type { RevenueReportQuery } from './reports.schemas';

/**
 * Revenue and utilisation for one venue over a date range.
 *
 * ## What counts as revenue, stated once
 *
 * `gross_minor` is the sum of `bookings.total_minor` over bookings in
 * CONFIRMED or COMPLETED. Those are the two states in which a customer has paid
 * and the venue is owed the money. CANCELLED, REFUNDED, EXPIRED and FAILED are
 * counted separately and contribute nothing, because a report that folds a
 * refunded booking into revenue is a report that disagrees with the
 * reconciliation endpoint — and INV-5 says only one of those can be right.
 *
 * `refunded_minor` is read from `payments.refunded_minor`, not from the booking,
 * for the same reason: the refund amount is whatever the provider actually
 * settled, which after a partial-tier cancellation is not the booking total.
 * `net_minor` is `gross - refunded` and can legitimately be less than the sum
 * of the confirmed bookings when a booking was partially refunded and then
 * re-confirmed, so it is reported rather than derived by the caller.
 *
 * ## Utilisation
 *
 * `booked_minutes / open_minutes`, where open minutes are the venue's operating
 * hours over the range multiplied by the number of rooms. Open minutes are
 * computed in TypeScript, not SQL, and deliberately: operating hours are a
 * jsonb blob of local wall-clock times in the venue's own timezone, and
 * expressing "how many minutes was this venue open between two UTC instants" in
 * SQL means reimplementing timezone arithmetic in Postgres next to the copy
 * that already exists in `common/time`. Two implementations of one rule is how
 * they drift. The cost is one extra pass over at most 366 days, in memory.
 *
 * Booked minutes use raw `starts_at`/`ends_at`, NOT `slot`. The 15-minute
 * turnaround is time the room is unavailable but nobody is paying for; billing
 * it as utilisation would inflate every venue's number by a fixed fiction.
 */
@Injectable()
export class ReportsService extends VenueScopedRepository {
  constructor(db: Db) {
    super(db);
  }

  async revenue(query: RevenueReportQuery) {
    // From the token. `venueFilter` would give a drizzle predicate; these are
    // raw aggregates, so the id itself is needed — but it comes from exactly
    // the same place, and a principal without one cannot reach this route.
    const principal = this.principal();
    const venueId = principal.venueId;
    if (venueId === null) this.notFound();

    const from = query.from.toISOString();
    const to = query.to.toISOString();

    const [venue] = await this.db
      .select({
        id: venues.id,
        name: venues.name,
        timezone: venues.timezone,
        operatingHours: venues.operatingHours,
      })
      .from(venues)
      .where(eq(venues.id, venueId))
      .limit(1);

    if (!venue) this.notFound();

    // Four independent aggregates over the same predicate, issued together.
    // Separate statements rather than one CTE because each is a plain aggregate
    // the planner can serve from the same index, and the pool runs them on four
    // connections concurrently — the wall clock is the slowest one's, not the
    // sum. A single CTE would serialise all four behind one backend.
    const [totalsRow, refundedMinor, byRoom, byDay] = await Promise.all([
      this.totals(venueId, from, to),
      this.refunded(venueId, from, to),
      this.byRoom(venueId, from, to),
      this.byDay(venueId, from, to, venue.timezone),
    ]);

    const { currency, ...totals } = totalsRow;
    const openMinutes = this.openMinutes(venue, query.from, query.to, byRoom.length);

    return {
      venue_id: venue.id,
      venue_name: venue.name,
      timezone: venue.timezone,
      // Currency lives on the booking, not the venue — a venue's rows all carry
      // its city's currency, but the schema does not say so, and inventing a
      // venue-level currency here would be this report asserting something the
      // database does not know. NULL when the range holds no bookings, which is
      // the honest answer to "what currency was nothing in".
      currency,
      from,
      to,
      summary: {
        ...totals,
        refunded_minor: refundedMinor,
        net_minor: (BigInt(totals.gross_minor) - BigInt(refundedMinor)).toString(),
        open_minutes: openMinutes,
        // Reported as null rather than 0 when the venue was never open in the
        // range. A denominator of zero is not 0% utilisation, it is a question
        // with no answer, and printing 0% would read as "nobody booked".
        utilisation_pct:
          openMinutes > 0
            ? Math.round((totals.booked_minutes / openMinutes) * 1000) / 10
            : null,
      },
      by_room: byRoom,
      by_day: byDay,
    };
  }

  /**
   * Counts, gross and booked minutes in one pass over `bookings`.
   *
   * Note what this does NOT do: join `payments`. The obvious version folds the
   * refund total in here with a LEFT JOIN and gets the wrong answer, because a
   * booking may own more than one payments row — a charge that failed and a
   * retry that succeeded are two — and the join then multiplies that booking's
   * `total_minor` and its duration by the number of rows. The counts would
   * still look right, since `count(DISTINCT b.id)` survives the fan-out, which
   * is what makes the bug quiet: the tallies agree with the database while the
   * money does not. Refunds are their own query for that reason alone.
   */
  private async totals(venueId: string, from: string, to: string) {
    const result = await this.db.execute<{
      bookings: number;
      confirmed: number;
      completed: number;
      cancelled: number;
      refunded: number;
      expired: number;
      failed: number;
      gross_minor: string;
      booked_minutes: number;
      currency: string | null;
    }>(sql`
      SELECT
        count(*)::int AS bookings,
        count(*) FILTER (WHERE b.status = 'CONFIRMED')::int AS confirmed,
        count(*) FILTER (WHERE b.status = 'COMPLETED')::int AS completed,
        count(*) FILTER (WHERE b.status = 'CANCELLED')::int AS cancelled,
        count(*) FILTER (WHERE b.status = 'REFUNDED')::int  AS refunded,
        count(*) FILTER (WHERE b.status = 'EXPIRED')::int   AS expired,
        count(*) FILTER (WHERE b.status = 'FAILED')::int    AS failed,
        coalesce(sum(b.total_minor) FILTER (
          WHERE b.status IN ('CONFIRMED','COMPLETED')), 0)::text AS gross_minor,
        coalesce(sum(
          EXTRACT(epoch FROM (b.ends_at - b.starts_at)) / 60
        ) FILTER (WHERE b.status IN ('CONFIRMED','COMPLETED')), 0)::int AS booked_minutes,
        min(b.currency)::text AS currency
      FROM bookings b
      WHERE b.venue_id = ${venueId}::uuid
        AND b.starts_at >= ${from}::timestamptz
        AND b.starts_at <  ${to}::timestamptz
    `);

    return result.rows[0]!;
  }

  /**
   * What the provider actually gave back, over the bookings in range.
   *
   * `payments.refunded_minor` and not `bookings.total_minor`: a cancellation
   * inside a partial-refund tier returns a fraction, and a report that assumed
   * the whole booking came back would disagree with `/admin/reconciliation`
   * about the same money. INV-5 permits exactly one of those to be right.
   */
  private async refunded(venueId: string, from: string, to: string): Promise<string> {
    const result = await this.db.execute<{ refunded_minor: string }>(sql`
      SELECT coalesce(sum(p.refunded_minor), 0)::text AS refunded_minor
        FROM payments p
        JOIN bookings b ON b.id = p.booking_id
       WHERE b.venue_id = ${venueId}::uuid
         AND b.starts_at >= ${from}::timestamptz
         AND b.starts_at <  ${to}::timestamptz
    `);
    return result.rows[0]?.refunded_minor ?? '0';
  }

  /** Per room, ordered by what it earned. Bounded by the venue's room count. */
  private async byRoom(venueId: string, from: string, to: string) {
    const result = await this.db.execute<{
      room_id: string;
      room_name: string;
      bookings: number;
      booked_minutes: number;
      gross_minor: string;
    }>(sql`
      SELECT
        b.room_id,
        r.name AS room_name,
        count(*)::int AS bookings,
        coalesce(sum(
          EXTRACT(epoch FROM (b.ends_at - b.starts_at)) / 60
        ) FILTER (WHERE b.status IN ('CONFIRMED','COMPLETED')), 0)::int AS booked_minutes,
        coalesce(sum(b.total_minor) FILTER (
          WHERE b.status IN ('CONFIRMED','COMPLETED')), 0)::text AS gross_minor
      FROM bookings b
      JOIN rooms r ON r.id = b.room_id
      WHERE b.venue_id = ${venueId}::uuid
        AND b.starts_at >= ${from}::timestamptz
        AND b.starts_at <  ${to}::timestamptz
      GROUP BY b.room_id, r.name
      ORDER BY 5 DESC, b.room_id
    `);
    return result.rows;
  }

  /**
   * Per venue-local calendar day.
   *
   * `AT TIME ZONE` on the way into `date_trunc` so a Karachi venue's midnight
   * is Karachi midnight. Bucketing on UTC days would put five hours of every
   * evening's takings on the following day's row, which is wrong in a way that
   * looks plausible.
   */
  private async byDay(venueId: string, from: string, to: string, timezone: string) {
    const result = await this.db.execute<{
      day: string;
      bookings: number;
      gross_minor: string;
    }>(sql`
      SELECT
        to_char(date_trunc('day', b.starts_at AT TIME ZONE ${timezone}), 'YYYY-MM-DD') AS day,
        count(*)::int AS bookings,
        coalesce(sum(b.total_minor) FILTER (
          WHERE b.status IN ('CONFIRMED','COMPLETED')), 0)::text AS gross_minor
      FROM bookings b
      WHERE b.venue_id = ${venueId}::uuid
        AND b.starts_at >= ${from}::timestamptz
        AND b.starts_at <  ${to}::timestamptz
      GROUP BY 1
      ORDER BY 1
    `);
    return result.rows;
  }

  /**
   * Open room-minutes over the range: the venue's open windows, clipped to the
   * requested interval, multiplied by the number of rooms that appear in the
   * report.
   *
   * Multiplied by the rooms that TRANSACTED, not by every room the venue owns.
   * That is a deliberate under-statement of the denominator and it is the
   * conservative direction: a venue that lists a room it never opens would
   * otherwise show a permanently depressed utilisation number, and a metric
   * that punishes listing inventory is a metric operators learn to game.
   */
  private openMinutes(
    venue: { timezone: string; operatingHours: unknown },
    from: Date,
    to: Date,
    roomCount: number,
  ): number {
    if (roomCount === 0) return 0;

    const hours = parseOperatingHours(venue.operatingHours);
    if (!hours) return 0;

    let minutes = 0;
    for (const window of openWindowsBetween(hours, venue.timezone, from, to)) {
      const opens = window.opensAt > from ? window.opensAt : from;
      const closes = window.closesAt < to ? window.closesAt : to;
      if (closes > opens) minutes += (closes.getTime() - opens.getTime()) / 60_000;
    }

    return Math.round(minutes) * roomCount;
  }
}
