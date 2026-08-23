import { defineConfig } from 'vitest/config';

/**
 * The 200-request proof. Requires `docker compose up` — three API replicas
 * behind nginx on :8080, sharing one Postgres.
 *
 *   pnpm --filter @atrium/tests-concurrency proof
 */
export default defineConfig({
  test: {
    include: ['src/**/*.proof.test.ts'],
    // The proof drives all three replicas and re-reads the database between
    // assertions. A sibling file racing it would change the rows it is checking.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
