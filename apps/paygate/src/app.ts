import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { planFor, type ChaosPlan } from './chaos.js';
import type { PaygateConfig } from './config.js';
import { Deliverer, type DeliveryRequest } from './delivery.js';
import {
  ForcedDelays,
  createLedger,
  fingerprintOf,
  type Ledger,
} from './ledger/index.js';
import { registerLedgerImport } from './ledger-import.js';
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
async function chargeView(charge: Charge, ledger: Ledger) {
  const [refunds, deliveries] = await Promise.all([
    ledger.refundsFor(charge.id),
    ledger.deliveriesFor(charge.id),
  ]);

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
    refunds: refunds.map((r: Refund) => ({
      refund_id: r.id,
      amount_minor: r.amount_minor,
      status: r.status,
      created_at: r.created_at,
      occurred_at: r.occurred_at,
      correlation_id: r.correlation_id,
    })),
    deliveries,
  };
}

export interface PaygateApp {
  app: FastifyInstance;
  ledger: Ledger;
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

  /**
   * When this process started.
   *
   * On /health so a reviewer can tell a provider that has been up all along
   * from one that woke thirty seconds ago — which on a free tier that sleeps
   * after fifteen idle minutes is the difference between "the webhook is late"
   * and "the webhook was never going to arrive". It is also what lets
   * `provider-restart.e2e.test.ts` prove the restart it depends on actually
   * happened, rather than passing because a `docker compose restart` quietly
   * did nothing.
   */
  const startedAt = new Date().toISOString();

  const ledger = createLedger(cfg, (msg) => app.log.info(msg));
  const forcedDelays = new ForcedDelays();
  const deliverer = new Deliverer(cfg, app.log, ledger);

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
    const forced = forcedDelays.take(opts.chargeId);
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
    // Paygate never declines at random. A random decline in the middle of a
    // concurrency proof is indistinguishable from a real bug, and the brief's
    // chaos table does not ask for one. Declines are triggered by amount.
    const status = charge.amount_minor === cfg.declineAmountMinor ? 'failed' : 'succeeded';
    const occurredAt = new Date(Date.now() - charge.plan.clockSkewSeconds * 1000);

    // The guard moved into the ledger, and it had to. `if (charge.materialised)
    // return` reads a value that may already be stale by the time it is read;
    // the ledger's conditional UPDATE decides it once, and returns nothing to
    // the loser. That is what stops a 500-then-retry dispatching two sets of
    // webhooks for one charge.
    const settled = await ledger.materialiseCharge(charge.id, status, occurredAt);
    if (!settled) return;

