import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { PaygateConfig } from './config.js';
import { corruptSignatureFor } from './chaos.js';
import { corrupt, sign } from './signature.js';
import type { Ledger } from './ledger/index.js';
import type { DeliveryRecord, WebhookBody, WebhookEvent } from './types.js';

export interface DeliveryRequest {
  chargeId: string;
  reference: string;
  event: WebhookEvent;
  amountMinor: number;
  occurredAt: string;
  refundId: string | null;
  /** Which chaos branch produced this attempt — for the log and the history. */
  branch: DeliveryRecord['branch'];
  /** Idempotency key of the charge or refund, for the seeded signature draw. */
  idempotencyKey: string;
  correlationId: string | null;
  /** Scheduled delay already applied before this call, for the record. */
  scheduledDelayMs: number;
  /**
   * Override the seeded 2% bad-signature draw. Only the /_test/ control
   * surface sets this; normal traffic passes null and takes the seeded branch.
   */
  forceCorruptSignature: boolean | null;
}

/**
 * Sends webhooks and remembers every attempt.
 *
 * Two things here are load-bearing:
 *
 * 1. The payload is serialised exactly once and that string is both signed and
 *    sent. See `signature.ts`.
 * 2. Every attempt is recorded and logged before the result is known, so a
 *    delivery that times out or hits a dead callback still leaves a trace. A
 *    silent drop in the provider looks exactly like a bug in the API.
 */
export class Deliverer {
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private closed = false;

  constructor(
    private readonly cfg: PaygateConfig,
    private readonly log: FastifyBaseLogger,
    private readonly ledger: Ledger,
  ) {}

  /** Deliver now, awaited. Used by the race-on-response branch and /_test/deliver. */
  async deliver(req: DeliveryRequest): Promise<DeliveryRecord> {
    const attempt = await this.ledger.nextAttempt(req.chargeId);
    const deliveryId = randomUUID();
    const signatureCorrupted =
      req.forceCorruptSignature ?? corruptSignatureFor(req.idempotencyKey, attempt, this.cfg);

    const body: WebhookBody = {
      charge_id: req.chargeId,
      reference: req.reference,
      event: req.event,
      amount_minor: req.amountMinor,
      occurred_at: req.occurredAt,
      ...(req.refundId ? { refund_id: req.refundId } : {}),
    };

    // Serialise once. This exact string is what gets signed and what gets sent.
    const raw = JSON.stringify(body);
    const honest = sign(raw, this.cfg.secret);
    const signature = signatureCorrupted ? corrupt(honest) : honest;

    const record: DeliveryRecord = {
      delivery_id: deliveryId,
      charge_id: req.chargeId,
      refund_id: req.refundId,
      event: req.event,
      attempt,
      branch: req.branch,
      signature_corrupted: signatureCorrupted,
      scheduled_delay_ms: req.scheduledDelayMs,
      occurred_at: req.occurredAt,
      sent_at: null,
      response_status: null,
      duration_ms: null,
      error: null,
      correlation_id: req.correlationId,
    };
    // Written before the call goes out, so an attempt that times out — or that
    // this process dies half way through — still leaves a row. A silent drop
    // inside the provider is indistinguishable from a bug in the API, and this
    // row is where a reviewer settles that argument.
    await this.ledger.recordDelivery(record);

    if (!this.cfg.callbackUrl) {
      record.error = 'no callback url configured (PAYGATE_CALLBACK_URL / PAYGATE_WEBHOOK_URL)';
      await this.ledger.finishDelivery(record);
      this.log.error({ delivery: record }, 'paygate.delivery.skipped');
      return record;
    }

    const startedAt = Date.now();
    record.sent_at = new Date(startedAt).toISOString();

    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-paygate-signature': signature,
        'x-paygate-delivery': deliveryId,
      };
      // The brief's Tier-2 requirement: a correlation id that survives into the
      // webhook path. Read off the original charge request, echoed here.
      if (req.correlationId) headers['x-request-id'] = req.correlationId;

      const res = await fetch(this.cfg.callbackUrl, {
        method: 'POST',
        headers,
        body: raw,
        signal: AbortSignal.timeout(this.cfg.deliveryTimeoutMs),
      });
      record.response_status = res.status;
      record.duration_ms = Date.now() - startedAt;
    } catch (err) {
      record.error = err instanceof Error ? err.message : String(err);
      record.duration_ms = Date.now() - startedAt;
    }

    await this.ledger.finishDelivery(record);

    this.log.info(
      {
        charge_id: record.charge_id,
        refund_id: record.refund_id,
        delivery_id: record.delivery_id,
        attempt: record.attempt,
        event: record.event,
        chaos_branch: record.branch,
        signature_corrupted: record.signature_corrupted,
        scheduled_delay_ms: record.scheduled_delay_ms,
        response_status: record.response_status,
        duration_ms: record.duration_ms,
        error: record.error,
        correlation_id: record.correlation_id,
      },
      'paygate.delivery.attempt',
    );

    return record;
  }

  /** Deliver after `delayMs`. Fire and forget; failures are logged, never thrown. */
  schedule(req: DeliveryRequest, delayMs: number): void {
    if (this.closed) return;

    if (delayMs <= 0) {
      this.track(this.deliver(req));
      return;
    }

    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.track(this.deliver(req));
    }, delayMs);
    // Do not hold the event loop open for a 90-second delayed delivery.
    timer.unref();
    this.timers.add(timer);
  }

  private track(p: Promise<unknown>): void {
    const wrapped = p.catch((err: unknown) => {
      this.log.error({ err }, 'paygate.delivery.unhandled');
    });
    this.inFlight.add(wrapped);
    void wrapped.finally(() => this.inFlight.delete(wrapped));
  }

  /** Await every delivery already sent. Used by tests, not by the server. */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight]);
    }
  }

  close(): void {
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}
