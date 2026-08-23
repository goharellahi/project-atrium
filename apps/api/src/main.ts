import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { AppModule } from './app.module';
import { PG_POOL } from './app.tokens';
import { logger } from './common/logger';
import { loadEnv } from './config/env';
import { runMigrations } from './db/migrate';

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
