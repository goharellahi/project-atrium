import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { PaygateConfig } from './config.js';
import type { Ledger } from './ledger/index.js';
import { verify } from './signature.js';
import type { ChargeStatus } from './types.js';

/**
 * `POST /paygate/_ledger/import` — bulk-load charges that already happened.
 *
 * ## Why this exists at all
 *
 * The demo database contains twenty thousand settled bookings, and every one of
 * them implies a captured charge. Before P8 the seed simply invented
 * `ch_seed_<uuid>` for each, which meant the API believed in money the provider
 * had never heard of — so cancelling any seeded booking produced a refund the
 * provider answered `404 unknown_charge`.
 *
 * The obvious repair is for the seed to POST twenty thousand charges through
 * `/paygate/charges`. That is wrong twice over: the provider fails ten percent
 * of them on purpose, and every one it accepts dispatches a webhook that would
 * try to confirm a booking already confirmed, filling the audit trail with
 * illegal transitions. Seeding by side effect.
 *
 * These charges are not events to replay. They are **history to agree on**:
 * they captured, the API's ledger already records that they captured, and the
 * only thing ever missing was the provider's own row. So this route writes
 * rows, in batches, with no chaos plan drawn and no delivery dispatched.
 *
 * ## Why it is signed rather than gated behind PAYGATE_TEST_ENDPOINTS
 *
 * `/paygate/_test/*` is unauthenticated and therefore refuses to exist under
 * `NODE_ENV=production` — a route that forges signed webhooks has no business
 * in a production route table. This one is different in both directions: it
 * must work on the deployed instance, because that is exactly where the demo
 * data lives, and it can, because it authenticates.
 *
 * It uses the same HMAC over the same raw bytes with the same shared secret as
 * every webhook Paygate sends, in the opposite direction. No new credential, no
 * new mechanism, and the verification is the one already covered by tests. A
 * caller who cannot sign cannot import.
 *
 * Still an extension rather than part of the brief's §06 spec, and recorded as
 * one in `apps/paygate/README.md`.
 */

const ImportedCharge = z.object({
  id: z.string().min(1).max(120),
  reference: z.string().min(1).max(200),
  amount_minor: z.number().int().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  idempotency_key: z.string().min(1).max(200),
  status: z.enum(['succeeded', 'failed']),
  created_at: z.string().min(1),
  occurred_at: z.string().min(1),
  refunded_minor: z.number().int().nonnegative().default(0),
});

const ImportBody = z.object({
  // One request, many rows. The seed sends about twenty of these rather than
  // twenty thousand requests.
  charges: z.array(ImportedCharge).min(1).max(2000),
});

function fail(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.code(status).send({ error: { code, message } });
}

export function registerLedgerImport(
  app: FastifyInstance,
  cfg: PaygateConfig,
  ledger: Ledger,
): void {
  app.post('/paygate/_ledger/import', async (req, reply) => {
    // Verified over the exact bytes received, for the same reason Paygate signs
    // over the exact bytes it sends: a re-serialised object is a different
    // string, and an HMAC that sometimes matches is worse than none.
    const raw = (req.body as { raw?: string } | undefined)?.raw;
    if (typeof raw !== 'string') {
      return fail(reply, 400, 'invalid_body', 'expected a JSON body');
    }

    const signature = req.headers['x-paygate-signature'];
    if (typeof signature !== 'string' || !verify(raw, cfg.secret, signature)) {
      req.log.warn('paygate.ledger_import.bad_signature');
      return fail(reply, 401, 'bad_signature', 'X-Paygate-Signature did not verify');
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      return fail(reply, 400, 'invalid_body', 'body is not valid JSON');
    }

    const parsed = ImportBody.safeParse(parsedJson);
    if (!parsed.success) {
      return fail(
        reply,
        422,
        'invalid_body',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    }

    const written = await ledger.importCharges(
      parsed.data.charges.map((c) => ({
        id: c.id,
        reference: c.reference,
        amountMinor: c.amount_minor,
        currency: c.currency,
        idempotencyKey: c.idempotency_key,
        status: c.status as ChargeStatus,
        createdAt: new Date(c.created_at),
        occurredAt: new Date(c.occurred_at),
        refundedMinor: c.refunded_minor,
      })),
    );

    req.log.info(
      { received: parsed.data.charges.length, written },
      'paygate.ledger_import.applied',
    );

    // `received` and `written` differ when a row was already there. Both are
    // reported rather than just the total, so a re-seed reads as idempotent
    // rather than as a silent no-op.
    return reply.code(200).send({ received: parsed.data.charges.length, written });
  });
}
