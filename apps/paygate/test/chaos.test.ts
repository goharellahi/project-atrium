import { describe, expect, it } from 'vitest';
import { CLOCK_SKEW, DELAYS, RATES, corruptSignatureFor, planFor } from '../src/chaos.js';
import { makeRng } from '../src/rng.js';
import { testConfig } from './harness.js';

const KEYS = Array.from({ length: 20_000 }, (_, i) => `key-${i}`);

/** Tolerance for a 20k sample. Wide enough not to flake, tight enough to catch a wrong rate. */
const TOL = 0.01;

describe('chaos is seeded and replayable', () => {
  it('gives an identical plan for the same seed and key', () => {
    const cfg = testConfig({ chaos: true, seed: 'replay-me' });
    for (const key of KEYS.slice(0, 200)) {
      expect(planFor(key, cfg)).toEqual(planFor(key, cfg));
    }
  });

  it('gives different plans for different seeds', () => {
    const a = testConfig({ chaos: true, seed: 'seed-a' });
    const b = testConfig({ chaos: true, seed: 'seed-b' });
    const differing = KEYS.slice(0, 500).filter(
      (k) => JSON.stringify(planFor(k, a)) !== JSON.stringify(planFor(k, b)),
    );
    // Not all plans must differ — some keys land on the same branch by chance —
    // but the seed has to actually change the stream.
    expect(differing.length).toBeGreaterThan(300);
  });

  it('does nothing at all with chaos off', () => {
    const cfg = testConfig({ chaos: false });
    for (const key of KEYS.slice(0, 500)) {
      const plan = planFor(key, cfg);
      expect(plan).toEqual({
        enabled: false,
        transientFailure: false,
        timing: 'normal',
        duplicateDelivery: false,
        firstDelayMs: 0,
        duplicateGapMs: 0,
        clockSkewSeconds: 0,
      });
      expect(corruptSignatureFor(key, 1, cfg)).toBe(false);
    }
  });
});

describe('the six behaviours fire at the rates the brief specifies', () => {
  const cfg = testConfig({ chaos: true, seed: 'rates' });
  const plans = KEYS.map((k) => planFor(k, cfg));
  const share = (n: number): number => n / KEYS.length;

  it('10% of POST /charges return 500', () => {
    expect(share(plans.filter((p) => p.transientFailure).length)).toBeCloseTo(
      RATES.transientFailure,
      2,
    );
  });

  it('25% race the 202 response', () => {
    expect(share(plans.filter((p) => p.timing === 'race_on_response').length)).toBeCloseTo(
      RATES.raceOnResponse,
      2,
    );
  });

  it('5% arrive 60 to 90 seconds late', () => {
    const late = plans.filter((p) => p.timing === 'delayed');
    expect(share(late.length)).toBeCloseTo(RATES.delayedDelivery, 2);
    for (const p of late) {
      expect(p.firstDelayMs).toBeGreaterThanOrEqual(DELAYS.lateMin);
      expect(p.firstDelayMs).toBeLessThanOrEqual(DELAYS.lateMax);
    }
  });

  it('30% are delivered twice', () => {
    expect(share(plans.filter((p) => p.duplicateDelivery).length)).toBeCloseTo(
      RATES.duplicateDelivery,
      2,
    );
  });

  it('2% of deliveries carry an invalid signature, drawn per attempt', () => {
    const attempts = KEYS.flatMap((k) => [
      corruptSignatureFor(k, 1, cfg),
      corruptSignatureFor(k, 2, cfg),
    ]);
    const rate = attempts.filter(Boolean).length / attempts.length;
    expect(Math.abs(rate - RATES.badSignature)).toBeLessThan(TOL);

    // Per attempt, not per charge: the duplicate of a good delivery can be bad.
    const split = KEYS.filter((k) => corruptSignatureFor(k, 1, cfg) !== corruptSignatureFor(k, 2, cfg));
    expect(split.length).toBeGreaterThan(0);
  });

  it('backdates occurred_at often enough to force out-of-order arrivals', () => {
    const skewed = plans.filter((p) => p.clockSkewSeconds > 0);
    expect(share(skewed.length)).toBeCloseTo(CLOCK_SKEW.probability, 1);
    for (const p of skewed) {
      expect(p.clockSkewSeconds).toBeGreaterThanOrEqual(CLOCK_SKEW.minSeconds);
      expect(p.clockSkewSeconds).toBeLessThanOrEqual(CLOCK_SKEW.maxSeconds);
    }
  });

  it('never both races the response and arrives late', () => {
    // The two are drawn from one uniform precisely so this cannot happen.
    expect(plans.some((p) => p.timing === 'race_on_response' && p.firstDelayMs > 0)).toBe(false);
  });
});

describe('the rng', () => {
  it('is deterministic and uniform enough for branch selection', () => {
    expect(makeRng('a', 'b').next()).toBe(makeRng('a', 'b').next());
    expect(makeRng('a', 'b').next()).not.toBe(makeRng('a', 'c').next());

    const r = makeRng('uniformity');
    const draws = Array.from({ length: 50_000 }, () => r.next());
    const mean = draws.reduce((a, b) => a + b, 0) / draws.length;
    expect(mean).toBeGreaterThan(0.49);
    expect(mean).toBeLessThan(0.51);
    expect(Math.min(...draws)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...draws)).toBeLessThan(1);
  });

  it('respects inclusive integer bounds', () => {
    const r = makeRng('ints');
    const draws = Array.from({ length: 5_000 }, () => r.int(3, 7));
    expect(Math.min(...draws)).toBe(3);
    expect(Math.max(...draws)).toBe(7);
  });
});
