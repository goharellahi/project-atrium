import { z } from 'zod';

/**
 * Environment is validated once, at boot, and the process refuses to start if
 * it is wrong. A missing JWT_SECRET discovered at the first login attempt is a
 * production incident; discovered at boot it is a failed deploy.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().min(1),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_ACCESS_TTL: z.coerce.number().int().positive().default(900),

  REPLICA_ID: z.string().default('unknown'),

  /**
   * Apply migrations during boot, before the server binds.
   *
   * Off by default. docker compose leaves it off and uses the one-shot
   * `migrate` service instead, because three replicas migrating concurrently
   * would race. Render turns it on: the free tier has no pre-deploy hook, no
   * shell access, and runs a single instance.
   */
  RUN_MIGRATIONS_ON_BOOT: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // Booking rules. See ARCHITECTURE.md Assumption 1 for why the 8-minute TTL
  // and the 10-minute checkout guarantee are two separate numbers.
  HOLD_TTL_SECONDS: z.coerce.number().int().positive().default(480),
  CHECKOUT_REARM_SECONDS: z.coerce.number().int().positive().default(600),
  MAX_HOLD_REARMS: z.coerce.number().int().nonnegative().default(2),
  MAX_HOLD_LIFETIME_SECONDS: z.coerce.number().int().positive().default(1800),
  ROOM_TURNAROUND_MINUTES: z.coerce.number().int().nonnegative().default(15),

  /**
   * How often each replica ATTEMPTS a hold sweep. All three try; a Postgres
   * advisory lock elects one per tick, so this is a per-replica attempt
   * interval, not a per-cluster sweep interval. See HoldSweeper.
   */
  HOLD_SWEEPER_INTERVAL_SECONDS: z.coerce.number().int().positive().default(30),

  PAYGATE_BASE_URL: z.string().url().optional(),
  PAYGATE_SECRET: z.string().optional(),

  /**
   * How long to wait on Paygate before giving up on one request.
   *
   * A timeout is NOT a failed charge — the provider may have accepted it and be
   * about to deliver a webhook — so this bounds how long a customer waits, not
   * whether they were charged. Kept below the hold TTL by a wide margin so a
   * hung provider cannot silently consume the hold the payment is for.
   */
  PAYGATE_TIMEOUT_MS: z.coerce.number().int().positive().default(8_000),

  /**
   * How often each replica attempts to drain unapplied webhook deliveries.
   *
   * Like the hold sweeper, all three attempt it and a Postgres advisory lock
   * elects one per tick. Short, because the backlog it drains includes the
   * race-on-response case where a delivery arrived a few milliseconds before
   * the payments row it belongs to.
   */
  WEBHOOK_DRAIN_INTERVAL_SECONDS: z.coerce.number().int().positive().default(10),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return parsed.data;
}

export const ENV = Symbol('ENV');
