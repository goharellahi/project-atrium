import { describe, expect, it } from 'vitest';
import { computeRefund, selectTier, TiersSchema, type Tier } from './refund-policy';

/**
 * The refund calculator, at every tier boundary.
 *
 * Boundaries are where a tier ladder actually goes wrong, and they are the part
 * an end-to-end test will never reach: driving a real cancellation at exactly
 * 48.0 hours before a booking means controlling the clock to the millisecond.
 * The calculator takes both timestamps as arguments precisely so this file can.
 *
 * The tiers below are the platform defaults seeded by migration 0003.
 */
const PLATFORM: Tier[] = [
  { min_hours_before: 48, room_refund_pct: 100, equipment_refund_pct: 100 },
  { min_hours_before: 24, room_refund_pct: 50, equipment_refund_pct: 100 },
  { min_hours_before: 2, room_refund_pct: 0, equipment_refund_pct: 100 },
  { min_hours_before: 0, room_refund_pct: 0, equipment_refund_pct: 0 },
];

const START = new Date('2026-09-01T12:00:00.000Z');

/** `hours` before START, to the millisecond. */
function at(hours: number): Date {
  return new Date(START.getTime() - Math.round(hours * 3_600_000));
}

function refund(hours: number, roomMinor = 100_000n, equipmentMinor = 20_000n) {
  return computeRefund({
    roomMinor,
    equipmentMinor,
    tiers: PLATFORM,
    startsAt: START,
    at: at(hours),
  });
}

describe('tier selection at every boundary', () => {
  // Each boundary is tested from both sides. A `>` where `>=` was meant moves
  // every one of these by one millisecond, and only the exact-boundary case
  // notices.
  const cases: { hours: number; expected: number; note: string }[] = [
    { hours: 1000, expected: 48, note: 'far out' },
    { hours: 48.001, expected: 48, note: 'just above 48h' },
    { hours: 48, expected: 48, note: 'exactly 48h — inclusive lower bound' },
    { hours: 47.999, expected: 24, note: 'just below 48h' },
    { hours: 24, expected: 24, note: 'exactly 24h' },
    { hours: 23.999, expected: 2, note: 'just below 24h' },
    { hours: 2, expected: 2, note: 'exactly 2h' },
    { hours: 1.999, expected: 0, note: 'just below 2h' },
    { hours: 0, expected: 0, note: 'at the start instant' },
    { hours: -5, expected: 0, note: 'after it started — clamped, not unmatched' },
  ];

  for (const c of cases) {
    it(`${c.note} (${c.hours}h) selects the ${c.expected}h tier`, () => {
      expect(refund(c.hours).tier.min_hours_before).toBe(c.expected);
    });
  }
});

describe('the brief\'s stated outcomes', () => {
  it('more than 48h out: room 100%, equipment 100%', () => {
    const r = refund(72);
    expect(r.room_refund_minor).toBe(100_000n);
    expect(r.equipment_refund_minor).toBe(20_000n);
    expect(r.total_refund_minor).toBe(120_000n);
  });

  it('24 to 48h out: room 50%, equipment 100%', () => {
    const r = refund(30);
    expect(r.room_refund_minor).toBe(50_000n);
    expect(r.equipment_refund_minor).toBe(20_000n);
  });

  it('under 24h but more than 2h: room 0%, equipment 100%', () => {
    const r = refund(12);
    expect(r.room_refund_minor).toBe(0n);
    expect(r.equipment_refund_minor).toBe(20_000n);
  });

  it('under 2h: nothing', () => {
    const r = refund(1);
    expect(r.total_refund_minor).toBe(0n);
  });
});

describe('arithmetic', () => {
  it('is exact on odd amounts — no float ever touches money', () => {
    // 50% of 4501 is 2250.5. A float path yields 2250.4999999999995 and then
    // whatever Math.round does with it; BigInt division gives 2250 every time.
    const r = computeRefund({
      roomMinor: 4_501n,
      equipmentMinor: 0n,
      tiers: PLATFORM,
      startsAt: START,
      at: at(30),
    });
    expect(r.room_refund_minor).toBe(2_250n);
  });

  it('never refunds more than was charged', () => {
    for (const hours of [1000, 48, 47, 24, 23, 2, 1, 0]) {
      const r = refund(hours, 100_000n, 20_000n);
      expect(r.total_refund_minor <= 120_000n).toBe(true);
    }
  });

  it('handles a booking with no equipment', () => {
    const r = refund(72, 100_000n, 0n);
    expect(r.total_refund_minor).toBe(100_000n);
  });
});

describe('policy validation', () => {
  it('accepts the platform default', () => {
    expect(() => TiersSchema.parse(PLATFORM)).not.toThrow();
  });

  it('refuses a ladder that does not reach zero', () => {
    // The failure this prevents: a lookup at 1h before start matching no tier
    // at all, at which point refunding nothing and refunding everything are
    // both defensible and both wrong to choose silently.
    const partial = PLATFORM.slice(0, 3);
    expect(() => TiersSchema.parse(partial)).toThrow();
  });

  it('refuses tiers that are not strictly descending', () => {
    const scrambled = [PLATFORM[1]!, PLATFORM[0]!, PLATFORM[2]!, PLATFORM[3]!];
    expect(() => TiersSchema.parse(scrambled)).toThrow();
  });

  it('refuses a percentage outside 0-100', () => {
    expect(() =>
      TiersSchema.parse([
        { min_hours_before: 0, room_refund_pct: 120, equipment_refund_pct: 0 },
      ]),
    ).toThrow();
  });

  it('selectTier throws rather than guessing on a ladder that bypassed validation', () => {
    expect(() => selectTier([{ min_hours_before: 48, room_refund_pct: 100, equipment_refund_pct: 100 }], 1)).toThrow();
  });
});
