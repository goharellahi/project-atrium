import { makeRng } from './rng.js';
import type { PaygateConfig } from './config.js';

/**
 * The six chaos behaviours of brief §06, and nothing else.
 *
 * Rates are constants, not env vars, on purpose: both candidates are graded
 * against the same specified provider, so a tunable rate is drift, not a
 * feature. Determinism comes from PAYGATE_SEED, and forcing a specific
 * scenario is what the /paygate/_test/* control surface is for.
 */
export const RATES = {
  /** 30% of webhooks are delivered twice, new X-Paygate-Delivery each time. */
  duplicateDelivery: 0.3,
  /** 25% — the webhook fires before the 202 reaches the caller. */
  raceOnResponse: 0.25,
  /** 10% of POST /charges return 500. */
  transientFailure: 0.1,
  /** 5% — delivery arrives 60–90s late, comfortably outside the hold TTL. */
  delayedDelivery: 0.05,
  /** 2% of deliveries carry an invalid signature. */
  badSignature: 0.02,
} as const;

/** Delay bounds, milliseconds. */
export const DELAYS = {
  /** Normal asynchronous delivery: a short, randomised gap. */
  normalMin: 20,
  normalMax: 400,
  /** The 5% late branch. */
  lateMin: 60_000,
  lateMax: 90_000,
  /** Gap before the duplicate of an already-sent delivery. */
  duplicateMin: 30,
  duplicateMax: 900,
} as const;

/** Backdating window for the out-of-order behaviour. */
export const CLOCK_SKEW = { probability: 0.35, minSeconds: 1, maxSeconds: 30 } as const;

export type TimingBranch = 'race_on_response' | 'delayed' | 'normal';

export interface ChaosPlan {
  /** Whether chaos was on when this plan was made. */
  enabled: boolean;
  /** POST /charges returns 500 on the first attempt with this key. */
  transientFailure: boolean;
  /**
   * Exactly one timing branch. The brief's 25% race and 5% delay are mutually
   * exclusive by construction — a delivery cannot both precede the 202 and
   * arrive 60 seconds late — so they are drawn from a single uniform rather
   * than as independent coins. That preserves the specified rates exactly;
   * independent draws would have given 25% x 95% = 23.75% races.
   */
  timing: TimingBranch;
  /** A second delivery of the same event, with a fresh delivery id. */
  duplicateDelivery: boolean;
  /** Milliseconds before the first delivery attempt. */
  firstDelayMs: number;
  /** Milliseconds after the first attempt before the duplicate. */
  duplicateGapMs: number;
  /**
   * Seconds to backdate `occurred_at`.
   *
   * This is the out-of-order behaviour. Randomised delivery delays alone
   * already make arrival order independent of `occurred_at` order across
   * charges; backdating guarantees inversions even when two charges happen to
   * be delivered in the order they were created. Either way the receiver is
   * forced to treat `occurred_at` as untrustworthy, which is the point.
   */
  clockSkewSeconds: number;
}

const NO_CHAOS: ChaosPlan = {
  enabled: false,
  transientFailure: false,
  timing: 'normal',
  duplicateDelivery: false,
  firstDelayMs: 0,
  duplicateGapMs: 0,
  clockSkewSeconds: 0,
};

/**
 * The chaos plan for one charge or refund, keyed on its Idempotency-Key.
 *
 * Pure in (seed, key). A retry after a 500 therefore re-derives the same plan,
 * and a whole 200-request run replays identically.
 */
export function planFor(idempotencyKey: string, cfg: PaygateConfig): ChaosPlan {
  if (!cfg.chaos) return NO_CHAOS;

  const r = makeRng(cfg.seed, idempotencyKey, 'plan');

  const transientFailure = r.bool(RATES.transientFailure);

  const u = r.next();
  const timing: TimingBranch =
    u < RATES.raceOnResponse
      ? 'race_on_response'
      : u < RATES.raceOnResponse + RATES.delayedDelivery
        ? 'delayed'
        : 'normal';

  const duplicateDelivery = r.bool(RATES.duplicateDelivery);

  const firstDelayMs =
    timing === 'race_on_response'
      ? 0
      : timing === 'delayed'
        ? r.int(DELAYS.lateMin, DELAYS.lateMax)
        : r.int(DELAYS.normalMin, DELAYS.normalMax);

  const duplicateGapMs = r.int(DELAYS.duplicateMin, DELAYS.duplicateMax);

  const clockSkewSeconds = r.bool(CLOCK_SKEW.probability)
    ? r.int(CLOCK_SKEW.minSeconds, CLOCK_SKEW.maxSeconds)
    : 0;

  return {
    enabled: true,
    transientFailure,
    timing,
    duplicateDelivery,
    firstDelayMs,
    duplicateGapMs,
    clockSkewSeconds,
  };
}

/**
 * Whether a given delivery attempt carries a deliberately invalid signature.
 *
 * Drawn per attempt, not per charge: the brief says 2% of *deliveries*, so the
 * duplicate of a correctly-signed delivery can still be corrupt, and vice
 * versa. Seeded on the attempt ordinal so it too replays.
 */
export function corruptSignatureFor(
  idempotencyKey: string,
  attempt: number,
  cfg: PaygateConfig,
): boolean {
  if (!cfg.chaos) return false;
  return makeRng(cfg.seed, idempotencyKey, `signature:${attempt}`).bool(RATES.badSignature);
}
