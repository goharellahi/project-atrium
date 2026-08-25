import { Pool, type PoolClient } from 'pg';
import type { ChaosPlan } from '../chaos.js';
import type {
  Charge,
  ChargeStatus,
  DeliveryRecord,
  IdempotencyRecord,
  Refund,
  WebhookEvent,
} from '../types.js';
import { migrate } from './migrate.js';
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
 * The durable ledger.
 *
 * Every method here is a statement about what the provider remembers across a
 * restart, which on Render's free tier happens after fifteen idle minutes and
 * will happen to a reviewer between opening the console and coming back to it.
 *
 * See `ledger.ts` for why this exists and why it is not coupling.
 */
export class PostgresLedger implements Ledger {
  readonly kind = 'postgres' as const;

  private readonly pool: Pool;

  constructor(
    databaseUrl: string,
    private readonly log: (msg: string) => void = () => undefined,
  ) {
    // Small on purpose. Paygate serves the API and a handful of test scripts,
    // and it shares a free-tier instance with three API replicas that each hold
    // their own pool. Taking connections Paygate will not use is taking them
    // from the service that will.
    this.pool = new Pool({ connectionString: databaseUrl, max: 5 });
  }

  async init(): Promise<void> {
    await migrate(this.pool, this.log);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async counts(): Promise<{ charges: number; refunds: number }> {
    const { rows } = await this.pool.query<{ charges: string; refunds: string }>(`
      SELECT (SELECT count(*) FROM paygate_charges) AS charges,
             (SELECT count(*) FROM paygate_refunds) AS refunds
    `);
    return { charges: Number(rows[0]?.charges ?? 0), refunds: Number(rows[0]?.refunds ?? 0) };
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async getCharge(id: string): Promise<Charge | null> {
    const { rows } = await this.pool.query<ChargeRow>(
      'SELECT * FROM paygate_charges WHERE id = $1',
      [id],
    );
    if (!rows[0]) return null;
    return toCharge(rows[0], await this.refundIdsFor(id), await this.deliveriesFor(id));
  }

  async getRefund(id: string): Promise<Refund | null> {
    const { rows } = await this.pool.query<RefundRow>(
      'SELECT * FROM paygate_refunds WHERE id = $1',
      [id],
    );
    return rows[0] ? toRefund(rows[0]) : null;
  }

  async refundsFor(chargeId: string): Promise<Refund[]> {
    const { rows } = await this.pool.query<RefundRow>(
      'SELECT * FROM paygate_refunds WHERE charge_id = $1 ORDER BY created_at, id',
      [chargeId],
    );
    return rows.map(toRefund);
  }

  async deliveriesFor(chargeId: string): Promise<DeliveryRecord[]> {
    const { rows } = await this.pool.query<DeliveryRow>(
      'SELECT * FROM paygate_deliveries WHERE charge_id = $1 ORDER BY recorded_at, delivery_id',
      [chargeId],
    );
    return rows.map(toDelivery);
  }

  private async refundIdsFor(chargeId: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ id: string }>(
      'SELECT id FROM paygate_refunds WHERE charge_id = $1 ORDER BY created_at, id',
      [chargeId],
    );
    return rows.map((r) => r.id);
  }

  // -------------------------------------------------------------------------
  // Charges
  // -------------------------------------------------------------------------

  async openCharge(input: OpenChargeInput): Promise<OpenChargeResult> {
    const chargeId = newChargeId();

    return this.transaction(async (tx) => {
      /**
       * The claim, and the whole reason this is a transaction.
       *
       * `ON CONFLICT DO NOTHING RETURNING` returns a row only to the request
       * that inserted it. Everyone else gets nothing back and reads the winner's
       * row instead — so a retry, a duplicate, or two replicas racing the same
       * key all converge on one charge. Under the 200-request proof this loses
       * constantly, and losing correctly is the point.
       */
      const claimed = await tx.query<{ resource_id: string }>(
        `INSERT INTO paygate_idempotency (scope, key, resource_id, fingerprint, outcome)
         VALUES ('charge', $1, $2, $3, $4)
         ON CONFLICT (scope, key) DO NOTHING
         RETURNING resource_id`,
        [
          input.idempotencyKey,
          chargeId,
          input.fingerprint,
          input.plan.transientFailure ? 'failed_500' : 'accepted',
        ],
      );

      if (claimed.rows.length === 0) {
        const { rows } = await tx.query<IdempotencyRow>(
          `SELECT * FROM paygate_idempotency WHERE scope = 'charge' AND key = $1 FOR UPDATE`,
          [input.idempotencyKey],
        );
        const record = rows[0];
        if (!record) throw new Error('idempotency row vanished between insert and select');
        if (record.fingerprint !== input.fingerprint) return { outcome: 'fingerprint_mismatch' };

        const bumped = await tx.query<IdempotencyRow>(
          `UPDATE paygate_idempotency SET replays = replays + 1
            WHERE scope = 'charge' AND key = $1 RETURNING *`,
          [input.idempotencyKey],
        );

        const charge = await this.loadChargeIn(tx, record.resource_id);
        if (!charge) throw new Error(`idempotency record has no charge ${record.resource_id}`);
        return { outcome: 'replayed', charge, record: toIdempotency(bumped.rows[0]!) };
      }

      const { rows } = await tx.query<ChargeRow>(
        `INSERT INTO paygate_charges
           (id, reference, amount_minor, currency, idempotency_key, correlation_id,
            status, materialised, refunded_minor, plan, attempts)
         VALUES ($1, $2, $3, $4, $5, $6, 'processing', false, 0, $7::jsonb, 0)
         RETURNING *`,
        [
          chargeId,
          input.reference,
          input.amountMinor,
          input.currency,
          input.idempotencyKey,
          input.correlationId,
          JSON.stringify(input.plan),
        ],
      );

      return { outcome: 'created', charge: toCharge(rows[0]!, [], []) };
    });
  }

  async materialiseCharge(
    chargeId: string,
    status: ChargeStatus,
    occurredAt: Date,
  ): Promise<Charge | null> {
    // `AND materialised = false` is the guard. A charge that has already been
    // brought to life returns nothing here, so the 500-then-retry path cannot
    // dispatch a second set of webhooks for the same money.
    const { rows } = await this.pool.query<ChargeRow>(
      `UPDATE paygate_charges
          SET materialised = true, status = $2, occurred_at = $3
        WHERE id = $1 AND materialised = false
        RETURNING *`,
      [chargeId, status, occurredAt.toISOString()],
    );
    return rows[0] ? toCharge(rows[0], [], []) : null;
  }

  async recoverFromTransientFailure(
    chargeId: string,
    key: string,
    correlationId: string | null,
  ): Promise<void> {
    await this.transaction(async (tx) => {
      await tx.query(
        `UPDATE paygate_idempotency SET outcome = 'accepted'
          WHERE scope = 'charge' AND key = $1`,
        [key],
      );
      // Backfilled only if the first attempt carried none — the retry's request
      // id is better than nothing, and worse than the original.
      await tx.query(
        `UPDATE paygate_charges SET correlation_id = COALESCE(correlation_id, $2)
          WHERE id = $1`,
        [chargeId, correlationId],
      );
    });
  }

  // -------------------------------------------------------------------------
  // Refunds
  // -------------------------------------------------------------------------

  async openRefund(input: OpenRefundInput): Promise<OpenRefundResult> {
    const refundId = newRefundId();

    return this.transaction(async (tx) => {
      const claimed = await tx.query<{ resource_id: string }>(
        `INSERT INTO paygate_idempotency (scope, key, resource_id, fingerprint, outcome)
         VALUES ('refund', $1, $2, $3, 'accepted')
         ON CONFLICT (scope, key) DO NOTHING
         RETURNING resource_id`,
        [input.idempotencyKey, refundId, input.fingerprint],
      );

      if (claimed.rows.length === 0) {
        const { rows } = await tx.query<IdempotencyRow>(
          `SELECT * FROM paygate_idempotency WHERE scope = 'refund' AND key = $1 FOR UPDATE`,
          [input.idempotencyKey],
        );
        const record = rows[0];
        if (!record) throw new Error('idempotency row vanished between insert and select');
        if (record.fingerprint !== input.fingerprint) return { outcome: 'fingerprint_mismatch' };

        const bumped = await tx.query<IdempotencyRow>(
          `UPDATE paygate_idempotency SET replays = replays + 1
            WHERE scope = 'refund' AND key = $1 RETURNING *`,
          [input.idempotencyKey],
        );
        const refundRows = await tx.query<RefundRow>(
          'SELECT * FROM paygate_refunds WHERE id = $1',
          [record.resource_id],
        );
        const refund = refundRows.rows[0];
        if (!refund) throw new Error(`idempotency record has no refund ${record.resource_id}`);
        return {
          outcome: 'replayed',
          refund: toRefund(refund),
          record: toIdempotency(bumped.rows[0]!),
        };
      }

      /**
       * `FOR UPDATE`, and it is not decoration.
       *
       * "Has enough of this charge already been refunded" is a read followed by
       * a write, and two partial refunds that each pass the check independently
       * both commit and over-refund. In memory the check was safe by accident,
       * because Node does not interleave between the read and the write. Here
       * the lock is what makes it safe, and `paygate_charges_not_over_refunded`
       * is the backstop if this is ever got wrong.
       */
      const chargeRows = await tx.query<ChargeRow>(
        'SELECT * FROM paygate_charges WHERE id = $1 FOR UPDATE',
        [input.chargeId],
      );
      const charge = chargeRows.rows[0];

      if (!charge || !charge.materialised) return { outcome: 'unknown_charge' };
      if (charge.status !== 'succeeded') {
        return { outcome: 'not_refundable', status: charge.status as ChargeStatus };
      }

      const refunded = Number(charge.refunded_minor);
      const amount = Number(charge.amount_minor);
      if (refunded + input.amountMinor > amount) {
        return { outcome: 'exceeds_charge', chargeAmountMinor: amount, refundedMinor: refunded };
      }

      const { rows } = await tx.query<RefundRow>(
        `INSERT INTO paygate_refunds
           (id, charge_id, reference, amount_minor, idempotency_key, correlation_id,
            status, materialised, plan)
         VALUES ($1, $2, $3, $4, $5, $6, 'processing', false, $7::jsonb)
         RETURNING *`,
        [
          refundId,
          charge.id,
          charge.reference,
          input.amountMinor,
          input.idempotencyKey,
          input.correlationId ?? charge.correlation_id,
          JSON.stringify(input.plan),
        ],
      );

      await tx.query(
        'UPDATE paygate_charges SET refunded_minor = refunded_minor + $2 WHERE id = $1',
        [charge.id, input.amountMinor],
      );

      return { outcome: 'created', refund: toRefund(rows[0]!) };
    });
  }

  async materialiseRefund(refundId: string, occurredAt: Date): Promise<Refund | null> {
    const { rows } = await this.pool.query<RefundRow>(
      `UPDATE paygate_refunds
          SET materialised = true, status = 'succeeded', occurred_at = $2
        WHERE id = $1 AND materialised = false
        RETURNING *`,
      [refundId, occurredAt.toISOString()],
    );
    return rows[0] ? toRefund(rows[0]) : null;
  }

  // -------------------------------------------------------------------------
  // Deliveries
  // -------------------------------------------------------------------------

  async nextAttempt(chargeId: string): Promise<number> {
    const { rows } = await this.pool.query<{ attempts: number }>(
      'UPDATE paygate_charges SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts',
      [chargeId],
    );
    // A forced delivery for a charge this instance has never seen still gets an
    // ordinal rather than throwing; the delivery row is what matters.
    return rows[0]?.attempts ?? 1;
  }

  async recordDelivery(record: DeliveryRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO paygate_deliveries
         (delivery_id, charge_id, refund_id, event, attempt, branch, signature_corrupted,
          scheduled_delay_ms, occurred_at, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (delivery_id) DO NOTHING`,
      [
        record.delivery_id,
        record.charge_id,
        record.refund_id,
        record.event,
        record.attempt,
        record.branch,
        record.signature_corrupted,
        record.scheduled_delay_ms,
        record.occurred_at,
        record.correlation_id,
      ],
    );
  }

  async finishDelivery(record: DeliveryRecord): Promise<void> {
    await this.pool.query(
      `UPDATE paygate_deliveries
          SET sent_at = $2, response_status = $3, duration_ms = $4, error = $5
        WHERE delivery_id = $1`,
      [
        record.delivery_id,
        record.sent_at,
        record.response_status,
        record.duration_ms,
        record.error,
      ],
    );
  }

  // -------------------------------------------------------------------------
  // Bulk import
  // -------------------------------------------------------------------------

  async importCharges(rows: ImportedCharge[]): Promise<number> {
    if (rows.length === 0) return 0;

    let written = 0;

    for (const batch of chunk(rows, 500)) {
      const values: unknown[] = [];
      const tuples: string[] = [];

      for (const row of batch) {
        const base = values.length;
        values.push(
          row.id,
          row.reference,
          row.amountMinor.toString(),
          row.currency,
          row.idempotencyKey,
          row.status,
          row.createdAt.toISOString(),
          row.occurredAt.toISOString(),
          row.refundedMinor.toString(),
        );
        tuples.push(
          `($${base + 1}, $${base + 2}, $${base + 3}::bigint, $${base + 4}, $${base + 5},` +
            ` $${base + 6}, $${base + 7}::timestamptz, $${base + 8}::timestamptz,` +
            ` $${base + 9}::bigint)`,
        );
      }

      // `materialised` is true and the plan is the no-chaos plan: these charges
      // already happened. There is nothing left to decide and nothing to
      // deliver — the API's ledger already records the capture.
      const result = await this.pool.query(
        `INSERT INTO paygate_charges
           (id, reference, amount_minor, currency, idempotency_key, status,
            created_at, occurred_at, refunded_minor, materialised, plan, attempts)
         SELECT v.id, v.reference, v.amount_minor, v.currency, v.idempotency_key, v.status,
                v.created_at, v.occurred_at, v.refunded_minor, true, $${values.length + 1}::jsonb, 0
           FROM (VALUES ${tuples.join(',')})
             AS v(id, reference, amount_minor, currency, idempotency_key, status,
                  created_at, occurred_at, refunded_minor)
         ON CONFLICT (id) DO NOTHING`,
        [...values, JSON.stringify(IMPORTED_PLAN)],
      );
      written += result.rowCount ?? 0;

      // The idempotency ledger too, so `POST /bookings/:id/pay` on an already
      // paid seeded booking replays into the same charge rather than minting a
      // second one — which is what it does for a booking paid through the
      // console, and the two must not behave differently.
      const idemValues: unknown[] = [];
      const idemTuples: string[] = [];
      for (const row of batch) {
        const base = idemValues.length;
        idemValues.push(row.idempotencyKey, row.id, row.createdAt.toISOString());
        idemTuples.push(
          `('charge', $${base + 1}, $${base + 2}, 'imported', 'accepted',` +
            ` $${base + 3}::timestamptz, 0)`,
        );
      }
      await this.pool.query(
        `INSERT INTO paygate_idempotency
           (scope, key, resource_id, fingerprint, outcome, first_seen_at, replays)
         VALUES ${idemTuples.join(',')}
         ON CONFLICT (scope, key) DO NOTHING`,
        idemValues,
      );
    }

    return written;
  }

  // -------------------------------------------------------------------------

  private async transaction<T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async loadChargeIn(tx: PoolClient, id: string): Promise<Charge | null> {
    const { rows } = await tx.query<ChargeRow>('SELECT * FROM paygate_charges WHERE id = $1', [id]);
    return rows[0] ? toCharge(rows[0], [], []) : null;
  }
}

/**
 * The plan stamped on an imported charge.
 *
 * `enabled: false` is honest rather than convenient: no chaos was applied,
 * because no request was made. A reviewer reading `chaos_plan` on a seeded
 * charge should see "none, this did not go through the wire" instead of a
 * plausible-looking branch that never ran.
 */
const IMPORTED_PLAN: ChaosPlan = {
  enabled: false,
  transientFailure: false,
  timing: 'normal',
  duplicateDelivery: false,
  firstDelayMs: 0,
  duplicateGapMs: 0,
  clockSkewSeconds: 0,
};

// ---------------------------------------------------------------------------
// Row shapes and mapping
// ---------------------------------------------------------------------------

interface ChargeRow {
  id: string;
  reference: string;
  amount_minor: string;
  currency: string;
  idempotency_key: string;
  correlation_id: string | null;
  status: string;
  created_at: Date;
  occurred_at: Date | null;
  materialised: boolean;
  refunded_minor: string;
  plan: ChaosPlan;
  attempts: number;
}

interface RefundRow {
  id: string;
  charge_id: string;
  reference: string;
  amount_minor: string;
  idempotency_key: string;
  correlation_id: string | null;
  status: string;
  created_at: Date;
  occurred_at: Date | null;
  materialised: boolean;
  plan: ChaosPlan;
}

interface DeliveryRow {
  delivery_id: string;
  charge_id: string;
  refund_id: string | null;
  event: string;
  attempt: number;
  branch: string;
  signature_corrupted: boolean;
  scheduled_delay_ms: number;
  occurred_at: Date;
  sent_at: Date | null;
  response_status: number | null;
  duration_ms: number | null;
  error: string | null;
  correlation_id: string | null;
}

interface IdempotencyRow {
  scope: string;
  key: string;
  resource_id: string;
  fingerprint: string;
  outcome: string;
  first_seen_at: Date;
  replays: number;
}

function toCharge(row: ChargeRow, refundIds: string[], deliveries: DeliveryRecord[]): Charge {
  return {
    id: row.id,
    reference: row.reference,
    amount_minor: Number(row.amount_minor),
    currency: row.currency,
    idempotency_key: row.idempotency_key,
    correlation_id: row.correlation_id,
    status: row.status as ChargeStatus,
    created_at: row.created_at.toISOString(),
    occurred_at: row.occurred_at?.toISOString() ?? null,
    materialised: row.materialised,
    refunded_minor: Number(row.refunded_minor),
    plan: row.plan,
    deliveries,
    refund_ids: refundIds,
    attempts: row.attempts,
  };
}

function toRefund(row: RefundRow): Refund {
  return {
    id: row.id,
    charge_id: row.charge_id,
    reference: row.reference,
    amount_minor: Number(row.amount_minor),
    idempotency_key: row.idempotency_key,
    correlation_id: row.correlation_id,
    status: row.status as Refund['status'],
    created_at: row.created_at.toISOString(),
    occurred_at: row.occurred_at?.toISOString() ?? null,
    materialised: row.materialised,
    plan: row.plan,
  };
}

function toDelivery(row: DeliveryRow): DeliveryRecord {
  return {
    delivery_id: row.delivery_id,
    charge_id: row.charge_id,
    refund_id: row.refund_id,
    event: row.event as WebhookEvent,
    attempt: row.attempt,
    branch: row.branch as DeliveryRecord['branch'],
    signature_corrupted: row.signature_corrupted,
    scheduled_delay_ms: row.scheduled_delay_ms,
    occurred_at: row.occurred_at.toISOString(),
    sent_at: row.sent_at?.toISOString() ?? null,
    response_status: row.response_status,
    duration_ms: row.duration_ms,
    error: row.error,
    correlation_id: row.correlation_id,
  };
}

function toIdempotency(row: IdempotencyRow): IdempotencyRecord {
  return {
    key: row.key,
    scope: row.scope as IdempotencyRecord['scope'],
    resource_id: row.resource_id,
    fingerprint: row.fingerprint,
    outcome: row.outcome as IdempotencyRecord['outcome'],
    first_seen_at: row.first_seen_at.toISOString(),
    replays: row.replays,
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
