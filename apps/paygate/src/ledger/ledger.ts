import { createHash, randomUUID } from 'node:crypto';
import type { ChaosPlan } from '../chaos.js';
import type {
  Charge,
  ChargeStatus,
  DeliveryRecord,
  IdempotencyRecord,
  Refund,
} from '../types.js';

/**
 * Paygate's ledger — the interface, and the argument for it existing.
 *
 * ## The decision this reverses
 *
 * `store.ts` held everything in a `Map` and said so on purpose: "Paygate is a
 * test double, not a system of record. Restarting it between runs *should* wipe
 * it, and giving it a database would invite the reviewer to believe the API's
 * payment integrity depends on the provider remembering things."
 *
 * The first half of that is right and the second half does not follow. INV-3 is
 * still the API's job and is still enforced in the API's Postgres; nothing here
 * changes that. What the in-memory store actually broke is **INV-5**, which is
 * not about idempotency at all:
 *
 * > Money is never silently lost. Every captured charge maps to exactly one
 * > CONFIRMED booking or exactly one refund, provable via a reconciliation
 * > endpoint returning zero discrepancies.
 *
 * A provider with amnesia cannot participate in that proof. Render's free tier
 * sleeps after fifteen idle minutes, so a charge captured before lunch does not
 * exist after it — and refunding it answers `404 unknown_charge`. The money is
 * gone from the provider's point of view and owed from ours, which is precisely
 * the state INV-5 says must be impossible to reach silently.
 *
 * Worse, it made a whole recovery path inert. `CHARGE_POLL_AFTER_SECONDS` exists
 * so the API can ask the provider about a charge whose webhook never arrived.
 * Against a provider that forgets, that question can only ever be answered
 * "never heard of it" — and the API was treating that as an answer rather than
 * as an absence of one.
 *
 * It surfaced first on seeded data, which made it look like a seed problem. It
 * was not: a charge created through the console has exactly the same fate after
 * one cold start.
 *
 * ## The boundary, which is real and is not a shared schema
 *
 * These tables are Paygate's. They are prefixed `paygate_`, created by Paygate's
 * own migrations in this directory, and **nothing here imports from
 * `apps/api/src/db`**. There are no foreign keys across the boundary in either
 * direction: `paygate_charges.reference` holds the API's booking id as an
 * *opaque string*, exactly as a real provider's `metadata.reference` would, and
 * Paygate never joins to a booking, never validates one, and would answer the
 * same way if the API's database were dropped entirely.
 *
 * The two services share one Postgres *instance* because the free tier gives one
 * instance. That is a hosting cost constraint, not a design one. Everything that
 * would make it coupling — a shared table, a shared migration history, a join, a
 * foreign key, an import — is absent, so moving Paygate to its own database is a
 * connection string and nothing else. See ARCHITECTURE.md §7.
 *
 * ## Why the interface, rather than just talking to Postgres
 *
 * The unit suites in `apps/paygate/test` assert the idempotency contract and the
 * chaos rates. Neither needs durability, and making 39 fast tests wait on a
 * database would buy nothing and cost the thing that makes them useful. So
 * `MemoryLedger` stays, behind `PAYGATE_STORE=memory`, and the production
 * default is Postgres. The e2e suite is where durability is actually asserted —
 * `provider-restart.e2e.test.ts` pays a booking, restarts Paygate, and refunds
 * it.
 */

// ---------------------------------------------------------------------------
// Inputs and results
// ---------------------------------------------------------------------------

export interface OpenChargeInput {
  reference: string;
  amountMinor: number;
  currency: string;
  idempotencyKey: string;
  fingerprint: string;
  correlationId: string | null;
  plan: ChaosPlan;
}

export type OpenChargeResult =
  /** This request created the charge. The caller owns materialising it. */
  | { outcome: 'created'; charge: Charge }
  /** The key had been seen. `charge` is the one it resolved to, first time round. */
  | { outcome: 'replayed'; charge: Charge; record: IdempotencyRecord }
  /** Same key, different body. */
  | { outcome: 'fingerprint_mismatch' };

export interface OpenRefundInput {
  chargeId: string;
  amountMinor: number;
  idempotencyKey: string;
  fingerprint: string;
  correlationId: string | null;
  plan: ChaosPlan;
}

export type OpenRefundResult =
  | { outcome: 'created'; refund: Refund }
  | { outcome: 'replayed'; refund: Refund; record: IdempotencyRecord }
  | { outcome: 'fingerprint_mismatch' }
  | { outcome: 'unknown_charge' }
  | { outcome: 'not_refundable'; status: ChargeStatus }
  | { outcome: 'exceeds_charge'; chargeAmountMinor: number; refundedMinor: number };

