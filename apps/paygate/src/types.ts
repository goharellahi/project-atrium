import type { ChaosPlan, TimingBranch } from './chaos.js';

export type ChargeStatus = 'processing' | 'succeeded' | 'failed';
export type RefundStatus = 'processing' | 'succeeded';

/**
 * The three webhook events.
 *
 * The brief names only `charge.succeeded`. `charge.failed` and
 * `refund.succeeded` are a documented extension: without them the API has no
 * way to reach its FAILED state, and INV-4 (expired hold, payment succeeded,
 * money automatically refunded) has no evidence that the refund actually
 * settled. Recorded in PLAN.md.
 */
export type WebhookEvent = 'charge.succeeded' | 'charge.failed' | 'refund.succeeded';

/** The webhook payload. `refund_id` is present only on refund.succeeded. */
export interface WebhookBody {
  charge_id: string;
  reference: string;
  event: WebhookEvent;
  amount_minor: number;
  occurred_at: string;
  refund_id?: string;
}

/** One delivery attempt, recorded whether it succeeded, failed or was skipped. */
export interface DeliveryRecord {
  delivery_id: string;
  charge_id: string;
  refund_id: string | null;
  event: WebhookEvent;
  /** 1 for the original, 2 for the duplicate, 3+ for forced test deliveries. */
  attempt: number;
  /** Which chaos branch produced this attempt. */
  branch: TimingBranch | 'duplicate' | 'forced';
  /** True when the 2% bad-signature branch fired for this attempt. */
  signature_corrupted: boolean;
  scheduled_delay_ms: number;
  occurred_at: string;
  sent_at: string | null;
  response_status: number | null;
  duration_ms: number | null;
  error: string | null;
  correlation_id: string | null;
}

export interface Charge {
  id: string;
  reference: string;
  amount_minor: number;
  currency: string;
  idempotency_key: string;
  /** X-Request-Id from the charge request, echoed on every webhook for it. */
  correlation_id: string | null;
  status: ChargeStatus;
  created_at: string;
  /** Null until the outcome is decided (i.e. while a 500 is outstanding). */
  occurred_at: string | null;
  /** False until the first successful POST /charges; a 500 leaves it false. */
  materialised: boolean;
  refunded_minor: number;
  plan: ChaosPlan;
  deliveries: DeliveryRecord[];
  refund_ids: string[];
  /** Delivery attempts issued so far, including forced test deliveries. */
  attempts: number;
}

export interface Refund {
  id: string;
  charge_id: string;
  reference: string;
  amount_minor: number;
  idempotency_key: string;
  correlation_id: string | null;
  status: RefundStatus;
  created_at: string;
  occurred_at: string | null;
  materialised: boolean;
  plan: ChaosPlan;
}

/**
 * What a given Idempotency-Key resolved to.
 *
 * `failed_500` matters: the key is recorded *before* the transient-failure
 * branch is taken, so the charge id survives the 500 and the retry returns that
 * same id instead of minting a second charge.
 */
export interface IdempotencyRecord {
  key: string;
  scope: 'charge' | 'refund';
  /** Charge id, or refund id for the refund scope. */
  resource_id: string;
  /** Hash of the request body, so key reuse with a different body is caught. */
  fingerprint: string;
  outcome: 'accepted' | 'failed_500';
  first_seen_at: string;
  replays: number;
}
