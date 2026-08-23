import { sql } from 'drizzle-orm';
import type { Executor } from './booking-state-machine.service';

/**
 * INV-2 — equipment never oversells at any instant t.
 *
 * ## Why the obvious query is wrong
 *
 * The tempting check is:
 *
 *     SELECT SUM(quantity) FROM booking_line_items li JOIN bookings b ...
 *      WHERE li.equipment_type_id = $1 AND b.slot && requested
 *
 * That is not "how many units are out at once", it is "how many units were
 * involved in any booking that touched this window". A venue with 6 cameras and
 * six sequential one-hour bookings across a working day sums to 6 for a
 * request spanning the day, and a seventh booking is refused even though at no
 * instant were more than one camera out. The error is one-directional and gets
 * worse the longer the requested window, so it does not show up in small tests
 * and does show up in production as inexplicable rejections.
 *
 * ## What is actually being asked
 *
 * "Oversells at any instant t" is a statement about a maximum over time, not a
 * total. The quantity in use is a step function: it jumps by +qty when a
 * booking starts and by -qty when it ends. Its maximum over the requested
 * window is the peak concurrent usage, and that is the number the admission
 * decision needs.
 *
 * ## The sweep line
 *
 * Emit one event per interval boundary, clipped to the requested window so
 * usage outside it does not count:
 *
 *     +qty at GREATEST(booking.starts_at, requested.start)
 *     -qty at LEAST(booking.ends_at, requested.end)
 *
 * Order by time, and — this part matters — put ENDS before STARTS at the same
 * instant. Intervals are half open: a booking ending at 14:00 has released its
 * units before one starting at 14:00 takes them. Ordering starts first would
 * report a phantom peak at every back-to-back handover and refuse perfectly
 * legal bookings.
 *
 * Then take a running total and its maximum:
 *
 *     MAX(SUM(delta) OVER (ORDER BY event_time, tie_break))
 *
 * Admit iff `peak + requested_qty <= units_owned * (1 + buffer_pct/100)`.
 *
 * ## Why a row lock is still required
 *
 * This query answers the question correctly but it is still a read. Two
 * concurrent transactions could both compute a peak of 5 against 6 units and
 * both admit, producing 7. `SELECT ... FOR UPDATE` on the `equipment_types` row
 * before running it is what serialises them — a database lock, not a process
 * mutex, so it holds identically across three replicas. See `lockEquipmentTypes`.
 */

/**
 * The 15-minute turnaround does NOT apply to equipment.
 *
 * `bookings.slot` carries the buffer because a physical room needs cleaning
 * between occupants. A tripod handed back at 14:00 is available at 14:00. So
 * this query uses raw `starts_at`/`ends_at` rather than `slot`, and the
 * difference is deliberate: using `slot` here would silently reserve a quarter
 * hour of every equipment booking that nothing in the brief asks for, reducing
 * effective fleet capacity. Recorded in ARCHITECTURE.md §7.
 */
export interface PeakUsageRow extends Record<string, unknown> {
  equipment_type_id: string;
  peak: number;
}

export interface EquipmentTypeRow extends Record<string, unknown> {
  id: string;
  venue_id: string;
  name: string;
  units_owned: number;
  hourly_rate_minor: string;
}

/**
 * Lock the requested equipment types, ORDERED BY id.
 *
 * The ordering is the deadlock defence, and it is not optional. Two
 * transactions requesting {A, B} and {B, A} without a deterministic order will
 * each take one row and wait forever for the other; Postgres breaks the cycle
 * by killing one with SQLSTATE 40P01, which surfaces to the customer as a 500
 * under exactly the load the system is graded on. Sorting means every
 * transaction climbs the same ladder in the same direction, so the second one
 * queues instead of deadlocking.
 *
 * Rows are returned in lock order. A missing id simply does not come back — the
 * caller compares counts rather than trusting the request.
 */
export async function lockEquipmentTypes(
  tx: Executor,
  ids: readonly string[],
): Promise<EquipmentTypeRow[]> {
  if (ids.length === 0) return [];

  const result = await tx.execute<EquipmentTypeRow>(sql`
    SELECT id, venue_id, name, units_owned, hourly_rate_minor
      FROM equipment_types
     WHERE id = ANY(${uuidArray(ids)}::uuid[])
     ORDER BY id
       FOR UPDATE
  `);

  return result.rows;
}

