import { BadGatewayException, ServiceUnavailableException } from '@nestjs/common';
import { log } from '../common/logger';
import type { Env } from '../config/env';
import type {
  ChargeAccepted,
  ChargeState,
  ChargeRequest,
  PaymentProvider,
  RefundAccepted,
  RefundRequest,
  RefundState,
} from './payment-provider';

/**
 * The real client for the Paygate provider (apps/paygate).
 *
 * Deliberately thin. It speaks HTTP, propagates the idempotency key and the
 * correlation id, and translates transport failures into exceptions the caller
 * can act on. It contains **no retry loop**, and that is the important decision:
 *
 * Paygate's 10% transient-failure branch returns 500 with the charge already
 * recorded against the idempotency key. A retry inside this client would
 * therefore succeed — and would also hide, from the caller and from the audit
 * trail, that the first attempt failed. The caller instead leaves the payments
 * row PENDING with its key persisted, returns the failure to the client, and a
 * later retry (from the customer, or from the reconciler) reuses the same key
 * and adopts the same charge. That is the same guarantee, made visible.
 *
 * Note what `charge()` resolves with: ACCEPTED, never SUCCEEDED. The terminal
 * outcome arrives by webhook, and 25% of the time that webhook lands BEFORE
 * this response does. Any client that returned a terminal status here would be
 * modelling a provider that does not exist.
 */
export class PaygateClient implements PaymentProvider {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(env: Env) {
    if (!env.PAYGATE_BASE_URL) {
      throw new Error('PAYGATE_BASE_URL is required to talk to the payment provider');
    }
    this.baseUrl = env.PAYGATE_BASE_URL.replace(/\/$/, '');
    this.timeoutMs = env.PAYGATE_TIMEOUT_MS;
  }

  async charge(request: ChargeRequest): Promise<ChargeAccepted> {
    const body = await this.post<{ charge_id: string }>(
      '/paygate/charges',
      request.idempotencyKey,
      request.correlationId,
      {
        amount_minor: Number(request.amountMinor),
        currency: request.currency,
        // Paygate echoes `reference` on every webhook. It is the booking id,
        // which is what lets a delivery for a charge we have not recorded yet
        // still be tied to a booking. See PaymentsService.ingest.
        reference: request.bookingId,
      },
    );

    return { chargeId: body.charge_id, status: 'ACCEPTED' };
  }

  async refund(request: RefundRequest): Promise<RefundAccepted> {
    const body = await this.post<{ refund_id: string }>(
      '/paygate/refunds',
      request.idempotencyKey,
      request.correlationId,
      {
        charge_id: request.chargeId,
        amount_minor: Number(request.amountMinor),
      },
    );

    return { refundId: body.refund_id, status: 'ACCEPTED' };
  }

  /**
   * Read a refund's current state. Returns null if Paygate has never heard of
   * it, which is itself an answer worth having.
   */
  async getRefund(refundId: string): Promise<RefundState | null> {
    const body = await this.get<{
      id: string;
      charge_id: string;
      amount_minor: number;
      status: 'processing' | 'succeeded';
    }>(`/paygate/refunds/${refundId}`);

    if (body === null) return null;

    return {
      refundId: body.id,
      chargeId: body.charge_id,
      amountMinor: BigInt(body.amount_minor),
      status: body.status,
    };
  }

  /** Read a charge's current state. Null if Paygate has no record of it. */
  async getCharge(chargeId: string): Promise<ChargeState | null> {
    const body = await this.get<{
      id: string;
      reference: string;
      amount_minor: number;
      status: 'processing' | 'succeeded' | 'failed';
    }>(`/paygate/charges/${chargeId}`);

    if (body === null) return null;

    return {
      chargeId: body.id,
      reference: body.reference,
      amountMinor: BigInt(body.amount_minor),
      status: body.status,
    };
  }

  private async get<T>(path: string): Promise<T | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, { signal: controller.signal });

      // 404 is an answer, not a failure: the provider has never heard of it.
      if (response.status === 404) return null;
      if (!response.ok) {
        throw new BadGatewayException(`paygate lookup ${path} failed ${response.status}`);
      }
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private async post<T>(
    path: string,
    idempotencyKey: string,
    correlationId: string,
    payload: Record<string, unknown>,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'Idempotency-Key': idempotencyKey,
          'X-Request-Id': correlationId,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      // A timeout is NOT a failed charge. Paygate may have accepted it and be
      // about to deliver a webhook. Saying so plainly matters: the caller must
      // leave the payments row in place, key and all, rather than deleting it
      // and letting a retry mint a second charge.
      log().warn(
        { path, idempotencyKey, err: err instanceof Error ? err.message : String(err) },
        'paygate.request.transport_failure',
      );
      throw new ServiceUnavailableException({
        statusCode: 503,
        error: 'Service Unavailable',
        message:
          'The payment provider did not respond. The charge may still have been accepted; retry with the same booking and it will not be charged twice.',
        idempotency_key: idempotencyKey,
      });
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();

    if (!response.ok) {
      log().warn(
        { path, idempotencyKey, status: response.status, body: text },
        'paygate.request.rejected',
      );
      throw new BadGatewayException({
        statusCode: 502,
        error: 'Bad Gateway',
        message: 'The payment provider rejected the request',
        provider_status: response.status,
        provider_body: safeJson(text),
        idempotency_key: idempotencyKey,
      });
    }

    return JSON.parse(text) as T;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
