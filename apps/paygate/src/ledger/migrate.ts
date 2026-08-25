import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

/**
 * Paygate's migration runner.
 *
 * Forty lines rather than a dependency, and that is the point: Paygate must not
 * import drizzle, because drizzle is how the API's schema is defined and the
 * boundary between the two services should be visible in the import graph, not
 * only in a comment. A provider that shares its ORM setup with the service it
 * is pretending to be a third party to is a provider nobody believes.
 *
 * `paygate_migrations` is Paygate's own history table. It has no relationship
 * to the API's `__drizzle_migrations`, and the two can be applied in either
 * order, by either service, against the same instance.
 *
 * Applied under an advisory lock so three API replicas booting at once — or a
 * seed racing a cold start — cannot apply the same file twice. The lock id is a
 * fixed arbitrary constant, namespaced away from anything the API takes.
 */
// Arbitrary and fixed. Namespaced away from anything the API takes so the two
// services cannot block each other's migrations.
const ADVISORY_LOCK_ID = 0x7061_7967; // 'payg'

const HERE = dirname(fileURLToPath(import.meta.url));

export async function migrate(pool: Pool, log: (msg: string) => void): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_ID]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS paygate_migrations (
        name       text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const dir = join(HERE, 'migrations');
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const applied = new Set(
      (await client.query<{ name: string }>('SELECT name FROM paygate_migrations')).rows.map(
        (r) => r.name,
      ),
    );

    for (const file of files) {
      if (applied.has(file)) continue;

      // One transaction per file. A migration that fails half way leaves
      // nothing behind and is retried whole on the next boot.
      await client.query('BEGIN');
      try {
        await client.query(readFileSync(join(dir, file), 'utf8'));
        await client.query('INSERT INTO paygate_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        log(`paygate migration applied: ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_ID]).catch(() => undefined);
    client.release();
  }
}
