import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { AppModule } from './app.module';
import { PG_POOL } from './app.tokens';
import { logger } from './common/logger';
import { loadEnv, type Env } from './config/env';
import { runMigrations } from './db/migrate';
import { runSeed } from './db/seed';

async function bootstrap(): Promise<void> {
  // Validated before Nest starts, so a bad environment is a failed boot rather
  // than a runtime surprise on the first request.
  const env = loadEnv();

  // Before the server binds, never after. A replica that accepts traffic
  // against a stale schema is worse than one that fails to start: the failure
  // is visible, the stale schema is not.
  if (env.RUN_MIGRATIONS_ON_BOOT) {
    await runMigrations(env.DATABASE_URL);
  }

  // After migrations — the seed needs the schema — and before the server binds,
  // so no request can observe a half-seeded database.
  await seedOnBootIfUnseeded(env);

  // `rawBody: true` keeps the exact bytes of every request body available as
  // `req.rawBody`, which the Paygate webhook route needs.
  //
  // Nest parses a JSON body and throws the original bytes away. Verifying an
  // HMAC against a re-serialised object works right up until a body arrives
  // whose key order or number formatting does not survive the round trip — at
  // which point every signature fails and the cause looks like a wrong secret
  // rather than a wrong input. This is the one line that prevents that, and it
  // has to be here rather than in the controller, because by the time a handler
  // runs the bytes are already gone.
  const app = await NestFactory.create(AppModule, { bufferLogs: true, rawBody: true });
  app.enableShutdownHooks();

  // Bind dual-stack, not '0.0.0.0'.
  //
  // Docker's embedded DNS returns AAAA records for the api1/api2/api3 service
  // names, so nginx will happily connect over IPv6. A server bound only to
  // 0.0.0.0 refuses those connections, which surfaces as intermittent 502s that
  // look like the application crashing under load. Under the concurrency proof
  // that would be indistinguishable from a real failure.
  //
  // '::' accepts IPv4-mapped connections too, so the IPv4 healthcheck on
  // 127.0.0.1 still works.
  await app.listen(env.API_PORT, '::');

  logger.info(
    { port: env.API_PORT, replica: env.REPLICA_ID, nodeEnv: env.NODE_ENV },
    'atrium-api listening',
  );

  await warnIfNoDefaultPolicy(app);
}

/**
 * Seed the deployed database, once, and only when there is nothing to lose.
 *
 * ## Why this exists at all
 *
 * The brief's deliverables require the deployed instance to carry the demo
 * volume and the five test logins. Render's free tier has no shell, no one-off
 * jobs and no exec, so the only process that can reach the managed database is
 * this one. The alternatives were considered and rejected:
 *
 *   - Running the seed from a laptop against the deployed `DATABASE_URL` works,
 *     and is the safest option in the abstract because no destructive code ever
 *     ships. It needs the production connection string to travel to wherever
 *     that laptop is, which is a worse trade than the guard below.
 *   - A boot-time seed with no guard is indefensible. The seed TRUNCATEs before
 *     it inserts, and a free-tier service restarts every time it wakes from
 *     sleep, so an unguarded version wipes the database several times a day.
 *
 * ## The guard
 *
 * It runs only when `venues` is empty. That table is the right sentinel because
 * nothing in the running application can insert into it — there is no venue
 * creation endpoint — so "has a venue" means "has been seeded" and cannot drift.
 * Once seeded, this is a no-op forever, which is what makes leaving the flag set
 * harmless rather than a countdown to data loss.
 *
 * It never deletes from an already-populated database, and it does not touch the
 * platform default cancellation policy: the seed truncates that table and puts
 * the row back in the same transaction, which is the P5 fix and is the reason
 * this can be trusted to run against a live instance at all.
 */
async function seedOnBootIfUnseeded(env: Env): Promise<void> {
  if (env.SEED_ON_BOOT === 'off') return;

  const pool = new Pool({ connectionString: env.DATABASE_URL, max: 1 });

  try {
    const existing = await pool.query('SELECT 1 FROM venues LIMIT 1');

    if ((existing.rowCount ?? 0) > 0) {
      logger.info(
        { profile: env.SEED_ON_BOOT },
        'SEED_ON_BOOT is set but this database already has venues — skipping. ' +
          'The flag is safe to leave set; it will not run again.',
      );
      return;
    }

    logger.warn(
      { profile: env.SEED_ON_BOOT },
      'SEED_ON_BOOT is set and this database has no venues — seeding now',
    );

    const summary = await runSeed(env.SEED_ON_BOOT, env.DATABASE_URL);

    logger.info(
      {
        profile: env.SEED_ON_BOOT,
        venues: summary.venues,
        rooms: summary.rooms,
        users: summary.users,
        bookings: summary.bookings,
        logins: summary.logins.map((l) => `${l.role}:${l.email}`),
      },
      'seed complete — unset SEED_ON_BOOT at your leisure, it is now a no-op',
    );
  } catch (err: unknown) {
    // A failed seed must not take the API down with it. The endpoints that do
    // not need seeded data — health, registration, the whole booking path
    // against data that arrives later — are unaffected, and a replica that
    // refuses to start is harder to diagnose than one that logs and serves.
    logger.error(
      { err: err instanceof Error ? err.stack : String(err) },
      'SEED_ON_BOOT failed; continuing without seeding',
    );
  } finally {
    await pool.end();
  }
}

/**
 * Say so at boot if the platform default cancellation policy is missing.
 *
 * Not a crash: a replica that refuses to start over one missing row takes the
 * search, availability and hold paths down with it, and those are unaffected.
 * But it must not be silent either — in P4 it was, and the symptom was every
 * `charge.succeeded` throwing inside the worker with nothing at boot to explain
 * why. One greppable line at startup is the cheapest possible fix for that.
 */
async function warnIfNoDefaultPolicy(app: INestApplication): Promise<void> {
  try {
    const pool = app.get<Pool>(PG_POOL);
    const result = await pool.query(
      'SELECT 1 FROM cancellation_policies WHERE venue_id IS NULL LIMIT 1',
    );
    if (result.rowCount === 1) return;

    logger.error(
      { remedy: 'node dist/db/migrate.js, or pnpm seed' },
      'NO PLATFORM DEFAULT CANCELLATION POLICY — bookings cannot be confirmed until one exists',
    );
  } catch (err: unknown) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'could not check for the platform default cancellation policy',
    );
  }
}

void bootstrap().catch((err: unknown) => {
  logger.fatal({ err: err instanceof Error ? err.message : String(err) }, 'boot failed');
  process.exit(1);
});
