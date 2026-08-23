import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const MINIMUM = { PAYGATE_SECRET: 'a-secret-long-enough' };

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
