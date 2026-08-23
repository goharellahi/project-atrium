import { z } from 'zod';

/**
 * Paygate configuration.
 *
 * Everything Paygate does is a pure function of this object plus the request,
 * which is what makes a chaotic run replayable: same PAYGATE_SEED, same
 * Idempotency-Keys, same chaos decisions. See `chaos.ts`.
 */
const onOff = z.enum(['on', 'off']);

const EnvSchema = z.object({
  PAYGATE_PORT: z.coerce.number().int().positive().default(9000),

  /** HMAC key for X-Paygate-Signature. Shared with the API. */
  PAYGATE_SECRET: z.string().min(8),

  /** Master switch for all six chaos behaviours (brief §06). */
  PAYGATE_CHAOS: onOff.default('off'),

  /**
   * Seed for every chaos decision. Two runs with the same seed and the same
   * Idempotency-Keys take identical branches, in any arrival order.
   */
  PAYGATE_SEED: z.string().min(1).default('atrium'),

  /**
   * Where webhooks are POSTed.
   *
   * The brief calls this PAYGATE_CALLBACK_URL. This repository's
   * docker-compose.yml — owned by another phase, not editable from here —
   * sets PAYGATE_WEBHOOK_URL. Both are accepted; CALLBACK wins.
   */
  PAYGATE_CALLBACK_URL: z.url().optional(),
  PAYGATE_WEBHOOK_URL: z.url().optional(),

  /** The /paygate/_test/* control surface. Outside the brief's spec. */
  PAYGATE_TEST_ENDPOINTS: onOff.default('on'),

  /**
   * Deterministic decline trigger: a charge for exactly this amount always
   * resolves charge.failed. Paygate never declines at random — the brief's
   * chaos table does not include random declines, and a random decline in the
   * middle of a concurrency proof is indistinguishable from a real bug.
   */
  PAYGATE_DECLINE_AMOUNT_MINOR: z.coerce.number().int().nonnegative().default(666),

  /** Per-delivery HTTP timeout. */
  PAYGATE_DELIVERY_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

  LOG_LEVEL: z.string().default('info'),
});

export type PaygateConfig = {
  port: number;
  secret: string;
  chaos: boolean;
  seed: string;
  callbackUrl: string | null;
  testEndpoints: boolean;
  declineAmountMinor: number;
  deliveryTimeoutMs: number;
  logLevel: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PaygateConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid Paygate environment — ${detail}`);
  }
  const e = parsed.data;
  return {
    port: e.PAYGATE_PORT,
    secret: e.PAYGATE_SECRET,
    chaos: e.PAYGATE_CHAOS === 'on',
    seed: e.PAYGATE_SEED,
    callbackUrl: e.PAYGATE_CALLBACK_URL ?? e.PAYGATE_WEBHOOK_URL ?? null,
    testEndpoints: e.PAYGATE_TEST_ENDPOINTS === 'on',
    declineAmountMinor: e.PAYGATE_DECLINE_AMOUNT_MINOR,
    deliveryTimeoutMs: e.PAYGATE_DELIVERY_TIMEOUT_MS,
    logLevel: e.LOG_LEVEL,
  };
}
