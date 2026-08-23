/**
 * A seeded, deterministic PRNG.
 *
 * Why not `Math.random()`: a chaotic test double whose branches cannot be
 * reproduced is a coin flip, not a test double. When a 200-request run turns up
 * one bad booking, the only way to debug it is to replay the exact same chaos.
 *
 * Why the stream is derived per-decision rather than drawn from one global
 * sequence: Paygate serves concurrent requests, so a single shared stream would
 * hand out different numbers depending on how the event loop interleaved
 * requests. Instead every decision seeds its own stream from
 * `${PAYGATE_SEED}|${idempotency-key}|${label}`. The branch a charge takes is
 * therefore a pure function of (seed, key), independent of arrival order,
 * concurrency, or how many other charges are in flight.
 */

/** xmur3 — string to a well-mixed 32-bit seed. */
function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

/** mulberry32 — small, fast, good enough for chaos selection. */
function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max], inclusive. */
  int(min: number, max: number): number;
  /** True with probability p. */
  bool(p: number): boolean;
}

export function makeRng(...parts: string[]): Rng {
  const next = mulberry32(xmur3(parts.join('|'))());
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    bool: (p) => next() < p,
  };
}
