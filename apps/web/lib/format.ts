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

/**
 * The fields of an instant in a named zone, as a record.
 *
 * ## Why every formatter below assembles its own string
 *
 * `Intl.DateTimeFormat(...).format()` decides the punctuation, and the
 * punctuation is not stable across ICU versions. Node 26 renders `en-GB`
 * weekday-day-month as `Tue 25 Aug`; Chrome renders `Tue, 25 Aug`. Both are
 * correct for their ICU, and the difference is one comma.
 *
 * That comma cost the room screen its hydration. `groupByDay` runs inside a
 * client component, so the server rendered the label with Node's ICU, React
 * compared it to Chrome's on hydration, found different text, and threw away
 * and re-rendered the whole availability tree — silently in production, as
 * minified error #418. Found in P8 by reading the console in a browser; it had
 * been there since the screen was written.
 *
 * `formatToParts` returns the FIELDS rather than a rendered string, and the
 * fields are what ICU agrees on. Assembling them here means these functions
 * produce the same characters on both sides of the hydration boundary, on any
 * runtime, and it also means the format is ours to choose rather than a locale
 * database's to change under us.
 *
 * `hourCycle: 'h23'` and not `hour12: false`: the latter is ambiguous between
 * h23 and h24, so midnight renders as `00` on one runtime and `24` on another —
 * the same class of bug, one field over.
 */
function fieldsIn(
  iso: string,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): Record<string, string> {
  const parts = new Intl.DateTimeFormat('en-GB', { ...options, timeZone }).formatToParts(
    new Date(iso),
  );

  const fields: Record<string, string> = {};
  for (const part of parts) if (part.type !== 'literal') fields[part.type] = part.value;
  return fields;
}

/**
 * An instant, rendered in a named IANA zone.
 *
 * Venue-local, never browser-local, and never without saying which. A studio in
 * Karachi and a customer in London disagree about when "14:00" is, and an
 * operations tool that silently picks the reader's zone will have that argument
 * with somebody eventually.
 */
export function dateTimeIn(iso: string, timeZone: string): string {
  const f = fieldsIn(iso, timeZone, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  return `${f.day} ${f.month} ${f.year}, ${f.hour}:${f.minute}`;
}

export function timeIn(iso: string, timeZone: string): string {
  const f = fieldsIn(iso, timeZone, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  return `${f.hour}:${f.minute}`;
}

export function dayIn(iso: string, timeZone: string): string {
  const f = fieldsIn(iso, timeZone, {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
  });
  return `${f.weekday} ${f.day} ${f.month}`;
}

/**
 * A zone's offset at a given instant — `UTC+05:00`, `UTC+01:00`, `UTC`.
 *
 * At a given instant, because an offset is not a property of a zone: London is
 * UTC+00:00 in January and UTC+01:00 in July, and a label that ignored the date
 * would be wrong for half the year.
 *
 * ## Why the offset and not `PKT` / `BST`
 *
 * `timeZoneName: 'short'` is the obvious way to get an abbreviation and it is
 * ICU's opinion, which differs between runtimes — the same trap `fieldsIn`
 * exists for, and this string is rendered inside client components. An offset
 * computed from the parts is arithmetic rather than a lookup, so it is the same
 * everywhere. It is also less ambiguous: `PKT` means nothing to most readers,
 * and `CST` means three different things.
 *
 * The IANA name is shown beside it wherever this appears, so the pair names
 * both the zone and what it currently amounts to.
 */
export function zoneLabel(iso: string, timeZone: string): string {
  const at = new Date(iso);
  const f = fieldsIn(iso, timeZone, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });

  // The same wall clock read as if it were UTC. The difference between that and
  // the real instant IS the offset — no table, no abbreviation, no ICU opinion.
  const asUtc = Date.UTC(
    Number(f.year),
    Number(f.month) - 1,
    Number(f.day),
    Number(f.hour),
    Number(f.minute),
    Number(f.second),
  );

  // Seconds are dropped from the instant for the same reason they are dropped
  // from every other display: no zone in current use has a sub-minute offset,
  // and keeping them would make a rounding artefact look like one.
  const offsetMinutes = Math.round((asUtc - at.getTime()) / 60_000);
  if (offsetMinutes === 0) return 'UTC';

  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const hours = String(Math.floor(abs / 60)).padStart(2, '0');
  const minutes = String(abs % 60).padStart(2, '0');
  return `UTC${sign}${hours}:${minutes}`;
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
  return `${dateTimeIn(iso, 'UTC')} UTC`;
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
