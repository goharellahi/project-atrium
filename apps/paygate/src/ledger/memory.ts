import type { ChaosPlan } from '../chaos.js';
import type {
  Charge,
  ChargeStatus,
  DeliveryRecord,
  IdempotencyRecord,
  Refund,
} from '../types.js';
import {
  newChargeId,
  newRefundId,
  type ImportedCharge,
  type Ledger,
  type OpenChargeInput,
  type OpenChargeResult,
  type OpenRefundInput,
  type OpenRefundResult,
} from './ledger.js';

/**
 * The in-memory ledger, kept deliberately and demoted deliberately.
 *
 * It is no longer the default and no longer the design — `PAYGATE_STORE=memory`
 * selects it, and `/health` says which one is running so a reviewer never has to
 * guess. What it is still good for is the 39 unit tests in `apps/paygate/test`,
 * which assert the idempotency contract and the chaos rates. Durability buys
 * those nothing, and a database would cost them the sub-second feedback that
 * makes them worth running.
 *
 * It is a faithful stand-in rather than a simplified one: same interface, same
 * outcomes, same ordering. The one thing it cannot reproduce is the thing it was
 * wrong about — surviving a restart — and that is asserted in the e2e suite
 * against the real ledger, where it belongs.
 *
 * Note what does NOT need locking here and does in Postgres. Node runs one
 * request at a time between awaits, so the read-modify-write in `openRefund` is
 * atomic by construction. That accident is exactly what made the in-memory
 * version look correct, and is why `PostgresLedger` takes `FOR UPDATE` where
 * this takes nothing.
 */
export class MemoryLedger implements Ledger {
  readonly kind = 'memory' as const;

  private readonly charges = new Map<string, Charge>();
  private readonly refunds = new Map<string, Refund>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();

  async init(): Promise<void> {
    /* nothing to migrate */
  }

  async close(): Promise<void> {
    /* nothing to close */
  }

  async counts(): Promise<{ charges: number; refunds: number }> {
    return { charges: this.charges.size, refunds: this.refunds.size };
  }

  async getCharge(id: string): Promise<Charge | null> {
    return this.charges.get(id) ?? null;
  }

  async getRefund(id: string): Promise<Refund | null> {
    return this.refunds.get(id) ?? null;
  }

  async refundsFor(chargeId: string): Promise<Refund[]> {
    const charge = this.charges.get(chargeId);
    if (!charge) return [];
    return charge.refund_ids
      .map((id) => this.refunds.get(id))
      .filter((r): r is Refund => r !== undefined);
  }

  async deliveriesFor(chargeId: string): Promise<DeliveryRecord[]> {
    return this.charges.get(chargeId)?.deliveries ?? [];
  }

  async openCharge(input: OpenChargeInput): Promise<OpenChargeResult> {
    const slot = `charge:${input.idempotencyKey}`;
    const existing = this.idempotency.get(slot);

    if (existing) {
      if (existing.fingerprint !== input.fingerprint) return { outcome: 'fingerprint_mismatch' };
      existing.replays += 1;
      const charge = this.charges.get(existing.resource_id);
      if (!charge) throw new Error(`idempotency record has no charge ${existing.resource_id}`);
      return { outcome: 'replayed', charge, record: { ...existing } };
    }

    const chargeId = newChargeId();
    const now = new Date().toISOString();

    const charge: Charge = {
      id: chargeId,
      reference: input.reference,
      amount_minor: input.amountMinor,
      currency: input.currency,
      idempotency_key: input.idempotencyKey,
      correlation_id: input.correlationId,
      status: 'processing',
      created_at: now,
      occurred_at: null,
      materialised: false,
      refunded_minor: 0,
      plan: input.plan,
      deliveries: [],
      refund_ids: [],
      attempts: 0,
    };

    this.charges.set(chargeId, charge);
    this.idempotency.set(slot, {
      key: input.idempotencyKey,
      scope: 'charge',
      resource_id: chargeId,
      fingerprint: input.fingerprint,
      outcome: input.plan.transientFailure ? 'failed_500' : 'accepted',
      first_seen_at: now,
      replays: 0,
    });

    return { outcome: 'created', charge };
  }

  async materialiseCharge(
    chargeId: string,
    status: ChargeStatus,
    occurredAt: Date,
  ): Promise<Charge | null> {
    const charge = this.charges.get(chargeId);
    if (!charge || charge.materialised) return null;
    charge.materialised = true;
    charge.status = status;
    charge.occurred_at = occurredAt.toISOString();
    return charge;
  }

