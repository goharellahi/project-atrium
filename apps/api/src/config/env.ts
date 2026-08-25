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

  /**
   * Seed the database during boot, but only if it has never been seeded.
   *
   * Render's free tier gives no shell and no one-off jobs, so the only process
   * that can reach the managed database is the API itself. This is the flag
   * that lets it, and the guard that makes it safe is not here — it is in
   * `seedOnBootIfUnseeded`, which refuses to run against a database that
   * already has a venue in it.
   *
   * That guard is what makes leaving this set harmless. The seed TRUNCATEs
   * before it inserts, so a boot path that ran unconditionally would wipe the
   * database on every restart — and a free-tier service restarts every time it
   * wakes from sleep. "Only when there is nothing to lose" is the difference
   * between a deployment tool and a foot-gun.
   *
   * `off` by default, and docker compose never sets it: the local stack seeds
   * through the CLI, where a human is present to mean it.
   */
  SEED_ON_BOOT: z.enum(['off', 'demo', 'full']).default('off'),

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

  /**
   * How many times a transaction aborted by Postgres with a class-40 error
   * (deadlock, serialization failure) is re-run before the caller is told the
   * slot is contended.
   *
   * 1 means "do not retry". This is an env var and not a constant because the
   * right value is a measured trade-off, not a design opinion — see
   * ARCHITECTURE.md Appendix B for the runs that chose it. Too low and a
   * routine deadlock becomes a failed booking; too high and every retry holds a
   * pool connection through another contended transaction, which under a
   * 200-way pile-up on one slot exhausts the pool and turns a handful of
   * deadlocks into a hundred connection timeouts.
   */
  TRANSIENT_RETRY_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),

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
   * How often each replica drains unapplied webhook deliveries.
   *
   * All three drain; there is no election, and WebhookProcessor.tick explains
   * why the one P4 had was doing nothing. Short, because the backlog includes
   * the race-on-response case where a delivery arrived a few milliseconds
   * before the payments row it belongs to.
   */
  WEBHOOK_DRAIN_INTERVAL_SECONDS: z.coerce.number().int().positive().default(10),

  /**
   * How long a refund may sit accepted-but-unsettled before the API stops
   * waiting for a webhook and asks the provider directly.
   *
   * Comfortably longer than Paygate's ordinary delivery latency and its 30%
   * duplicate gap, so this never races a webhook that is simply on its way. It
   * exists for the deliveries that will never arrive at all — the 2% whose
   * signature was corrupted, which are correctly rejected and never resent.
   */
  REFUND_POLL_AFTER_SECONDS: z.coerce.number().int().positive().default(45),

  /**
   * How long a charge may sit accepted-but-unresolved before the API stops
   * waiting for a webhook and asks the provider directly.
   *
   * Longer than the refund equivalent because a charge's outcome legitimately
   * takes longer to arrive: Paygate's delayed-delivery branch parks 5% of
   * webhooks for 60-90 seconds, and polling inside that window would be asking
   * the provider to confirm what its own delivery is about to say.
   *
   * Comfortably shorter than HOLD_TTL_SECONDS, which is the point. A charge
   * whose webhook was lost has to be resolved while the hold it belongs to is
   * still live, or the booking expires holding money.
   */
  CHARGE_POLL_AFTER_SECONDS: z.coerce.number().int().positive().default(100),
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
