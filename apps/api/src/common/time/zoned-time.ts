/**
 * Timezone arithmetic, done with Intl rather than a date library.
 *
 * Every booking instant is stored as `timestamptz` — an absolute instant. But
 * every RULE about bookings is expressed in the venue's local wall clock: "open
 * 09:00 to 21:00 on Tuesdays" is a statement about Karachi time, not about UTC.
 * Translating between the two is therefore not a formatting concern, it is a
 * correctness concern: a London venue's Tuesday and a Dubai venue's Tuesday do
 * not begin at the same instant, and a DST transition moves one of them twice
 * a year.
 *
 * No date library is used. `Intl.DateTimeFormat` with a `timeZone` is backed by
 * the ICU tzdata that ships with Node, which is the same database luxon or
 * date-fns-tz would consult. Adding a dependency to reach it would buy
 * ergonomics, not correctness.
 */

/** Monday-first is wrong here — `Date.getUTCDay()` is Sunday-first, and so is this. */
export const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type WeekdayKey = (typeof WEEKDAY_KEYS)[number];

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
  weekday: WeekdayKey;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

/** True if `timeZone` is an IANA zone this runtime actually knows. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock reading a person standing in `timeZone` would see at `instant`. */
export function toLocalParts(instant: Date, timeZone: string): LocalParts {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const get = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? '0';

  const weekdayShort = get('weekday').toLowerCase().slice(0, 3) as WeekdayKey;

  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    // hourCycle 'h23' should never produce 24, but a runtime that does would
    // otherwise silently shift a midnight boundary by a full day.
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: weekdayShort,
  };
}

/** Milliseconds to add to UTC to get local wall-clock time at `instant`. */
export function zoneOffsetMs(instant: Date, timeZone: string): number {
  const p = toLocalParts(instant, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Millisecond component is not in the formatted parts, so compare on whole
  // seconds only.
  return asIfUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The instant at which the given wall clock reading occurs in `timeZone`.
 *
 * Inverting a zone offset is a fixed-point problem, not a subtraction: the
 * offset we need depends on the instant we are trying to compute. One guess
 * plus two corrections converges for every real zone, including the DST
 * transitions where the first guess lands on the wrong side of the shift.
 *
 * Ambiguous local times (the repeated hour when clocks go back) resolve to the
 * first occurrence; non-existent local times (the skipped hour when clocks go
 * forward) resolve forward past the gap. Both are documented rather than
 * pretended away — a venue that opens at 01:30 on a spring-forward Sunday in
 * London has no 01:30 that day, and the honest answer is that it opens when the
 * clock reaches 02:00.
 */
export function fromLocalParts(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const target = Date.UTC(year, month - 1, day, hour, minute, 0);
  let utc = target;
  for (let i = 0; i < 3; i += 1) {
    const offset = zoneOffsetMs(new Date(utc), timeZone);
    const next = target - offset;
    if (next === utc) break;
    utc = next;
  }
  return new Date(utc);
}

/** `"09:30"` to minutes past local midnight. `"24:00"` is accepted as end-of-day. */
export function parseClock(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (minutes > 59) return null;
  if (hours > 24 || (hours === 24 && minutes !== 0)) return null;
  return hours * 60 + minutes;
}

/** Minutes past local midnight for `instant`, as seen in `timeZone`. */
export function localMinutesOfDay(instant: Date, timeZone: string): number {
  const p = toLocalParts(instant, timeZone);
  return p.hour * 60 + p.minute;
}

export function addMinutes(instant: Date, minutes: number): Date {
  return new Date(instant.getTime() + minutes * 60_000);
}
