import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { PaygateConfig } from './config.js';
import type { Deliverer } from './delivery.js';
import type { Store } from './store.js';
import type { DeliveryRecord, WebhookEvent } from './types.js';

/**
 * The deterministic control surface — NOT part of the brief's §06 spec.
 *
 * A deliberate addition, so the API's INV-3 and INV-4 tests can force the
 * scenario they are testing instead of waiting for a 30% branch to fire. A
 * chaos rate is a property of the population, not of any one run; a test that
 * depends on a coin landing heads is not a test.
 *
 * Kept in its own module, behind PAYGATE_TEST_ENDPOINTS, so the line between
 * "the provider the brief specified" and "scaffolding I added" is a file
 * boundary rather than a comment. Set the flag to `off` and these routes do not
 * exist at all.
 */

const TestDeliverBody = z.object({
  charge_id: z.string().min(1),
  event: z.enum(['charge.succeeded', 'charge.failed', 'refund.succeeded']).optional(),
  amount_minor: z.number().int().positive().optional(),
  occurred_at: z.string().min(1).optional(),
  refund_id: z.string().min(1).optional(),
  /** How many deliveries to send, each with a fresh X-Paygate-Delivery. */
  times: z.number().int().min(1).max(10).default(1),
  /** Force (or forbid) the bad-signature branch instead of the seeded draw. */
  corrupt_signature: z.boolean().optional(),
});

const TestDelayBody = z.object({
  /** Omit to arm a one-shot delay for whichever charge delivers next. */
  charge_id: z.string().min(1).optional(),
  seconds: z.number().min(0).max(600).default(75),
});

function fail(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.code(status).send({ error: { code, message } });
}

function issues(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

export function registerTestRoutes(
  app: FastifyInstance,
  _cfg: PaygateConfig,
  store: Store,
  deliverer: Deliverer,
): void {
  /** Force a specific event for a charge, right now. */
  app.post('/paygate/_test/deliver', async (req, reply) => {
    const parsed = TestDeliverBody.safeParse(req.body);
    if (!parsed.success) return fail(reply, 422, 'invalid_body', issues(parsed.error));
    const body = parsed.data;

    const charge = store.charges.get(body.charge_id);
    if (!charge) return fail(reply, 404, 'unknown_charge', `no charge ${body.charge_id}`);

    const refund = body.refund_id ? store.refunds.get(body.refund_id) : undefined;
    if (body.refund_id && !refund) {
      return fail(reply, 404, 'unknown_refund', `no refund ${body.refund_id}`);
    }

    const fallbackEvent: WebhookEvent = refund
      ? 'refund.succeeded'
      : charge.status === 'failed'
        ? 'charge.failed'
        : 'charge.succeeded';
    const event: WebhookEvent = body.event ?? fallbackEvent;
    const amountMinor = body.amount_minor ?? refund?.amount_minor ?? charge.amount_minor;
    const occurredAt = body.occurred_at ?? new Date().toISOString();

    const records: DeliveryRecord[] = [];
    for (let i = 0; i < body.times; i++) {
      records.push(
        await deliverer.deliver({
          chargeId: charge.id,
          reference: charge.reference,
          event,
          amountMinor,
          occurredAt,
          refundId: refund?.id ?? null,
          idempotencyKey: charge.idempotency_key,
          correlationId: charge.correlation_id,
          branch: 'forced',
          scheduledDelayMs: 0,
          forceCorruptSignature: body.corrupt_signature ?? null,
        }),
      );
    }
    return reply.code(200).send({ delivered: records.length, deliveries: records });
  });

  /**
   * Arm a one-shot late delivery — INV-4 without waiting 60 real seconds.
   *
   * Omitting charge_id arms it globally for whichever charge dispatches next,
   * which is how a test parks a webhook before it knows the charge id.
   */
  app.post('/paygate/_test/delay', async (req, reply) => {
    const parsed = TestDelayBody.safeParse(req.body);
    if (!parsed.success) return fail(reply, 422, 'invalid_body', issues(parsed.error));
    const { charge_id, seconds } = parsed.data;
    const delayMs = Math.round(seconds * 1000);
    store.armForcedDelay(charge_id ?? null, delayMs);
    req.log.warn({ charge_id: charge_id ?? null, delay_ms: delayMs }, 'paygate.test.delay_armed');
    return reply.code(200).send({ armed: true, charge_id: charge_id ?? null, delay_ms: delayMs });
  });
}
