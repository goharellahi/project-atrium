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

/**
 * The short name of a zone at a given instant — `PKT`, `GMT+5`, `UTC`.
 *
 * At a given instant, because a zone's abbreviation is not a property of the
 * zone: London is GMT in January and BST in July, and a label that ignored the
 * date would be wrong for half the year.
 */
export function zoneLabel(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    timeZoneName: 'short',
  }).formatToParts(new Date(iso));

  return parts.find((part) => part.type === 'timeZoneName')?.value ?? timeZone;
}

/**
 * THE time convention for this console: the venue's local wall clock, always
 * labelled with the zone it is in.
 *
 * ## Why one convention, and why this one
 *
 * P7 shipped two. The room page rendered slots in venue-local time — correctly,
 * because "Tuesday 14:00" is the unit a person picks in — and checkout rendered
 * the same slot in UTC, because the checkout screen had no timezone to hand.
 * So the console told a customer in Karachi that the 14:00 slot they had just
 * chosen was at 09:00, which is the most alarming thing a booking system can
 * say. Neither screen was wrong on its own terms; together they were.
 *
 * Venue-local wins over UTC because the booking is an event in a building. The
 * room opens at nine in the city it is in, not at 04:00Z, and a venue admin
 * reading a schedule is standing in that city. UTC is the right thing to store
 * and the wrong thing to show.
 *
 * The label is not optional. An unlabelled local time is how the two screens
 * disagreed in the first place — both of them looked plausible.
 *
 * `GET /bookings`, `GET /bookings/:id`, `GET /rooms/:id` and
 * `GET /rooms/:id/availability` all carry `timezone` for this reason. Where one
 * genuinely is not in scope, `utc()` below is the labelled fallback rather than
 * a silent guess at the reader's own zone.
 */
export function venueTime(iso: string, timeZone: string): string {
  return `${dateTimeIn(iso, timeZone)} ${zoneLabel(iso, timeZone)}`;
}

/**
 * UTC, spelled out. The fallback for the one case where no venue zone is in
 * scope — not a second convention, but the same rule (always say which zone)
 * applied when the answer is "we only know the instant".
 */
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
