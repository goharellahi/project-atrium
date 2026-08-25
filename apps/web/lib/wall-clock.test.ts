import { describe, expect, it } from 'vitest';
import { halfHourGrid, instantToWallClock, wallClockToInstant } from './wall-clock';

/**
 * The offset bug, pinned.
 *
 * This suite is the answer to "show me you tested it rather than assuming".
 * It is run once per zone by `pnpm --filter web test`, which sets `TZ` before
 * invoking vitest for each of the zones below — a whole-hour offset ahead of
 * UTC, a half-hour offset, UTC itself, and a zone behind UTC that observes DST.
 * The assertions are on the exact instant produced, not on the shape of a
 * string, so a zone that shifts the answer fails loudly.
 *
 * `process.env.TZ` is read here only to name the expectation; the conversion
 * under test never looks at it.
 */
const TZ = process.env.TZ ?? 'UTC';

/** What each zone's offset means for 14:30 local on a fixed September day. */
const EXPECTED_SEPTEMBER: Record<string, string> = {
  UTC: '2026-09-01T14:30:00.000Z',
  'Asia/Karachi': '2026-09-01T09:30:00.000Z', // UTC+05:00
  'Asia/Kolkata': '2026-09-01T09:00:00.000Z', // UTC+05:30, the half-hour case
  'America/New_York': '2026-09-01T18:30:00.000Z', // UTC-04:00 in September (EDT)
  'Europe/London': '2026-09-01T13:30:00.000Z', // UTC+01:00 in September (BST)
};

describe(`wall clock ↔ instant (TZ=${TZ})`, () => {
  it('converts a typed local clock to the instant it actually names', () => {
    const iso = wallClockToInstant({ date: '2026-09-01', time: '14:30' });

    expect(iso).toBe(EXPECTED_SEPTEMBER[TZ]);
  });

  /**
   * The round trip is the property that matters. The original defect was not a
   * wrong formula — it was a value that survived one direction and shifted on
   * the way back, so the window a shared link reopened was not the window it
   * was created with.
   */
  it('round trips without drifting', () => {
    for (const time of ['00:00', '09:30', '14:30', '23:30']) {
      for (const date of ['2026-01-15', '2026-06-15', '2026-09-01', '2026-12-31']) {
        const iso = wallClockToInstant({ date, time });
        expect(iso).not.toBeNull();

        const back = instantToWallClock(iso!);
        expect(back).toEqual({ date, time });
      }
    }
  });

  /**
   * A DST transition is where a naive implementation stops round tripping.
   * Europe/London springs forward on 2026-03-29 and back on 2026-10-25; the
   * dates either side must still survive the trip intact.
   */
  it('round trips across a DST boundary', () => {
    for (const date of ['2026-03-28', '2026-03-30', '2026-10-24', '2026-10-26']) {
      const iso = wallClockToInstant({ date, time: '12:00' });
      expect(instantToWallClock(iso!)).toEqual({ date, time: '12:00' });
    }
  });

  it('refuses a half-filled window rather than guessing', () => {
    expect(wallClockToInstant({ date: '2026-09-01' })).toBeNull();
    expect(wallClockToInstant({ time: '14:30' })).toBeNull();
    expect(wallClockToInstant({})).toBeNull();
    expect(wallClockToInstant({ date: 'not-a-date', time: '14:30' })).toBeNull();
  });

  it('offers exactly the API 30-minute grid', () => {
    const grid = halfHourGrid();

    expect(grid).toHaveLength(48);
    expect(grid[0]!.value).toBe('00:00');
    expect(grid.at(-1)!.value).toBe('23:30');
    // Every option lands on the grid the hold endpoint enforces.
    expect(grid.every((o) => /^\d{2}:(00|30)$/.test(o.value))).toBe(true);
  });
});
