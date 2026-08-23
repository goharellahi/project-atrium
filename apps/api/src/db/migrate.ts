import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { join } from 'node:path';

/**
 * Applies every migration in order, including the hand-written
 * 0001_constraints.sql, which is registered in meta/_journal.json.
 *
 * Run as a one-shot container before the API replicas start, so three replicas
 * do not race to migrate. Drizzle takes an advisory lock, but serialising this
 * explicitly is cheaper than reasoning about it.
 */
async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const db = drizzle(pool);

  const migrationsFolder = join(__dirname, 'migrations');
  process.stdout.write(`applying migrations from ${migrationsFolder}\n`);

  await migrate(db, { migrationsFolder });

  process.stdout.write('migrations applied\n');
  await pool.end();
}

main().catch((err: unknown) => {
  process.stderr.write(`migration failed: ${String(err)}\n`);
  process.exit(1);
});
