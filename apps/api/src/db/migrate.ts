import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { join } from 'node:path';

/**
 * Applies every migration in order, including the hand-written
 * 0001_constraints.sql, which is registered in meta/_journal.json.
 *
 * Two entry points, because the two deployment targets have different
 * constraints:
 *
 *   - `docker compose` runs this as a one-shot `migrate` service that the three
 *     API replicas wait on. Three replicas each migrating on boot would race.
 *   - Render free tier has no pre-deploy hook and no shell access, and does not
 *     run `dockerCommand` through a shell — so migrations are invoked from
 *     `main.ts` before the server binds, gated on RUN_MIGRATIONS_ON_BOOT.
 *     Safe only because that service runs a single instance.
 */
export async function runMigrations(databaseUrl: string): Promise<void> {
  // A dedicated single-connection pool, closed immediately afterwards. It must
  // not share the application pool: on the boot path that pool does not exist
  // yet, and holding a migration connection open in it would waste one of the
  // 512MB instance's few slots for the process lifetime.
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });

  try {
    const migrationsFolder = join(__dirname, 'migrations');
    process.stdout.write(`applying migrations from ${migrationsFolder}\n`);

    await migrate(drizzle(pool), { migrationsFolder });

    process.stdout.write('migrations applied\n');
  } finally {
    await pool.end();
  }
}

/** CLI entry, used by the compose one-shot service. */
async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  await runMigrations(databaseUrl);
}

// Only run when invoked directly (`node dist/db/migrate.js`), not when imported
// by main.ts — otherwise importing the module would migrate as a side effect.
if (require.main === module) {
  main().catch((err: unknown) => {
    process.stderr.write(`migration failed: ${String(err)}\n`);
    process.exit(1);
  });
}
