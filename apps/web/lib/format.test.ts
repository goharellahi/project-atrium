import { describe, expect, it } from 'vitest';
import { dateTimeIn, dayIn, money, timeIn, utc, venueTime, zoneLabel } from './format';

/**
 * The time formatters, pinned character by character.
 *
 * ## Why this suite exists
 *
 * The room screen hydrated wrong for its whole life and nothing noticed,
 * because the failure is invisible in production: React discards the mismatched
 * subtree, re-renders it on the client, and reports minified error #418 to a
 * console nobody is reading. The cause was one comma —
 * `Intl.DateTimeFormat('en-GB').format()` renders a short weekday-day-month as
 * `Tue 25 Aug` on Node 26's ICU and `Tue, 25 Aug` on Chrome's, and
 * `groupByDay` runs inside a client component, so both rendered.
 *
 * These assertions are exact strings on purpose. A test that checked "contains
 * Aug" would have passed throughout. The point is that the OUTPUT IS OURS: it
 * is assembled from `formatToParts`, so an ICU upgrade on either side cannot
 * move a separator, and if somebody reverts to `.format()` this suite fails on
 * whichever runtime it disagrees with.
 *
 * Note the limit, stated rather than implied: this suite runs on ONE runtime,
 * so it cannot prove two runtimes agree. What it can do — and what the bug
 * needed — is prove the string is built from fields rather than handed over to
 * a locale database.
 */

// 25 Aug 2026, 06:00 UTC. Karachi is UTC+5 year-round; London is on BST in
// August, so the same instant is a different day part in each.
const INSTANT = '2026-08-25T06:00:00.000Z';

describe('venue-local formatting is assembled, not delegated', () => {
  it('renders a day label with our separators', () => {
    expect(dayIn(INSTANT, 'UTC')).toBe('Tue 25 Aug');
    expect(dayIn(INSTANT, 'Asia/Karachi')).toBe('Tue 25 Aug');
  });

  it('renders a time on a 23-hour clock, zero padded', () => {
    expect(timeIn(INSTANT, 'UTC')).toBe('06:00');
    expect(timeIn(INSTANT, 'Asia/Karachi')).toBe('11:00');
    expect(timeIn(INSTANT, 'Europe/London')).toBe('07:00');
  });

  it('renders midnight as 00 and not 24', () => {
    // `hour12: false` is ambiguous between h23 and h24 and produces `24:00` on
    // some runtimes. `hourCycle: 'h23'` is what makes this stable.
    expect(timeIn('2026-08-25T00:00:00.000Z', 'UTC')).toBe('00:00');
  });

  it('renders a full date and time', () => {
    expect(dateTimeIn(INSTANT, 'UTC')).toBe('25 Aug 2026, 06:00');
    expect(dateTimeIn(INSTANT, 'Asia/Karachi')).toBe('25 Aug 2026, 11:00');
  });

  it('labels every instant with the zone it is in', () => {
    expect(venueTime(INSTANT, 'Asia/Karachi')).toBe('25 Aug 2026, 11:00 UTC+05:00');
    expect(venueTime(INSTANT, 'UTC')).toBe('25 Aug 2026, 06:00 UTC');
  });

  it('utc() is the same format, said explicitly', () => {
    expect(utc(INSTANT)).toBe('25 Aug 2026, 06:00 UTC');
  });
});

describe('zoneLabel is arithmetic, not an abbreviation lookup', () => {
  it('names a whole-hour offset', () => {
    expect(zoneLabel(INSTANT, 'Asia/Karachi')).toBe('UTC+05:00');
    expect(zoneLabel(INSTANT, 'Asia/Dubai')).toBe('UTC+04:00');
  });

  it('names a half-hour offset', () => {
    // The case an offset expressed in whole hours would silently round away.
    expect(zoneLabel(INSTANT, 'Asia/Kolkata')).toBe('UTC+05:30');
  });

  it('names a negative offset', () => {
    expect(zoneLabel(INSTANT, 'America/New_York')).toBe('UTC-04:00');
  });

  it('follows daylight saving rather than describing the zone', () => {
    // The whole reason the label takes an instant: London is not one offset.
    expect(zoneLabel('2026-01-15T12:00:00.000Z', 'Europe/London')).toBe('UTC');
    expect(zoneLabel('2026-07-15T12:00:00.000Z', 'Europe/London')).toBe('UTC+01:00');
  });

  it('says UTC rather than UTC+00:00', () => {
    expect(zoneLabel(INSTANT, 'UTC')).toBe('UTC');
  });
});

describe('money never goes near a float', () => {
  it('groups and pads minor units held as a string', () => {
    expect(money('123456789', 'PKR')).toBe('PKR 1,234,567.89');
    expect(money('5', 'PKR')).toBe('PKR 0.05');
  });

  it('survives an amount past Number.MAX_SAFE_INTEGER', () => {
    // The reason totals are strings on the wire and BigInt here. Parsed as a
    // number, this comes back changed.
    expect(money('9007199254740993', 'PKR')).toBe('PKR 90,071,992,547,409.93');
  });
});
