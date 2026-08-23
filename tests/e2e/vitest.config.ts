import { defineConfig } from 'vitest/config';

/** Default config: nothing here runs without the stack, so CI runs nothing. */
export default defineConfig({
  test: { include: ['src/**/*.unit.test.ts'] },
});