    await dispatch({
      chargeId: settled.id,
      reference: settled.reference,
      event: settled.status === 'succeeded' ? 'charge.succeeded' : 'charge.failed',
      amountMinor: settled.amount_minor,
      occurredAt: settled.occurred_at!,
      refundId: null,
      idempotencyKey: settled.idempotency_key,
      correlationId: settled.correlation_id,
      plan: settled.plan,
    });
  }

  async function materialiseRefund(refund: Refund): Promise<void> {
    const occurredAt = new Date(Date.now() - refund.plan.clockSkewSeconds * 1000);
    const settled = await ledger.materialiseRefund(refund.id, occurredAt);
    if (!settled) return;

    await dispatch({
      chargeId: settled.charge_id,
      reference: settled.reference,
      event: 'refund.succeeded',
      amountMinor: settled.amount_minor,
      occurredAt: settled.occurred_at!,
      refundId: settled.id,
      idempotencyKey: settled.idempotency_key,
      correlationId: settled.correlation_id,
      plan: settled.plan,
    });
  }

  // -- routes --------------------------------------------------------------

  app.get('/health', async () => {
    const counts = await ledger.counts();
    return {
      status: 'ok',
      service: 'paygate',
      chaos: cfg.chaos ? 'on' : 'off',
      seed: cfg.seed,
      callback_url_configured: cfg.callbackUrl !== null,
      test_endpoints: testRoutesEnabled ? 'on' : 'off',
      // Reported, because "does this provider remember anything" is the first
      // thing a reviewer needs to know about it and the answer used to be no.
      store: ledger.kind,
      durable: ledger.kind === 'postgres',
      started_at: startedAt,
      charges: counts.charges,
      refunds: counts.refunds,
    };
  });

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
    const correlationId = header(req, 'x-request-id');
    const plan = planFor(key, cfg);

    /**
     * One call, and the claim and the insert are inside it.
     *
     * The previous shape — read the idempotency map, branch, then write — was
     * safe only because Node does not interleave between those statements. The
     * ledger makes the claim a single atomic operation, so two concurrent
     * requests carrying the same key produce one charge and one replay under
     * Postgres exactly as they did in memory, rather than by luck.
     */
    const opened = await ledger.openCharge({
      reference: body.reference,
      amountMinor: body.amount_minor,
      currency: body.currency,
      idempotencyKey: key,
      fingerprint: fingerprintOf(body),
      correlationId,
      plan,
    });

    if (opened.outcome === 'fingerprint_mismatch') {
      return fail(
        reply,
        409,
        'idempotency_key_reuse',
        'this Idempotency-Key was already used with a different request body',
      );
    }

    if (opened.outcome === 'replayed') {
      const { charge, record } = opened;
      const recoveredFrom500 = record.outcome === 'failed_500';
      if (recoveredFrom500) {
        await ledger.recoverFromTransientFailure(charge.id, key, correlationId);
        await materialiseCharge(charge);
      }
      req.log.info(
        {
          charge_id: charge.id,
          idempotency_key: key,
          replays: record.replays,
          recovered_from_500: recoveredFrom500,
          correlation_id: charge.correlation_id ?? correlationId,
        },
        'paygate.charge.replayed',
      );
      return reply.code(202).send({ charge_id: charge.id, status: 'processing' });
    }

    const charge = opened.charge;

    if (plan.transientFailure) {
      req.log.warn(
        {
          charge_id: charge.id,
          idempotency_key: key,
          chaos_branch: 'transient_failure',
          correlation_id: correlationId,
        },
        'paygate.charge.transient_failure',
      );
      // The charge row and its idempotency claim are already committed, which
      // is the entire contract: the id survives the 500, so the retry finds it
      // and brings it to life instead of minting a second charge.
      return fail(
        reply,
        500,
        'provider_error',
        'temporary provider failure, retry with the same Idempotency-Key',
      );
    }

    req.log.info(
      {
        charge_id: charge.id,
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
    return reply.code(202).send({ charge_id: charge.id, status: 'processing' });
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
    const correlationId = header(req, 'x-request-id');
    const plan = planFor(key, cfg);

    // Claim, refundability check and amount reservation, in one transaction
    // with the charge row locked. See `PostgresLedger.openRefund` for why the
    // read-modify-write on `refunded_minor` cannot be left unlocked.
    const opened = await ledger.openRefund({
      chargeId: body.charge_id,
      amountMinor: body.amount_minor,
      idempotencyKey: key,
      fingerprint: fingerprintOf(body),
      correlationId,
      plan,
    });

    switch (opened.outcome) {
      case 'fingerprint_mismatch':
        return fail(
          reply,
          409,
          'idempotency_key_reuse',
          'this Idempotency-Key was already used with a different request body',
        );

      case 'unknown_charge':
        return fail(reply, 404, 'unknown_charge', `no charge ${body.charge_id}`);

      case 'not_refundable':
        return fail(
          reply,
          409,
          'charge_not_refundable',
          `charge ${body.charge_id} is ${opened.status}`,
        );

      case 'exceeds_charge':
        return fail(
          reply,
          422,
          'refund_exceeds_charge',
          `refunding ${body.amount_minor} would exceed the ${opened.chargeAmountMinor} captured (already refunded ${opened.refundedMinor})`,
        );

      case 'replayed':
        req.log.info(
          {
            refund_id: opened.refund.id,
            charge_id: opened.refund.charge_id,
            idempotency_key: key,
            replays: opened.record.replays,
          },
          'paygate.refund.replayed',
        );
        return reply.code(202).send({
          refund_id: opened.refund.id,
          charge_id: opened.refund.charge_id,
          status: 'processing',
        });

      case 'created': {
        const refund = opened.refund;
        req.log.info(
          {
            refund_id: refund.id,
            charge_id: refund.charge_id,
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
          .send({ refund_id: refund.id, charge_id: refund.charge_id, status: 'processing' });
      }
    }
  });

  /** The reviewer's window: the charge and every delivery attempt made for it. */
  app.get('/paygate/charges/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const charge = await ledger.getCharge(id);
    if (!charge) return fail(reply, 404, 'unknown_charge', `no charge ${id}`);
    return chargeView(charge, ledger);
  });

  app.get('/paygate/refunds/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const refund = await ledger.getRefund(id);
    if (!refund) return fail(reply, 404, 'unknown_refund', `no refund ${id}`);
    const deliveries = await ledger.deliveriesFor(refund.charge_id);
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
      deliveries: deliveries.filter((d) => d.refund_id === refund.id),
    };
  });

  /**
   * The signed bulk import, in its own encapsulated scope.
   *
   * Fastify encapsulates `addContentTypeParser` per plugin, which is what lets
   * this one route receive the raw bytes while every other route keeps the
   * parsed body it expects. The signature has to be checked against the exact
   * string that arrived — see `ledger-import.ts`.
   *
   * Registered unconditionally, including under NODE_ENV=production, because it
   * authenticates. That is the difference between it and `/_test/*`.
   */
  void app.register(async (scoped) => {
    scoped.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
      done(null, { raw: typeof body === 'string' ? body : body.toString('utf8') });
    });
    registerLedgerImport(scoped, cfg, ledger);
  });

  // Outside the brief's spec. Off when PAYGATE_TEST_ENDPOINTS=off, and refused
  // outright under NODE_ENV=production — the check is repeated here, at the
  // point of registration, so the guard is visible where a reviewer looks for
  // it rather than only in config.ts.
  if (testRoutesEnabled) {
    registerTestRoutes(app, cfg, ledger, forcedDelays, deliverer);
  } else if (cfg.production && cfg.testEndpointsRequested) {
    app.log.warn(
      'PAYGATE_TEST_ENDPOINTS=on was ignored: the /paygate/_test/* control surface does not register under NODE_ENV=production',
    );
  }

  app.addHook('onClose', async () => {
    deliverer.close();
    await ledger.close();
  });

  return { app, ledger, deliverer };
}