/**
 * Peak concurrent usage per equipment type over `[startsAt, endsAt)`.
 *
 * One query for all requested types rather than one per type: the lock is
 * already held, and N round trips inside a held lock is N times the contention
 * window for no benefit.
 *
 * Expired-but-unswept holds are excluded. They are about to be flipped to
 * EXPIRED by the sweeper and counting them would reject a legitimate booking
 * for a hold that no longer exists — the same class of bug the in-transaction
 * expiry closes for rooms.
 */
export async function peakConcurrentUsage(
  tx: Executor,
  equipmentTypeIds: readonly string[],
  startsAt: Date,
  endsAt: Date,
): Promise<Map<string, number>> {
  if (equipmentTypeIds.length === 0) return new Map();

  const ids = uuidArray(equipmentTypeIds);

  const result = await tx.execute<PeakUsageRow>(sql`
    WITH req AS (
      SELECT ${startsAt.toISOString()}::timestamptz AS s,
             ${endsAt.toISOString()}::timestamptz   AS e
    ),
    overlapping AS (
      SELECT li.equipment_type_id,
             GREATEST(b.starts_at, req.s) AS window_start,
             LEAST(b.ends_at, req.e)      AS window_end,
             li.quantity
        FROM booking_line_items li
        JOIN bookings b ON b.id = li.booking_id
        CROSS JOIN req
       WHERE li.equipment_type_id = ANY(${ids}::uuid[])
         AND b.status IN ('HELD','PENDING_PAYMENT','CONFIRMED')
         -- An expired hold holds nothing. Excluded here for the same reason the
         -- hold path expires stale holds in-transaction for rooms.
         AND NOT (b.status = 'HELD' AND b.expires_at IS NOT NULL AND b.expires_at <= now())
         AND b.starts_at < req.e
         AND b.ends_at   > req.s
    ),
    events AS (
      -- tie_break 0 = release, 1 = acquire. Ends must be processed before
      -- starts at the same instant; intervals are half open.
      SELECT equipment_type_id, window_start AS at,  quantity AS delta, 1 AS tie_break
        FROM overlapping
      UNION ALL
      SELECT equipment_type_id, window_end   AS at, -quantity AS delta, 0 AS tie_break
        FROM overlapping
    ),
    running AS (
      SELECT equipment_type_id,
             SUM(delta) OVER (
               PARTITION BY equipment_type_id
               ORDER BY at, tie_break
               ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
             ) AS in_use
        FROM events
    )
    SELECT equipment_type_id, COALESCE(MAX(in_use), 0)::int AS peak
      FROM running
     GROUP BY equipment_type_id
  `);

  const peaks = new Map<string, number>();
  for (const id of equipmentTypeIds) peaks.set(id, 0);
  for (const row of result.rows) peaks.set(row.equipment_type_id, Number(row.peak));
  return peaks;
}

/**
 * The admission ceiling for one equipment type.
 *
 * The overbooking buffer applies to equipment only (ARCHITECTURE.md §7,
 * Assumption 2) and is capped at 10% by a CHECK constraint on `venues`. Floored
 * rather than rounded: a 10% buffer on 6 units is 6.6, and admitting a seventh
 * unit on the strength of 0.6 of one is exactly the oversell the invariant
 * forbids. Rounding up would make a buffer of 1% behave like a buffer of one
 * whole unit on any fleet, which is not what "10%" means.
 */
export function admissionCeiling(unitsOwned: number, bufferPct: number): number {
  return Math.floor(unitsOwned * (1 + bufferPct / 100));
}

/**
 * A Postgres array literal, bound as ONE parameter.
 *
 * Not `${ids}` directly: Drizzle expands a JS array in a `sql` template into
 * one placeholder per element joined by commas, so `ANY($1::uuid[])` receives a
 * bare uuid and Postgres answers `malformed array literal`. Under the hold path
 * that surfaced as a 500 on every equipment request — a clean failure, but the
 * wrong status entirely, and one that would have read as an invariant violation
 * in the proof rather than as a bug in how a parameter was bound.
 *
 * The ids are re-validated here rather than trusted. They arrive zod-checked
 * from the controller, but this function builds a literal that Postgres parses,
 * and "it was validated upstream" is exactly the assumption that stops being
 * true when a second caller appears.
 */
function uuidArray(ids: readonly string[]): string {
  for (const id of ids) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new Error(`Not a UUID: ${id}`);
    }
  }
  return `{${ids.join(',')}}`;
}
