import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema';

/**
 * One pool per API replica.
 *
 * `max` is deliberately modest. Three replicas share one Postgres, and the
 * compose file caps max_connections at 200; the hold path holds a row lock for
 * the duration of a transaction, so a larger pool would buy queueing inside
 * Postgres rather than throughput.
 */
export function createPool(databaseUrl: string): Pool {
  return new Pool({
    connectionString: databaseUrl,
    max: Number(process.env.PG_POOL_MAX ?? 20),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

export function createDb(pool: Pool) {
  return drizzle(pool, { schema });
}

export type Db = ReturnType<typeof createDb>;
export { schema };
