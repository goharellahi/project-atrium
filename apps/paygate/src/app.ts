import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { planFor, type ChaosPlan } from './chaos.js';
import type { PaygateConfig } from './config.js';
import { Deliverer, type DeliveryRequest } from './delivery.js';
import { Store } from './store.js';
import { registerTestRoutes } from './test-routes.js';
import type { Charge, Refund, WebhookEvent } from './types.js';

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

const ChargeBody = z.object({
  amount_minor: z.number().int().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/, 'expected a 3-letter ISO-4217 code'),
  reference: z.string().min(1).max(200),
});

const RefundBody = z.object({
  charge_id: z.string().min(1).max(120),
  amount_minor: z.number().int().positive(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fail(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.code(status).send({ error: { code, message } });
}

function header(req: FastifyRequest, name: string): string | null {
  const v = req.headers[name];
  if (Array.isArray(v)) return v[0] ?? null;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function issues(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

/** A charge as the reviewer sees it, chaos plan included. */
function chargeView(charge: Charge, store: Store) {
  return {
    charge_id: charge.id,
    reference: charge.reference,
    amount_minor: charge.amount_minor,
    currency: charge.currency,
    status: charge.status,
    created_at: charge.created_at,
    occurred_at: charge.occurred_at,
    refunded_minor: charge.refunded_minor,
    correlation_id: charge.correlation_id,
    idempotency_key: charge.idempotency_key,
    chaos_plan: charge.plan,
    refunds: charge.refund_ids
      .map((id) => store.refunds.get(id))
      .filter((r): r is Refund => r !== undefined)
      .map((r) => ({
        refund_id: r.id,
        amount_minor: r.amount_minor,
        status: r.status,
        created_at: r.created_at,
        occurred_at: r.occurred_at,
        correlation_id: r.correlation_id,
      })),
    deliveries: charge.deliveries,
  };
}

export interface PaygateApp {
  app: FastifyInstance;
  store: Store;
  deliverer: Deliverer;
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

export function buildApp(cfg: PaygateConfig): PaygateApp {
  const app = Fastify({
    logger: { level: cfg.logLevel },
    // nginx and the API both set X-Request-Id; keep fastify's own request id
    // aligned so one grep across all four services follows a single booking
    // end to end.
    genReqId: (req) => {
      const v = req.headers['x-request-id'];
      return typeof v === 'string' && v.length > 0 ? v : randomUUID();
    },
  });

  const store = new Store();
  const deliverer = new Deliverer(cfg, app.log, store);

  // Computed once and used for both registration and /health, so health can
  // never report a control surface that is not actually mounted.
  const testRoutesEnabled = cfg.testEndpoints && !cfg.production;

  if (!cfg.callbackUrl) {
    app.log.warn(
      'paygate has no callback url — set PAYGATE_CALLBACK_URL (or PAYGATE_WEBHOOK_URL); every delivery will be recorded as skipped',
    );
  }

  // -- delivery orchestration ----------------------------------------------

  /**
   * Decide when the webhook(s) for one outcome go out, per the chaos plan.
   *
   * Resolves only after the first delivery when the race-on-response branch
   * fires — that is the entire point of that branch. The webhook lands on the
   * API before the 202 does, so the API's webhook handler sees a charge it has
   * not recorded yet.
   */
  async function dispatch(opts: {
    chargeId: string;
    reference: string;
    event: WebhookEvent;
    amountMinor: number;
    occurredAt: string;
    refundId: string | null;
    idempotencyKey: string;
    correlationId: string | null;
    plan: ChaosPlan;
  }): Promise<void> {
    const forced = store.takeForcedDelay(opts.chargeId);
    const firstDelayMs = forced ?? opts.plan.firstDelayMs;
    const timing = forced !== null ? 'delayed' : opts.plan.timing;

    const base: Omit<DeliveryRequest, 'branch' | 'scheduledDelayMs'> = {
      chargeId: opts.chargeId,
      reference: opts.reference,
      event: opts.event,
      amountMinor: opts.amountMinor,
      occurredAt: opts.occurredAt,
      refundId: opts.refundId,
      idempotencyKey: opts.idempotencyKey,
      correlationId: opts.correlationId,
      forceCorruptSignature: null,
    };

    if (timing === 'race_on_response') {
      await deliverer.deliver({ ...base, branch: 'race_on_response', scheduledDelayMs: 0 });
    } else {
      deliverer.schedule({ ...base, branch: timing, scheduledDelayMs: firstDelayMs }, firstDelayMs);
    }

    if (opts.plan.duplicateDelivery) {
      const gap =
        timing === 'race_on_response'
          ? opts.plan.duplicateGapMs
          : firstDelayMs + opts.plan.duplicateGapMs;
      deliverer.schedule({ ...base, branch: 'duplicate', scheduledDelayMs: gap }, gap);
    }
  }

  /**
   * Bring a charge to life.
   *
   * This is precisely what a 500'd charge has *not* had done to it, and what
   * its retry does instead of minting a second charge.
   */
  async function materialiseCharge(charge: Charge): Promise<void> {
    if (charge.materialised) return;
    charge.materialised = true;

    // Paygate never declines at random. A random decline in the middle of a
    // concurrency proof is indistinguishable from a real bug, and the brief's
    // chaos table does not ask for one. Declines are triggered by amount.
    charge.status = charge.amount_minor === cfg.declineAmountMinor ? 'failed' : 'succeeded';
    charge.occurred_at = new Date(Date.now() - charge.plan.clockSkewSeconds * 1000).toISOString();

    await dispatch({
      chargeId: charge.id,
      reference: charge.reference,
      event: charge.status === 'succeeded' ? 'charge.succeeded' : 'charge.failed',
      amountMinor: charge.amount_minor,
      occurredAt: charge.occurred_at,
      refundId: null,
      idempotencyKey: charge.idempotency_key,
      correlationId: charge.correlation_id,
      plan: charge.plan,
    });
  }

  async function materialiseRefund(refund: Refund): Promise<void> {
    if (refund.materialised) return;
    refund.materialised = true;
    refund.status = 'succeeded';
    refund.occurred_at = new Date(Date.now() - refund.plan.clockSkewSeconds * 1000).toISOString();

    await dispatch({
      chargeId: refund.charge_id,
      reference: refund.reference,
      event: 'refund.succeeded',
      amountMinor: refund.amount_minor,
      occurredAt: refund.occurred_at,
      refundId: refund.id,
      idempotencyKey: refund.idempotency_key,
      correlationId: refund.correlation_id,
      plan: refund.plan,
    });
  }

  // -- routes --------------------------------------------------------------

  app.get('/health', async () => ({
    status: 'ok',
    service: 'paygate',
    chaos: cfg.chaos ? 'on' : 'off',
    seed: cfg.seed,
    callback_url_configured: cfg.callbackUrl !== null,
    test_endpoints: testRoutesEnabled ? 'on' : 'off',
    charges: store.charges.size,
    refunds: store.refunds.size,
  }));

  /**
   * POST /paygate/charges
   *
   * The idempotency record is written BEFORE the transient-failure branch is
   * evaluated. That ordering is the whole contract: the charge id survives the
   * 500, so the caller's retry with the same key gets that same id back and a
   * second charge is never created.
   */
  app.post('/paygate/charges', async (req, reply) => {
    const key = header(req, 'idempotency-key');
    if (!key) {
      return fail(reply, 400, 'missing_idempotency_key', 'Idempotency-Key header is required');
    }

    const parsed = ChargeBody.safeParse(req.body);
    if (!parsed.success) {
      return fail(reply, 422, 'invalid_body', issues(parsed.error));
    }
    const body = parsed.data;
    const fingerprint = Store.fingerprint(body);
    const correlationId = header(req, 'x-request-id');

    const existing = store.getIdempotency('charge', key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return fail(
          reply,
          409,
          'idempotency_key_reuse',
          'this Idempotency-Key was already used with a different request body',
        );
      }
      existing.replays += 1;
      const charge = store.charges.get(existing.resource_id);
      if (!charge) {
        // Unreachable: the charge is created in the same tick as its key.
        return fail(reply, 500, 'internal', 'idempotency record has no charge');
      }
      const recoveredFrom500 = existing.outcome === 'failed_500';
      if (recoveredFrom500) {
        existing.outcome = 'accepted';
        if (!charge.correlation_id) charge.correlation_id = correlationId;
        await materialiseCharge(charge);
      }
      req.log.info(
        {
          charge_id: charge.id,
          idempotency_key: key,
          replays: existing.replays,
          recovered_from_500: recoveredFrom500,
          correlation_id: charge.correlation_id,
        },
        'paygate.charge.replayed',
      );
      return reply.code(202).send({ charge_id: charge.id, status: 'processing' });
    }

    const plan = planFor(key, cfg);
    const chargeId = Store.newChargeId();
    const now = new Date().toISOString();

    const charge: Charge = {
      id: chargeId,
      reference: body.reference,
      amount_minor: body.amount_minor,
      currency: body.currency,
      idempotency_key: key,
      correlation_id: correlationId,
      status: 'processing',
      created_at: now,
      occurred_at: null,
      materialised: false,
      refunded_minor: 0,
      plan,
      deliveries: [],
      refund_ids: [],
      attempts: 0,
    };
    store.charges.set(chargeId, charge);
    store.putIdempotency({
      key,
      scope: 'charge',
      resource_id: chargeId,
      fingerprint,
      outcome: plan.transientFailure ? 'failed_500' : 'accepted',
      first_seen_at: now,
      replays: 0,
    });

    if (plan.transientFailure) {
      req.log.warn(
        {
          charge_id: chargeId,
          idempotency_key: key,
          chaos_branch: 'transient_failure',
          correlation_id: correlationId,
        },
        'paygate.charge.transient_failure',
      );
      return fail(
        reply,
        500,
        'provider_error',
        'temporary provider failure, retry with the same Idempotency-Key',
      );
    }

    req.log.info(
      {
        charge_id: chargeId,
        reference: charge.reference,
        amount_minor: charge.amount_minor,
        idempotency_key: key,
        chaos_branch: plan.timing,
        duplicate_delivery: plan.duplicateDelivery,
        clock_skew_seconds: plan.clockSkewSeconds,
        correlation_id: correlationId,
      },
      'paygate.charge.accepted',
    );

    await materialiseCharge(charge);
    return reply.code(202).send({ charge_id: chargeId, status: 'processing' });
  });

  /**
   * POST /paygate/refunds
   *
   * Same idempotency contract as charges. The transient-failure branch is not
   * applied here: the brief specifies that 10% of `POST /charges` return 500,
   * and inventing a second failure surface would make the API's refund path
   * harder to reason about without testing anything the brief asked for.
   */
  app.post('/paygate/refunds', async (req, reply) => {
    const key = header(req, 'idempotency-key');
    if (!key) {
      return fail(reply, 400, 'missing_idempotency_key', 'Idempotency-Key header is required');
    }

    const parsed = RefundBody.safeParse(req.body);
    if (!parsed.success) {
      return fail(reply, 422, 'invalid_body', issues(parsed.error));
    }
    const body = parsed.data;
    const fingerprint = Store.fingerprint(body);
    const correlationId = header(req, 'x-request-id');

    const existing = store.getIdempotency('refund', key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return fail(
          reply,
          409,
          'idempotency_key_reuse',
          'this Idempotency-Key was already used with a different request body',
        );
      }
      existing.replays += 1;
      const refund = store.refunds.get(existing.resource_id);
      if (!refund) return fail(reply, 500, 'internal', 'idempotency record has no refund');
      req.log.info(
        {
          refund_id: refund.id,
          charge_id: refund.charge_id,
          idempotency_key: key,
          replays: existing.replays,
        },
        'paygate.refund.replayed',
      );
      return reply
        .code(202)
        .send({ refund_id: refund.id, charge_id: refund.charge_id, status: 'processing' });
    }

    const charge = store.charges.get(body.charge_id);
    if (!charge || !charge.materialised) {
      return fail(reply, 404, 'unknown_charge', `no charge ${body.charge_id}`);
    }
    if (charge.status !== 'succeeded') {
      return fail(reply, 409, 'charge_not_refundable', `charge ${charge.id} is ${charge.status}`);
    }
    if (charge.refunded_minor + body.amount_minor > charge.amount_minor) {
      return fail(
        reply,
        422,
        'refund_exceeds_charge',
        `refunding ${body.amount_minor} would exceed the ${charge.amount_minor} captured (already refunded ${charge.refunded_minor})`,
      );
    }

    const plan = planFor(key, cfg);
    const refundId = Store.newRefundId();
    const now = new Date().toISOString();

    const refund: Refund = {
      id: refundId,
      charge_id: charge.id,
      reference: charge.reference,
      amount_minor: body.amount_minor,
      idempotency_key: key,
      correlation_id: correlationId ?? charge.correlation_id,
      status: 'processing',
      created_at: now,
      occurred_at: null,
      materialised: false,
      plan,
    };
    store.refunds.set(refundId, refund);
    charge.refund_ids.push(refundId);
    charge.refunded_minor += body.amount_minor;
    store.putIdempotency({
      key,
      scope: 'refund',
      resource_id: refundId,
      fingerprint,
      outcome: 'accepted',
      first_seen_at: now,
      replays: 0,
    });

    req.log.info(
      {
        refund_id: refundId,
        charge_id: charge.id,
        amount_minor: refund.amount_minor,
        idempotency_key: key,
        chaos_branch: plan.timing,
        duplicate_delivery: plan.duplicateDelivery,
        correlation_id: refund.correlation_id,
      },
      'paygate.refund.accepted',
    );

    await materialiseRefund(refund);
    return reply
      .code(202)
      .send({ refund_id: refundId, charge_id: charge.id, status: 'processing' });
  });

  /** The reviewer's window: the charge and every delivery attempt made for it. */
  app.get('/paygate/charges/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const charge = store.charges.get(id);
    if (!charge) return fail(reply, 404, 'unknown_charge', `no charge ${id}`);
    return chargeView(charge, store);
  });

  app.get('/paygate/refunds/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const refund = store.refunds.get(id);
    if (!refund) return fail(reply, 404, 'unknown_refund', `no refund ${id}`);
    const charge = store.charges.get(refund.charge_id);
    return {
      refund_id: refund.id,
      charge_id: refund.charge_id,
      reference: refund.reference,
      amount_minor: refund.amount_minor,
      status: refund.status,
      created_at: refund.created_at,
      occurred_at: refund.occurred_at,
      correlation_id: refund.correlation_id,
      chaos_plan: refund.plan,
      deliveries: (charge?.deliveries ?? []).filter((d) => d.refund_id === refund.id),
    };
  });

  // Outside the brief's spec. Off when PAYGATE_TEST_ENDPOINTS=off, and refused
  // outright under NODE_ENV=production — the check is repeated here, at the
  // point of registration, so the guard is visible where a reviewer looks for
  // it rather than only in config.ts.
  if (testRoutesEnabled) {
    registerTestRoutes(app, cfg, store, deliverer);
  } else if (cfg.production && cfg.testEndpointsRequested) {
    app.log.warn(
      'PAYGATE_TEST_ENDPOINTS=on was ignored: the /paygate/_test/* control surface does not register under NODE_ENV=production',
    );
  }

  app.addHook('onClose', async () => {
    deliverer.close();
  });

  return { app, store, deliverer };
}
