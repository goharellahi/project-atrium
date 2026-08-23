import { defineConfig } from 'vitest/config';

/**
 * The chaos soak. Requires the full stack, and is worth running with a short
 * hold TTL so abandoned holds actually lapse during the run:
 *
 *   HOLD_TTL_SECONDS=45 docker compose up -d api1 api2 api3
 *   pnpm soak
 */
export default defineConfig({
  test: {
    include: ['src/**/*.soak.test.ts'],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 900_000,
    hookTimeout: 300_000,
  },
});
