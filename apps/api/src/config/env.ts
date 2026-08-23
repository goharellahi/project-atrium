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

  // Booking rules. Unused in P1 — validated here so a bad value fails the
  // deploy rather than the first hold.
  HOLD_TTL_SECONDS: z.coerce.number().int().positive().default(480),
  CHECKOUT_REARM_SECONDS: z.coerce.number().int().positive().default(600),
  MAX_HOLD_REARMS: z.coerce.number().int().nonnegative().default(2),
  MAX_HOLD_LIFETIME_SECONDS: z.coerce.number().int().positive().default(1800),
  ROOM_TURNAROUND_MINUTES: z.coerce.number().int().nonnegative().default(15),

  PAYGATE_BASE_URL: z.string().url().optional(),
  PAYGATE_SECRET: z.string().optional(),
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
