import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { planFor } from '../src/chaos.js';
import { verify } from '../src/signature.js';
import { SECRET, startHarness, testConfig, type Harness } from './harness.js';

const CHARGE = { amount_minor: 45_000, currency: 'PKR', reference: 'booking-1' };

describe('POST /paygate/charges', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.stop();
  });

  it('returns 202 with a ch_ id and delivers one signed webhook', async () => {
    const key = randomUUID();
    const res = await h.app.inject({
      method: 'POST',
      url: '/paygate/charges',
      headers: { 'idempotency-key': key, 'x-request-id': 'corr-abc' },
      payload: CHARGE,
    });

    expect(res.statusCode).toBe(202);
    const body = res.json<{ charge_id: string; status: string }>();
    expect(body.charge_id).toMatch(/^ch_[0-9a-f]{32}$/);
    expect(body.status).toBe('processing');

    await h.settle();
    expect(h.receiver.received).toHaveLength(1);

    const hook = h.receiver.received[0]!;
    expect(hook.body).toMatchObject({
      charge_id: body.charge_id,
      reference: 'booking-1',
      event: 'charge.succeeded',
      amount_minor: 45_000,
    });
    expect(new Date(hook.body.occurred_at).toISOString()).toBe(hook.body.occurred_at);
    expect(hook.deliveryId).toMatch(/^[0-9a-f-]{36}$/);
    // The signature must verify against the raw bytes, not a re-serialisation.
    expect(verify(hook.raw, SECRET, hook.signature ?? '')).toBe(true);
    // Tier-2: the correlation id survives into the webhook path.
    expect(hook.requestId).toBe('corr-abc');
  });

  it('is idempotent: same key returns the same charge and does not charge twice', async () => {
    const key = randomUUID();
    const first = await h.app.inject({
      method: 'POST',
      url: '/paygate/charges',
      headers: { 'idempotency-key': key },
      payload: CHARGE,
    });
    const second = await h.app.inject({
      method: 'POST',
      url: '/paygate/charges',
      headers: { 'idempotency-key': key },
      payload: CHARGE,
    });

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(second.json<{ charge_id: string }>().charge_id).toBe(
      first.json<{ charge_id: string }>().charge_id,
    );
    expect(h.store.charges.size).toBe(1);

    await h.settle();
    expect(h.receiver.received).toHaveLength(1);
  });

  it('rejects a reused key carrying a different body with 409', async () => {
    const key = randomUUID();
    await h.app.inject({
      method: 'POST',
      url: '/paygate/charges',
      headers: { 'idempotency-key': key },
      payload: CHARGE,
    });
    const res = await h.app.inject({
      method: 'POST',
      url: '/paygate/charges',
      headers: { 'idempotency-key': key },
      payload: { ...CHARGE, amount_minor: 1 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('idempotency_key_reuse');
    expect(h.store.charges.size).toBe(1);
  });

  it('requires an Idempotency-Key and a valid body', async () => {
    const missing = await h.app.inject({ method: 'POST', url: '/paygate/charges', payload: CHARGE });
    expect(missing.statusCode).toBe(400);

    const bad = await h.app.inject({
      method: 'POST',
      url: '/paygate/charges',
      headers: { 'idempotency-key': randomUUID() },
      payload: { amount_minor: -1, currency: 'pkr', reference: '' },
    });
    expect(bad.statusCode).toBe(422);
    expect(h.store.charges.size).toBe(0);
  });

  it('declines deterministically at the configured amount', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/paygate/charges',
      headers: { 'idempotency-key': randomUUID() },
      payload: { ...CHARGE, amount_minor: testConfig().declineAmountMinor },
    });
    expect(res.statusCode).toBe(202);
    await h.settle();
    expect(h.receiver.received[0]!.body.event).toBe('charge.failed');
  });
});