/** One row for the seed's bulk insert. See `Ledger.importCharges`. */
export interface ImportedCharge {
  id: string;
  reference: string;
  amountMinor: bigint | number;
  currency: string;
  idempotencyKey: string;
  status: ChargeStatus;
  createdAt: Date;
  occurredAt: Date;
  refundedMinor: bigint | number;
}

// ---------------------------------------------------------------------------
// The interface
// ---------------------------------------------------------------------------

export interface Ledger {
  /** `memory` or `postgres`. Reported by /health so it is never a guess. */
  readonly kind: 'memory' | 'postgres';

  /** Apply migrations, open the pool. Called once before the server binds. */
  init(): Promise<void>;
  close(): Promise<void>;

  counts(): Promise<{ charges: number; refunds: number }>;

  getCharge(id: string): Promise<Charge | null>;
  getRefund(id: string): Promise<Refund | null>;
  refundsFor(chargeId: string): Promise<Refund[]>;
  deliveriesFor(chargeId: string): Promise<DeliveryRecord[]>;

  /**
   * Claim an Idempotency-Key and create the charge, atomically.
   *
   * The in-memory version was atomic because Node runs one request at a time
   * between awaits. Postgres is not, so this is `INSERT ... ON CONFLICT DO
   * NOTHING RETURNING` on the idempotency row: whoever inserts it owns the
   * charge, and everybody else reads back what the winner wrote. Losing that
   * race is the normal case under the concurrency proof, and it must produce a
   * replay rather than a second charge — which is the provider's half of INV-3.
   */
  openCharge(input: OpenChargeInput): Promise<OpenChargeResult>;

  /**
   * Claim a refund key, check the charge is refundable and reserve the amount,
   * atomically.
   *
   * `refunded_minor + amount <= amount_minor` is a read-modify-write, so the
   * charge row is locked `FOR UPDATE` for the duration. Two concurrent partial
   * refunds that each pass the check independently would over-refund, and
   * over-refunding is one of the discrepancy classes the API's
   * reconciliation report exists to catch.
   */
  openRefund(input: OpenRefundInput): Promise<OpenRefundResult>;

  /**
   * Move a charge from accepted-but-undecided to its outcome, once.
   *
   * Returns null if it had already been materialised, which is what makes the
   * 500-then-retry path safe: the retry re-enters here and gets null rather
   * than dispatching a second set of webhooks.
   */
  materialiseCharge(
    chargeId: string,
    status: ChargeStatus,
    occurredAt: Date,
  ): Promise<Charge | null>;

  materialiseRefund(refundId: string, occurredAt: Date): Promise<Refund | null>;

  /** The 500-recovery path: flip the idempotency outcome and backfill the id. */
  recoverFromTransientFailure(
    chargeId: string,
    key: string,
    correlationId: string | null,
  ): Promise<void>;

  /** Bump and return the attempt ordinal. The seeded signature draw reads it. */
  nextAttempt(chargeId: string): Promise<number>;

  /** Written before the HTTP call, so a delivery that never returns still shows. */
  recordDelivery(record: DeliveryRecord): Promise<void>;
  /** Written after it, with the status, duration and error. */
  finishDelivery(record: DeliveryRecord): Promise<void>;

  /**
   * Bulk-load charges that already happened. The seed's entry point.
   *
   * Rows only — no chaos plan to draw, no webhooks to dispatch, no idempotency
   * race to lose. A seeded charge is history: it captured, the API already knows
   * it captured, and the only thing that was ever missing is the provider's own
   * record of it. Idempotent on `id`, so re-seeding is safe.
   */
  importCharges(rows: ImportedCharge[]): Promise<number>;
}

// ---------------------------------------------------------------------------
// Pure helpers, shared by both implementations
// ---------------------------------------------------------------------------

export function fingerprintOf(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 32);
}

export function newChargeId(): string {
  return `ch_${randomUUID().replace(/-/g, '')}`;
}

export function newRefundId(): string {
  return `re_${randomUUID().replace(/-/g, '')}`;
}

/**
 * The forced-delay registry for `/paygate/_test/delay`, deliberately in memory
 * in both implementations.
 *
 * It is a one-shot instruction to the *next* delivery, armed and consumed
 * within a single test. Persisting it would mean a delay armed by a test that
 * crashed could fire against an unrelated charge after a restart — a durable
 * booby trap, which is the opposite of what the control surface is for.
 */
export class ForcedDelays {
  private readonly perCharge = new Map<string, number>();
  private global: number | null = null;

  arm(chargeId: string | null, delayMs: number): void {
    if (chargeId) this.perCharge.set(chargeId, delayMs);
    else this.global = delayMs;
  }

  take(chargeId: string): number | null {
    const own = this.perCharge.get(chargeId);
    if (own !== undefined) {
      this.perCharge.delete(chargeId);
      return own;
    }
    if (this.global !== null) {
      const ms = this.global;
      this.global = null;
      return ms;
    }
    return null;
  }
}
