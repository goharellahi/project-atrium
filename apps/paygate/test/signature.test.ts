import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { corrupt, sign, verify } from '../src/signature.js';

const SECRET = 'test-paygate-hmac-secret';

describe('X-Paygate-Signature', () => {
  it('is hmac_sha256(raw_body, secret) in hex', () => {
    const raw = '{"charge_id":"ch_1","event":"charge.succeeded"}';
    const expected = createHmac('sha256', SECRET).update(raw, 'utf8').digest('hex');
    expect(sign(raw, SECRET)).toBe(expected);
    expect(sign(raw, SECRET)).toHaveLength(64);
    expect(verify(raw, SECRET, expected)).toBe(true);
  });

  it('is computed over the raw bytes, so a re-serialised body fails', () => {
    // Whitespace and number formatting do not survive a parse/stringify round
    // trip. A receiver that re-serialises before verifying gets a different
    // string and a signature mismatch — which is why Paygate signs and sends
    // one identical string, and why the API must verify against raw bytes.
    for (const raw of ['{"a": 1, "b": 2}', '{"amount_minor":45000.0}']) {
      const reserialised = JSON.stringify(JSON.parse(raw));
      expect(reserialised).not.toBe(raw);
      expect(verify(reserialised, SECRET, sign(raw, SECRET))).toBe(false);
    }
  });

  it('rejects the wrong secret and a truncated signature', () => {
    const raw = '{"x":1}';
    expect(verify(raw, 'another-secret', sign(raw, SECRET))).toBe(false);
    expect(verify(raw, SECRET, sign(raw, SECRET).slice(0, 32))).toBe(false);
    expect(verify(raw, SECRET, '')).toBe(false);
  });

  it('corrupt() produces a well-formed but invalid signature', () => {
    const raw = '{"x":1}';
    const good = sign(raw, SECRET);
    const bad = corrupt(good);
    expect(bad).not.toBe(good);
    expect(bad).toHaveLength(good.length);
    expect(bad).toMatch(/^[0-9a-f]{64}$/);
    expect(verify(raw, SECRET, bad)).toBe(false);
  });
});
