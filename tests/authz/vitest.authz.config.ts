import { defineConfig } from 'vitest/config';

/**
 * The INV-6 negative suite. Requires `docker compose up` — three API replicas
 * behind nginx on :8080, sharing one Postgres.
 *
 *   pnpm --filter @atrium/tests-authz authz
 */
export default defineConfig({
  test: {
    include: ['src/**/*.authz.test.ts'],
    // The suite builds two venues and reads rows back between assertions. A
    // sibling file racing it would change the rows it is checking.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
