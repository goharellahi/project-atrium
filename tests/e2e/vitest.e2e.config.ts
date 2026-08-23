import { defineConfig } from 'vitest/config';

/**
 * The payment integrity suite. Requires `docker compose up` — three API
 * replicas behind nginx on :8080, Paygate on :9000 with its test endpoints on.
 *
 *   pnpm e2e
 *
 * Serial, and not by accident: several scenarios assert on the exact contents
 * of payment_events and webhook_deliveries, and a sibling test creating
 * deliveries at the same time would change what they are counting.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.e2e.test.ts'],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
