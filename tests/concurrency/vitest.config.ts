import { defineConfig } from 'vitest/config';

/**
 * The DEFAULT config, which is what `pnpm -r test` and therefore CI runs.
 *
 * It deliberately does NOT include the proof. The proof needs three API
 * replicas behind nginx and a real Postgres — a stack CI does not stand up —
 * and a suite that fails for want of infrastructure trains people to ignore red
 * builds. The proof runs from `pnpm proof` against a live `docker compose up`,
 * and its output is pasted into ARCHITECTURE.md as the evidence.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.unit.test.ts'],
  },
});
