import { defineConfig } from 'vitest/config';

/**
 * The DEFAULT config, which is what `pnpm -r test` and therefore CI runs.
 *
 * It includes the route census — pure static analysis over the API's controller
 * decorators, needing no stack — and deliberately excludes the INV-6 probes,
 * which need three replicas, nginx and a real Postgres. Same split, and the
 * same reasoning, as tests/concurrency: a suite that fails for want of
 * infrastructure trains people to ignore red builds.
 *
 * The census is the half that must run everywhere, because it is what catches a
 * venue-scoped endpoint added without a probe.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.unit.test.ts'],
  },
});
