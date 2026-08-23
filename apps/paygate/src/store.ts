import { createHash, randomUUID } from 'node:crypto';
import type { Charge, DeliveryRecord, IdempotencyRecord, Refund } from './types.js';

/**
 * Paygate's state, in memory.
 *
 * Deliberate: Paygate is a test double, not a system of record. Restarting it
 * between runs *should* wipe it, and giving it a database would invite the
 * reviewer to believe the API's payment integrity depends on the provider
 * remembering things. It does not — the exactly-once effect (INV-3) is the
 * API's job, enforced in Postgres. Paygate's only obligations are the
 * idempotency contract and the chaos.
 */
export class Store {
  readonly charges = new Map<string, Charge>();
  readonly refunds = new Map<string, Refund>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();

  /** Charges whose next delivery has been forced late by /_test/delay. */
  private readonly forcedDelays = new Map<string, number>();
  /** A global armed-once forced delay, when /_test/delay names no charge. */
  private globalForcedDelayMs: number | null = null;

  // -- idempotency ---------------------------------------------------------

  static fingerprint(body: unknown): string {
    return createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 32);
  }

  idempotencyKey(scope: IdempotencyRecord['scope'], key: string): string {
    return `${scope}:${key}`;
  }

  getIdempotency(scope: IdempotencyRecord['scope'], key: string): IdempotencyRecord | undefined {
    return this.idempotency.get(this.idempotencyKey(scope, key));
  }

  putIdempotency(record: IdempotencyRecord): void {
    this.idempotency.set(this.idempotencyKey(record.scope, record.key), record);
  }

  // -- ids -----------------------------------------------------------------

  static newChargeId(): string {
    return `ch_${randomUUID().replace(/-/g, '')}`;
  }

  static newRefundId(): string {
    return `re_${randomUUID().replace(/-/g, '')}`;
  }

  // -- deliveries ----------------------------------------------------------

  /**
   * Delivery history hangs off the charge, including refund deliveries, so
   * `GET /paygate/charges/:id` shows a reviewer everything that happened to
   * that charge's money in one response.
   */
  recordDelivery(chargeId: string, record: DeliveryRecord): void {
    this.charges.get(chargeId)?.deliveries.push(record);
  }

  nextAttempt(chargeId: string): number {
    const charge = this.charges.get(chargeId);
    if (!charge) return 1;
    charge.attempts += 1;
    return charge.attempts;
  }

  // -- forced delay (test control surface) ---------------------------------

  armForcedDelay(chargeId: string | null, delayMs: number): void {
    if (chargeId) this.forcedDelays.set(chargeId, delayMs);
    else this.globalForcedDelayMs = delayMs;
  }

  /** Consumes the forced delay, if one is armed. Fires once, then disarms. */
  takeForcedDelay(chargeId: string): number | null {
    const perCharge = this.forcedDelays.get(chargeId);
    if (perCharge !== undefined) {
      this.forcedDelays.delete(chargeId);
      return perCharge;
    }
    if (this.globalForcedDelayMs !== null) {
      const ms = this.globalForcedDelayMs;
      this.globalForcedDelayMs = null;
      return ms;
    }
    return null;
  }
}