describe('the 10% transient failure', () => {
  /** A key that the seeded plan sends down the 500 branch. Found, not guessed. */
  function keyThat500s(seed: string): string {
    const cfg = testConfig({ chaos: true, seed });
    for (let i = 0; i < 10_000; i++) {
      const key = `transient-${i}`;
      if (planFor(key, cfg).transientFailure) return key;
    }
    throw new Error('no transient-failure key found — the plan is not firing that branch');
  }

  it('500s, then the retry with the same key returns the same charge_id', async () => {
    const seed = 'transient-seed';
    const h = await startHarness({ chaos: true, seed });
    try {
      const key = keyThat500s(seed);

      const first = await h.app.inject({
        method: 'POST',
        url: '/paygate/charges',
        headers: { 'idempotency-key': key },
        payload: CHARGE,
      });
      expect(first.statusCode).toBe(500);
      expect(first.json<{ error: { code: string } }>().error.code).toBe('provider_error');

      // The 500 must not have delivered anything: nothing was charged yet.
      await h.settle();
      expect(h.receiver.received).toHaveLength(0);

      const retry = await h.app.inject({
        method: 'POST',
        url: '/paygate/charges',
        headers: { 'idempotency-key': key },
        payload: CHARGE,
      });
      expect(retry.statusCode).toBe(202);

      // Exactly one charge exists, and it is the one the 500 minted.
      expect(h.store.charges.size).toBe(1);
      const only = [...h.store.charges.values()][0]!;
      expect(retry.json<{ charge_id: string }>().charge_id).toBe(only.id);

      // A third attempt still does not create a second charge.
      await h.app.inject({
        method: 'POST',
        url: '/paygate/charges',
        headers: { 'idempotency-key': key },
        payload: CHARGE,
      });
      expect(h.store.charges.size).toBe(1);
    } finally {
      await h.stop();
    }
  });
});

describe('POST /paygate/refunds', () => {
  let h: Harness;
  let chargeId: string;

  beforeEach(async () => {
    h = await startHarness();
    const res = await h.app.inject({
      method: 'POST',
      url: '/paygate/charges',
      headers: { 'idempotency-key': randomUUID(), 'x-request-id': 'corr-refund' },
      payload: CHARGE,
    });
    chargeId = res.json<{ charge_id: string }>().charge_id;
    await h.settle();
    h.receiver.clear();
  });
  afterEach(async () => {
    await h.stop();
  });

  it('refunds once and emits refund.succeeded carrying the refund id', async () => {
    const key = randomUUID();
    const res = await h.app.inject({
      method: 'POST',
      url: '/paygate/refunds',
      headers: { 'idempotency-key': key },
      payload: { charge_id: chargeId, amount_minor: 22_500 },
    });
    expect(res.statusCode).toBe(202);
    const refundId = res.json<{ refund_id: string }>().refund_id;
    expect(refundId).toMatch(/^re_[0-9a-f]{32}$/);

    await h.settle();
    expect(h.receiver.received).toHaveLength(1);
    const hook = h.receiver.received[0]!;
    expect(hook.body.event).toBe('refund.succeeded');
    expect(hook.body.refund_id).toBe(refundId);
    expect(hook.body.charge_id).toBe(chargeId);
    expect(hook.body.amount_minor).toBe(22_500);
    expect(verify(hook.raw, SECRET, hook.signature ?? '')).toBe(true);
    // The charge's correlation id carries into the refund's webhook.
    expect(hook.requestId).toBe('corr-refund');
  });

  it('is idempotent: double-clicking cancel refunds once', async () => {
    const key = randomUUID();
    const payload = { charge_id: chargeId, amount_minor: 22_500 };
    const a = await h.app.inject({
      method: 'POST',
      url: '/paygate/refunds',
      headers: { 'idempotency-key': key },
      payload,
    });
    const b = await h.app.inject({
      method: 'POST',
      url: '/paygate/refunds',
      headers: { 'idempotency-key': key },
      payload,
    });
    expect(b.json<{ refund_id: string }>().refund_id).toBe(a.json<{ refund_id: string }>().refund_id);
    expect(h.store.refunds.size).toBe(1);
    expect(h.store.charges.get(chargeId)!.refunded_minor).toBe(22_500);

    await h.settle();
    expect(h.receiver.received).toHaveLength(1);
  });

  it('404s an unknown charge rather than 500ing', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/paygate/refunds',
      headers: { 'idempotency-key': randomUUID() },
      payload: { charge_id: 'ch_does_not_exist', amount_minor: 100 },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('unknown_charge');
  });

  it('refuses to refund more than was captured', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/paygate/refunds',
      headers: { 'idempotency-key': randomUUID() },
      payload: { charge_id: chargeId, amount_minor: 45_001 },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('refund_exceeds_charge');
  });
});