  async recoverFromTransientFailure(
    chargeId: string,
    key: string,
    correlationId: string | null,
  ): Promise<void> {
    const record = this.idempotency.get(`charge:${key}`);
    if (record) record.outcome = 'accepted';
    const charge = this.charges.get(chargeId);
    if (charge && !charge.correlation_id) charge.correlation_id = correlationId;
  }

  async openRefund(input: OpenRefundInput): Promise<OpenRefundResult> {
    const slot = `refund:${input.idempotencyKey}`;
    const existing = this.idempotency.get(slot);

    if (existing) {
      if (existing.fingerprint !== input.fingerprint) return { outcome: 'fingerprint_mismatch' };
      existing.replays += 1;
      const refund = this.refunds.get(existing.resource_id);
      if (!refund) throw new Error(`idempotency record has no refund ${existing.resource_id}`);
      return { outcome: 'replayed', refund, record: { ...existing } };
    }

    const charge = this.charges.get(input.chargeId);
    if (!charge || !charge.materialised) return { outcome: 'unknown_charge' };
    if (charge.status !== 'succeeded') return { outcome: 'not_refundable', status: charge.status };
    if (charge.refunded_minor + input.amountMinor > charge.amount_minor) {
      return {
        outcome: 'exceeds_charge',
        chargeAmountMinor: charge.amount_minor,
        refundedMinor: charge.refunded_minor,
      };
    }

    const refundId = newRefundId();
    const now = new Date().toISOString();

    const refund: Refund = {
      id: refundId,
      charge_id: charge.id,
      reference: charge.reference,
      amount_minor: input.amountMinor,
      idempotency_key: input.idempotencyKey,
      correlation_id: input.correlationId ?? charge.correlation_id,
      status: 'processing',
      created_at: now,
      occurred_at: null,
      materialised: false,
      plan: input.plan,
    };

    this.refunds.set(refundId, refund);
    charge.refund_ids.push(refundId);
    charge.refunded_minor += input.amountMinor;
    this.idempotency.set(slot, {
      key: input.idempotencyKey,
      scope: 'refund',
      resource_id: refundId,
      fingerprint: input.fingerprint,
      outcome: 'accepted',
      first_seen_at: now,
      replays: 0,
    });

    return { outcome: 'created', refund };
  }

  async materialiseRefund(refundId: string, occurredAt: Date): Promise<Refund | null> {
    const refund = this.refunds.get(refundId);
    if (!refund || refund.materialised) return null;
    refund.materialised = true;
    refund.status = 'succeeded';
    refund.occurred_at = occurredAt.toISOString();
    return refund;
  }

  async nextAttempt(chargeId: string): Promise<number> {
    const charge = this.charges.get(chargeId);
    if (!charge) return 1;
    charge.attempts += 1;
    return charge.attempts;
  }

  async recordDelivery(record: DeliveryRecord): Promise<void> {
    this.charges.get(record.charge_id)?.deliveries.push(record);
  }

  async finishDelivery(_record: DeliveryRecord): Promise<void> {
    // The record pushed by `recordDelivery` is the same object the deliverer
    // mutates, so it is already up to date. Postgres has to write twice; this
    // does not, and pretending otherwise would be ceremony.
  }

  async importCharges(rows: ImportedCharge[]): Promise<number> {
    for (const row of rows) {
      if (this.charges.has(row.id)) continue;
      this.charges.set(row.id, {
        id: row.id,
        reference: row.reference,
        amount_minor: Number(row.amountMinor),
        currency: row.currency,
        idempotency_key: row.idempotencyKey,
        correlation_id: null,
        status: row.status,
        created_at: row.createdAt.toISOString(),
        occurred_at: row.occurredAt.toISOString(),
        materialised: true,
        refunded_minor: Number(row.refundedMinor),
        plan: IMPORTED_PLAN,
        deliveries: [],
        refund_ids: [],
        attempts: 0,
      });
      this.idempotency.set(`charge:${row.idempotencyKey}`, {
        key: row.idempotencyKey,
        scope: 'charge',
        resource_id: row.id,
        fingerprint: 'imported',
        outcome: 'accepted',
        first_seen_at: row.createdAt.toISOString(),
        replays: 0,
      });
    }
    return rows.length;
  }
}

const IMPORTED_PLAN: ChaosPlan = {
  enabled: false,
  transientFailure: false,
  timing: 'normal',
  duplicateDelivery: false,
  firstDelayMs: 0,
  duplicateGapMs: 0,
  clockSkewSeconds: 0,
};
