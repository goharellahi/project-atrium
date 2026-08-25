import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

/**
 * The smallest environment that boots.
 *
 * It names a database, because Paygate's default store is Postgres and
 * `loadConfig` refuses that combination without a URL rather than quietly
 * falling back. That refusal is the point — see the `PAYGATE_STORE` test below.
 */
const MINIMUM = {
  PAYGATE_SECRET: 'a-secret-long-enough',
  PAYGATE_DATABASE_URL: 'postgres://paygate@localhost:5432/atrium',
};

describe('loadConfig', () => {
  it('refuses to boot without a secret', () => {
    expect(() => loadConfig({})).toThrow(/PAYGATE_SECRET/);
    expect(() => loadConfig({ PAYGATE_SECRET: 'short' })).toThrow(/PAYGATE_SECRET/);
  });

  it('defaults to no chaos and to the test control surface on', () => {
    const cfg = loadConfig(MINIMUM);
    expect(cfg.chaos).toBe(false);
    expect(cfg.production).toBe(false);
    expect(cfg.testEndpointsRequested).toBe(true);
    expect(cfg.testEndpoints).toBe(true);
  });

  it('hard-disables the test control surface under NODE_ENV=production', () => {
    const cfg = loadConfig({
      ...MINIMUM,
      NODE_ENV: 'production',
      PAYGATE_TEST_ENDPOINTS: 'on',
    });
    expect(cfg.production).toBe(true);
    // What was asked for is kept, so the app can say the request was ignored
    // rather than silently doing something different.
    expect(cfg.testEndpointsRequested).toBe(true);
    expect(cfg.testEndpoints).toBe(false);
  });

  it('keeps the surface available in every other environment', () => {
    for (const env of ['development', 'test', 'staging', 'Production']) {
      expect(loadConfig({ ...MINIMUM, NODE_ENV: env }).testEndpoints).toBe(true);
    }
  });

  /**
   * The guard that stops the amnesiac provider coming back.
   *
   * Paygate held its ledger in memory until P8, which meant Render's free tier
   * — asleep after fifteen idle minutes — forgot every charge it had captured
   * and answered `404 unknown_charge` to the refund that followed. INV-5 cannot
   * be demonstrated against a provider like that.
   *
   * So `postgres` is the default and a missing URL is a boot failure, not a
   * fallback. A silent fallback is exactly how a deployment ends up running the
   * broken store without anyone choosing it.
   */
  describe('the ledger has to be chosen, not defaulted into', () => {
    it('defaults to a durable store', () => {
      expect(loadConfig(MINIMUM).store).toBe('postgres');
      expect(loadConfig(MINIMUM).databaseUrl).toBe(
        'postgres://paygate@localhost:5432/atrium',
      );
    });

    it('refuses to boot on postgres with no database url, rather than falling back', () => {
      expect(() => loadConfig({ PAYGATE_SECRET: 'a-secret-long-enough' })).toThrow(
        /PAYGATE_DATABASE_URL/,
      );
    });

    it('allows memory only when it is asked for by name', () => {
      const cfg = loadConfig({
        PAYGATE_SECRET: 'a-secret-long-enough',
        PAYGATE_STORE: 'memory',
      });
      expect(cfg.store).toBe('memory');
      expect(cfg.databaseUrl).toBeNull();
    });
  });

  it('accepts either callback url name, with the brief\'s name winning', () => {
    expect(
      loadConfig({ ...MINIMUM, PAYGATE_WEBHOOK_URL: 'http://compose/hook' }).callbackUrl,
    ).toBe('http://compose/hook');

    expect(
      loadConfig({
        ...MINIMUM,
        PAYGATE_CALLBACK_URL: 'http://brief/hook',
        PAYGATE_WEBHOOK_URL: 'http://compose/hook',
      }).callbackUrl,
    ).toBe('http://brief/hook');

    expect(loadConfig(MINIMUM).callbackUrl).toBeNull();
  });
});
