import { defineConfig } from 'vitest/config';

/**
 * Tests come from `src/`, never from `dist/`.
 *
 * `nest build` used to compile `*.test.ts` alongside everything else, so a
 * build followed by a test run found two copies of every suite — the TypeScript
 * source and its CommonJS twin — and the compiled one fails immediately, since
 * vitest cannot be `require()`d. Found in P5 by running the two commands in
 * that order for the first time.
 *
 * `tsconfig.build.json` now excludes test files from the build, which is the
 * more important half of the fix: test code has no business in a production
 * image. This config is the belt to that braces, and it also stops a stale
 * `dist/` left over from before the fix from failing the suite.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'dist/**'],
  },
});
