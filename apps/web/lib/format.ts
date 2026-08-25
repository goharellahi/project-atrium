/**
 * Presentation helpers.
 *
 * Every one of these is pure and safe on both sides of the server/client line —
 * the checkout countdown and the bookings table format the same values the same
 * way, and a second implementation in a client component is how two screens
 * start disagreeing about what a booking costs.
 */

/**
 * Minor units to a readable amount.
 *
 * The input is a decimal string because that is what the API sends: totals are
 * `bigint` in Postgres and `JSON.stringify` throws on those, so the API projects
 * them to strings. Parsing one into a `number` here would reintroduce the float
 * the whole money path exists to avoid, so the split is done on the string with
 * BigInt and only the two halves are ever printed.
 */
export function money(minor: string | bigint, currency = 'PKR'): string {
  let value: bigint;
  try {
    value = typeof minor === 'bigint' ? minor : BigInt(minor);
  } catch {
    return `${currency} —`;
  }

  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const major = absolute / 100n;
  const cents = absolute % 100n;

  const grouped = major.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${currency} ${grouped}.${cents.toString().padStart(2, '0')}`;
}

/** The bare amount, for a table cell that already has a currency column. */
export function amount(minor: string | bigint): string {
  return money(minor, '').trim();
}

const DATE_TIME: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
};

/**
 * An instant, rendered in a named IANA zone.
 *
 * Venue-local, never browser-local, and never without saying which. A studio in
 * Karachi and a customer in London disagree about when "14:00" is, and an
 * operations tool that silently picks the reader's zone will have that argument
 * with somebody eventually.
 */
export function dateTimeIn(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { ...DATE_TIME, timeZone }).format(new Date(iso));
}

export function timeIn(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
  }).format(new Date(iso));
}

export function dayIn(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    timeZone,
  }).format(new Date(iso));
}

/** UTC, spelled out. Used wherever no venue zone is in scope. */
export function utc(iso: string): string {
  return `${new Intl.DateTimeFormat('en-GB', { ...DATE_TIME, timeZone: 'UTC' }).format(
    new Date(iso),
  )} UTC`;
}

/** `mm:ss`, zero padded so the width never changes as it counts down. */
export function clock(msRemaining: number): string {
  const total = Math.max(0, Math.floor(msRemaining / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

export function durationHours(startsAt: string, endsAt: string): string {
  const hours = (new Date(endsAt).getTime() - new Date(startsAt).getTime()) / 3_600_000;
  return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
}

/** The first segment of a UUID. Enough to recognise, short enough to scan. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}