describe('GET /paygate/charges/:id', () => {
  it('returns the charge and its full delivery history', async () => {
    const h = await startHarness();
    try {
      const created = await h.app.inject({
        method: 'POST',
        url: '/paygate/charges',
        headers: { 'idempotency-key': randomUUID() },
        payload: CHARGE,
      });
      const chargeId = created.json<{ charge_id: string }>().charge_id;
      await h.settle();

      const res = await h.app.inject({ method: 'GET', url: `/paygate/charges/${chargeId}` });
      expect(res.statusCode).toBe(200);
      const view = res.json<{
        status: string;
        deliveries: Array<{ delivery_id: string; attempt: number; response_status: number }>;
      }>();
      expect(view.status).toBe('succeeded');
      expect(view.deliveries).toHaveLength(1);
      expect(view.deliveries[0]!.attempt).toBe(1);
      expect(view.deliveries[0]!.response_status).toBe(200);

      const missing = await h.app.inject({ method: 'GET', url: '/paygate/charges/ch_nope' });
      expect(missing.statusCode).toBe(404);
    } finally {
      await h.stop();
    }
  });
});

describe('the test control surface', () => {
  let h: Harness;
  let chargeId: string;

  beforeEach(async () => {
    h = await startHarness();
    const res = await h.app.inject({
      method: 'POST',
      url: '/paygate/charges',
      headers: { 'idempotency-key': randomUUID() },
      payload: CHARGE,
    });
    chargeId = res.json<{ charge_id: string }>().charge_id;
    await h.settle();
    h.receiver.clear();
  });
  afterEach(async () => {
    await h.stop();
  });

  it('_test/deliver forces duplicates, each with a new X-Paygate-Delivery', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/paygate/_test/deliver',
      payload: { charge_id: chargeId, times: 3 },
    });
    expect(res.statusCode).toBe(200);
    expect(h.receiver.received).toHaveLength(3);

    const ids = new Set(h.receiver.received.map((r) => r.deliveryId));
    expect(ids.size).toBe(3);
    for (const hook of h.receiver.received) {
      expect(hook.body.event).toBe('charge.succeeded');
      expect(verify(hook.raw, SECRET, hook.signature ?? '')).toBe(true);
    }
  });

  it('_test/deliver can force an invalid signature', async () => {
    await h.app.inject({
      method: 'POST',
      url: '/paygate/_test/deliver',
      payload: { charge_id: chargeId, corrupt_signature: true },
    });
    const hook = h.receiver.received[0]!;
    expect(verify(hook.raw, SECRET, hook.signature ?? '')).toBe(false);
  });

  it('_test/delay holds the next delivery back', async () => {
    await h.app.inject({
      method: 'POST',
      url: '/paygate/_test/delay',
      payload: { charge_id: chargeId, seconds: 60 },
    });

    // The armed delay applies to the next charge dispatched for this id. Arm
    // it globally instead and watch a brand-new charge stay undelivered.
    await h.app.inject({ method: 'POST', url: '/paygate/_test/delay', payload: { seconds: 60 } });
    await h.app.inject({
      method: 'POST',
      url: '/paygate/charges',
      headers: { 'idempotency-key': randomUUID() },
      payload: { ...CHARGE, reference: 'booking-late' },
    });
    await h.settle();
    expect(h.receiver.received.filter((r) => r.body.reference === 'booking-late')).toHaveLength(0);
  });

  it('_test/deliver 404s an unknown charge', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/paygate/_test/deliver',
      payload: { charge_id: 'ch_nope' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('can be switched off entirely', async () => {
    const off = await startHarness({ testEndpoints: false, testEndpointsRequested: false });
    try {
      const res = await off.app.inject({
        method: 'POST',
        url: '/paygate/_test/deliver',
        payload: { charge_id: 'ch_x' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await off.stop();
    }
  });

  it('does not register under NODE_ENV=production, even when asked for', async () => {
    // The routes forge signed webhooks and take no auth. In production they
    // should not exist at all, so nobody reading the route table has to work
    // out whether they are scaffolding or an oversight.
    const prod = await startHarness({ production: true, testEndpointsRequested: true });
    try {
      for (const url of ['/paygate/_test/deliver', '/paygate/_test/delay']) {
        const res = await prod.app.inject({ method: 'POST', url, payload: { charge_id: 'ch_x' } });
        expect(res.statusCode).toBe(404);
      }
      // The rest of the provider is unaffected.
      const health = await prod.app.inject({ method: 'GET', url: '/health' });
      expect(health.json()).toMatchObject({ status: 'ok', test_endpoints: 'off' });
    } finally {
      await prod.stop();
    }
  });
});

describe('GET /health', () => {
  it('reports the chaos switch and the seed', async () => {
    const h = await startHarness({ chaos: true, seed: 'health-seed' });
    try {
      const res = await h.app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        status: 'ok',
        service: 'paygate',
        chaos: 'on',
        seed: 'health-seed',
        callback_url_configured: true,
      });
    } finally {
      await h.stop();
    }
  });
});
