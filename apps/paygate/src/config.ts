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

  /**
   * The /paygate/_test/* control surface. Outside the brief's spec.
   *
   * Requested, not granted: production refuses it regardless. See `NODE_ENV`.
   */
  PAYGATE_TEST_ENDPOINTS: onOff.default('on'),

  /**
   * `production` hard-disables the /_test/* routes, even with
   * PAYGATE_TEST_ENDPOINTS=on.
   *
   * Not a security control — Paygate is a test double and holds no real money.
   * It is a legibility control: a reviewer reading a production route table
   * should never have to work out whether an unauthenticated endpoint that
   * forges signed webhooks is scaffolding or an oversight. In production it is
   * not there to ask about.
   */
  NODE_ENV: z.string().default('development'),

  /**
   * Deterministic decline trigger: a charge for exactly this amount always
   * resolves charge.failed. Paygate never declines at random — the brief's
   * chaos table does not include random declines, and a random decline in the
   * middle of a concurrency proof is indistinguishable from a real bug.
   */
  PAYGATE_DECLINE_AMOUNT_MINOR: z.coerce.number().int().nonnegative().default(666),

  /** Per-delivery HTTP timeout. */
  PAYGATE_DELIVERY_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

  /**
   * Where Paygate's ledger lives.
   *
   * `postgres` is the default and the design. `memory` exists for the unit
   * suites, which assert the idempotency contract and the chaos rates and buy
   * nothing from durability.
   *
   * The default used to be the only option, and that was the defect: Render's
   * free tier sleeps after fifteen idle minutes, so an in-memory provider forgets
   * every charge it ever captured and answers `404 unknown_charge` to the refund
   * that follows. INV-5 cannot be demonstrated against a provider with amnesia.
   * See `ledger/ledger.ts`.
   */
  PAYGATE_STORE: z.enum(['postgres', 'memory']).default('postgres'),

  /**
   * Paygate's own connection string.
   *
   * Named separately from the API's `DATABASE_URL` on purpose. The two services
   * share one Postgres instance because the free tier gives one, and that is a
   * hosting constraint rather than a design one — Paygate's tables are its own,
   * its migrations are its own, and pointing this at a different instance is the
   * whole of what separating them takes. A single shared variable would have
   * made that separation invisible and, in time, untrue.
   */
  PAYGATE_DATABASE_URL: z.string().min(1).optional(),

  LOG_LEVEL: z.string().default('info'),
});

export type PaygateConfig = {
  port: number;
  secret: string;
  chaos: boolean;
  seed: string;
  callbackUrl: string | null;
  /** True when NODE_ENV is exactly `production`. */
  production: boolean;
  /** What PAYGATE_TEST_ENDPOINTS asked for, before production overrode it. */
  testEndpointsRequested: boolean;
  /** The effective answer: requested AND not production. */
  testEndpoints: boolean;
  declineAmountMinor: number;
  deliveryTimeoutMs: number;
  store: 'postgres' | 'memory';
  /** Non-null whenever `store` is `postgres`; `loadConfig` refuses otherwise. */
  databaseUrl: string | null;
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

  /**
   * Refused, not defaulted.
   *
   * Falling back to memory when the URL is missing is how a deployment ends up
   * running the amnesiac provider without anybody choosing it — which is the
   * exact failure this configuration exists to prevent. Choosing memory has to
   * be a decision somebody typed.
   */
  if (e.PAYGATE_STORE === 'postgres' && !e.PAYGATE_DATABASE_URL) {
    throw new Error(
      'Invalid Paygate environment — PAYGATE_STORE=postgres requires PAYGATE_DATABASE_URL. ' +
        'Set it, or set PAYGATE_STORE=memory to run without a durable ledger (unit tests only: ' +
        'an in-memory provider forgets every charge on restart and cannot support INV-5).',
    );
  }

  const production = e.NODE_ENV === 'production';
  const testEndpointsRequested = e.PAYGATE_TEST_ENDPOINTS === 'on';
  return {
    port: e.PAYGATE_PORT,
    secret: e.PAYGATE_SECRET,
    chaos: e.PAYGATE_CHAOS === 'on',
    seed: e.PAYGATE_SEED,
    callbackUrl: e.PAYGATE_CALLBACK_URL ?? e.PAYGATE_WEBHOOK_URL ?? null,
    production,
    testEndpointsRequested,
    testEndpoints: testEndpointsRequested && !production,
    declineAmountMinor: e.PAYGATE_DECLINE_AMOUNT_MINOR,
    deliveryTimeoutMs: e.PAYGATE_DELIVERY_TIMEOUT_MS,
    store: e.PAYGATE_STORE,
    databaseUrl: e.PAYGATE_DATABASE_URL ?? null,
    logLevel: e.LOG_LEVEL,
  };
}
