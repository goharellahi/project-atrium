import { z } from 'zod';
import {
  WEEKDAY_KEYS,
  addMinutes,
  fromLocalParts,
  parseClock,
  toLocalParts,
  type WeekdayKey,
} from './zoned-time';

/**
 * A venue's opening hours, as stored in `venues.operating_hours`.
 *
 * `null` for a day means closed. Times are local wall clock in the venue's own
 * timezone, which is the only reading that makes sense: a venue does not open
 * at 04:00 UTC, it opens at 09:00 in the city it is in.
 */
export const DayHoursSchema = z
  .object({ open: z.string(), close: z.string() })
  .nullable();

export const OperatingHoursSchema = z.object({
  sun: DayHoursSchema,
  mon: DayHoursSchema,
  tue: DayHoursSchema,
  wed: DayHoursSchema,
  thu: DayHoursSchema,
  fri: DayHoursSchema,
  sat: DayHoursSchema,
});

export type OperatingHours = z.infer<typeof OperatingHoursSchema>;

export interface OpenWindow {
  /** Absolute instant the venue opens. */
  opensAt: Date;
  /** Absolute instant the venue closes. */
  closesAt: Date;
}

/**
 * Parse the jsonb blob into something the rest of the code can trust.
 *
 * Returns `null` rather than throwing: a venue with a malformed hours blob is a
 * data problem, and the caller decides whether that is a 422 to the customer or
 * a 500 to the operator. Silently defaulting to "open all hours" would let a
 * data error become a booking outside operating hours, which is a correctness
 * failure disguised as leniency.
 */
export function parseOperatingHours(raw: unknown): OperatingHours | null {
  const parsed = OperatingHoursSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * The open window covering the venue-local calendar day that `dayAnchor` falls
 * on, or `null` if the venue is closed that day.
 *
 * A close time at or before the open time is read as crossing midnight, so a
 * venue open 18:00-02:00 yields a window ending on the following calendar day.
 * `24:00` is accepted for a close at end of day.
 */
export function windowForLocalDay(
  hours: OperatingHours,
  timeZone: string,
  dayAnchor: Date,
): OpenWindow | null {
  const local = toLocalParts(dayAnchor, timeZone);
  return windowForLocalDate(hours, timeZone, local.year, local.month, local.day, local.weekday);
}

export function windowForLocalDate(
  hours: OperatingHours,
  timeZone: string,
  year: number,
  month: number,
  day: number,
  weekday: WeekdayKey,
): OpenWindow | null {
  const spec = hours[weekday];
  if (!spec) return null;

  const openMinutes = parseClock(spec.open);
  const closeMinutes = parseClock(spec.close);
  if (openMinutes === null || closeMinutes === null) return null;

  const opensAt = fromLocalParts(
    year,
    month,
    day,
    Math.floor(openMinutes / 60),
    openMinutes % 60,
    timeZone,
  );

  // A close at or before the open is an overnight venue, not a data error.
  // Compute it as an offset from local midnight of the NEXT day rather than by
  // adding 24 hours to the open instant, so a DST shift inside the window does
  // not move the closing wall-clock time.
  const crossesMidnight = closeMinutes <= openMinutes;
  const closeAnchor = crossesMidnight
    ? nextLocalDay(timeZone, year, month, day)
    : { year, month, day };

  const closesAt = fromLocalParts(
    closeAnchor.year,
    closeAnchor.month,
    closeAnchor.day,
    Math.floor(closeMinutes / 60) % 24,
    closeMinutes % 60,
    timeZone,
  );

  // close === '24:00' on a non-overnight day lands on hour 0 of the same day,
  // which is before the open. Push it to the next local midnight.
  if (!crossesMidnight && closesAt <= opensAt) {
    const next = nextLocalDay(timeZone, year, month, day);
    return {
      opensAt,
      closesAt: fromLocalParts(next.year, next.month, next.day, 0, 0, timeZone),
    };
  }

  return { opensAt, closesAt };
}

function nextLocalDay(
  timeZone: string,
  year: number,
  month: number,
  day: number,
): { year: number; month: number; day: number } {
  // Step from local noon, which is far enough from either midnight that no DST
  // shift can push it onto the wrong calendar day.
  const noon = fromLocalParts(year, month, day, 12, 0, timeZone);
  const p = toLocalParts(addMinutes(noon, 24 * 60), timeZone);
  return { year: p.year, month: p.month, day: p.day };
}

/**
 * Is `[startsAt, endsAt)` entirely inside one of the venue's open windows?
 *
 * Both the window the booking starts in and the previous day's window are
 * checked, because an overnight window opened yesterday can still be open now.
 */
export function isWithinOperatingHours(
  hours: OperatingHours,
  timeZone: string,
  startsAt: Date,
  endsAt: Date,
): boolean {
  const candidates = [
    windowForLocalDay(hours, timeZone, startsAt),
    windowForLocalDay(hours, timeZone, addMinutes(startsAt, -24 * 60)),
  ];

  return candidates.some(
    (w) => w !== null && startsAt >= w.opensAt && endsAt <= w.closesAt,
  );
}

/** Every open window overlapping `[from, to)`, in order. */
export function openWindowsBetween(
  hours: OperatingHours,
  timeZone: string,
  from: Date,
  to: Date,
): OpenWindow[] {
  const windows: OpenWindow[] = [];

  // Walk the venue's LOCAL calendar, not absolute 24-hour steps. Stepping by
  // 24h of wall time skips a local day across a fall-back DST transition and
  // repeats one across spring-forward; stepping the calendar cannot.
  //
  // Start a day early so an overnight window that opened before `from` is
  // included, and stop a day late for the mirror case.
  let cursor = toLocalParts(addMinutes(from, -24 * 60), timeZone);
  const stopAt = toLocalParts(addMinutes(to, 24 * 60), timeZone);
  const stopKey = stopAt.year * 10_000 + stopAt.month * 100 + stopAt.day;

  for (let guard = 0; guard < 800; guard += 1) {
    const key = cursor.year * 10_000 + cursor.month * 100 + cursor.day;
    if (key > stopKey) break;

    const w = windowForLocalDate(
      hours,
      timeZone,
      cursor.year,
      cursor.month,
      cursor.day,
      cursor.weekday,
    );
    if (w && w.closesAt > from && w.opensAt < to) windows.push(w);

    const next = nextLocalDay(timeZone, cursor.year, cursor.month, cursor.day);
    cursor = toLocalParts(
      fromLocalParts(next.year, next.month, next.day, 12, 0, timeZone),
      timeZone,
    );
  }

  windows.sort((a, b) => a.opensAt.getTime() - b.opensAt.getTime());
  return windows;
}

export { WEEKDAY_KEYS };
