import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';

export interface Discrepancy extends Record<string, unknown> {
  kind: string;
  booking_id: string | null;
  charge_id: string | null;
  amount_minor: string | null;
  detail: string;
  observed_at: string;
}

/**
 * INV-5 — money is never silently lost.
 *
 * The claim: every captured charge maps to exactly one CONFIRMED booking, or to
 * exactly one refund. This endpoint is the proof, and the only way it is worth
 * anything is if it can actually fail. A query shaped like
 * `SELECT ... FROM payments JOIN bookings ON ... WHERE status = 'CONFIRMED'`
 * returns zero discrepancies on every database in existence, including a
 * catastrophically broken one, because it only looks where the money already
 * agrees.
 *
 * So the checks below are deliberately written from the outside in. Each one
 * names a way the live path could have gone wrong and asks the database whether
 * it did:
 *
 *   1. **capture_without_confirmation** — money captured, booking not CONFIRMED
 *      and not refunded. This is INV-4 failing to fire: the hold lapsed, the
 *      payment landed, and nothing gave it back.
 *   2. **confirmation_without_capture** — a CONFIRMED booking with no captured
 *      charge. A room given away for free, which is the mirror failure and the
 *      one a payments-only report would never see.
 *   3. **double_capture** — more than one settled payment against one booking.
 *      INV-3 failing. Cannot happen through `payments.idempotency_key`, which is
 *      exactly why it is checked: the assertion is that the constraint is doing
 *      its job, not that the code meant well.
 *   4. **refund_without_capture** — a refund recorded against a payment that
 *      never captured. Money leaving with nothing to have paid for it.
 *   5. **refund_initiated_not_settled** — a refund key was minted and the
 *      refund never came back. The customer is owed money the system believes
 *      it has returned.
 *   6. **over_refunded** — more went back than came in.
 *   7. **unmatched_delivery** — a signed delivery still unapplied past the
 *      grace window, including the `unknown_charge` case. The provider says it
 *      captured; this system has no payment it belongs to. Left out, a charge
 *      could sit at Paygate indefinitely with nothing here to show for it.
 *
 * The window is applied to the payment's creation time, or the delivery's
 * receipt time, so a reviewer can scope the report to a run rather than to the
 * whole history.
 */
@Injectable()
export class ReconciliationService {
  constructor(private readonly db: Db) {}

  async run(
    from: Date,
    to: Date,
    graceSeconds: number,
    limit = 500,
  ): Promise<{
    from: string;
    to: string;
    grace_seconds: number;
    discrepancy_count: number;
    returned: number;
    truncated: boolean;
    by_kind: Record<string, number>;
    discrepancies: Discrepancy[];
    totals: Record<string, string>;
  }> {
    const union = this.discrepancies(from, to, graceSeconds);

    // Two passes over the same fragment, deliberately.
    //
    // The first counts EVERY discrepancy and groups them by kind; the second
    // returns at most `limit` rows to look at. P4 had one pass with a bare
    // `LIMIT 500` and reported `result.rows.length` as the count — so a
    // database with 5,000 discrepancies reported exactly 500, and a report
    // whose entire job is to be trustworthy was quietly truncating its own
    // headline number. An admin-only report can afford the second scan; it
    // cannot afford to under-report.
    const counts = await this.db.execute<{ kind: string; n: number }>(sql`
      SELECT kind, COUNT(*)::int AS n FROM (${union}) counted GROUP BY kind
    `);

    const rows = await this.db.execute<Discrepancy>(sql`
      SELECT kind, booking_id::text AS booking_id, charge_id, amount_minor, detail,
             to_char(observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS observed_at
        FROM (${union}) listed
       ORDER BY observed_at DESC
       LIMIT ${limit}
    `);

    const byKind: Record<string, number> = {};
    let total = 0;
    for (const row of counts.rows) {
      byKind[row.kind] = row.n;
      total += row.n;
    }

    const totals = await this.db.execute<{
      captured_minor: string;
      refunded_minor: string;
      confirmed_bookings: string;
      settled_payments: string;
    }>(sql`
      SELECT
        (SELECT COALESCE(SUM(p.amount_minor) FILTER (WHERE p.status IN ('SUCCEEDED','REFUNDED')), 0)::text
           FROM payments p WHERE p.created_at >= ${from} AND p.created_at < ${to}) AS captured_minor,
        (SELECT COALESCE(SUM(p.refunded_minor), 0)::text
           FROM payments p WHERE p.created_at >= ${from} AND p.created_at < ${to}) AS refunded_minor,
        -- Counted from bookings, NOT from a join through payments. P4 counted
        -- it through the join, so a database with 5,049 confirmed bookings and
        -- no payments reported confirmed_bookings: 0 — the exact number an
        -- operator would read as evidence that nothing was wrong.
        (SELECT COUNT(*)::text FROM bookings b
          WHERE b.status = 'CONFIRMED'
            AND b.updated_at >= ${from} AND b.updated_at < ${to}) AS confirmed_bookings,
        (SELECT COUNT(*)::text FROM payments p
          WHERE p.status IN ('SUCCEEDED','REFUNDED')
            AND p.created_at >= ${from} AND p.created_at < ${to}) AS settled_payments
    `);

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      grace_seconds: graceSeconds,
      discrepancy_count: total,
      returned: rows.rows.length,
      truncated: total > rows.rows.length,
      by_kind: byKind,
      discrepancies: rows.rows,
      totals: (totals.rows[0] ?? {}) as unknown as Record<string, string>,
    };
  }

  /** The seven checks, as one composable fragment so it can be counted and listed. */
  private discrepancies(from: Date, to: Date, graceSeconds: number) {
    const grace = sql.raw(`interval '${Math.max(0, Math.floor(graceSeconds))} seconds'`);

    return sql`
      WITH settled AS (
        SELECT p.*, b.status AS booking_status, b.venue_id
          FROM payments p
          JOIN bookings b ON b.id = p.booking_id
         WHERE p.created_at >= ${from} AND p.created_at < ${to}
      ),

      -- 1. captured, but the booking is neither CONFIRMED nor refunded.
      capture_without_confirmation AS (
        SELECT 'capture_without_confirmation' AS kind,
               booking_id, charge_id, amount_minor::text AS amount_minor,
               'charge captured but booking is ' || booking_status
                 || ' and no refund has settled' AS detail,
               updated_at AS observed_at
          FROM settled
         WHERE status = 'SUCCEEDED'
           AND booking_status <> 'CONFIRMED'
           AND booking_status <> 'COMPLETED'
           AND updated_at < now() - ${grace}
      ),

      -- 2. Settled with nothing captured against it.
      --
      -- COMPLETED is included as well as CONFIRMED. A booking that ran to
      -- completion with no captured charge is a room given away for free just
      -- as surely as a confirmed one, and leaving it out would mean the check
      -- stopped applying the moment a booking's start time passed.
      confirmation_without_capture AS (
        SELECT 'confirmation_without_capture' AS kind,
               b.id AS booking_id, NULL::text AS charge_id,
               b.total_minor::text AS amount_minor,
               'booking is ' || b.status || ' with no settled payment' AS detail,
               b.updated_at AS observed_at
          FROM bookings b
         WHERE b.status IN ('CONFIRMED','COMPLETED')
           AND b.updated_at >= ${from} AND b.updated_at < ${to}
           AND b.updated_at < now() - ${grace}
           AND NOT EXISTS (
             SELECT 1 FROM payments p
              WHERE p.booking_id = b.id
                AND p.status IN ('SUCCEEDED','REFUNDED')
           )
      ),

      -- 3. more than one settled payment for one booking.
      double_capture AS (
        SELECT 'double_capture' AS kind,
               booking_id, NULL::text AS charge_id,
               SUM(amount_minor)::text AS amount_minor,
               'booking has ' || COUNT(*)::text || ' settled payments' AS detail,
               MAX(updated_at) AS observed_at
          FROM settled
         WHERE status IN ('SUCCEEDED','REFUNDED')
         GROUP BY booking_id
        HAVING COUNT(*) > 1
      ),

      -- 4. a refund against something that never captured.
      refund_without_capture AS (
        SELECT 'refund_without_capture' AS kind,
               booking_id, charge_id, refunded_minor::text AS amount_minor,
               'refund recorded but no capture event exists for this charge' AS detail,
               updated_at AS observed_at
          FROM settled
         WHERE (status = 'REFUNDED' OR refunded_minor > 0)
           AND (
             charge_id IS NULL
             OR NOT EXISTS (
               SELECT 1 FROM payment_events e
                WHERE e.charge_id = settled.charge_id
                  AND e.event = 'charge.succeeded'
             )
           )
      ),

      -- 5. refund promised, never settled.
      refund_initiated_not_settled AS (
        SELECT 'refund_initiated_not_settled' AS kind,
               booking_id, charge_id, amount_minor::text AS amount_minor,
               'a refund idempotency key was minted but no refund has settled' AS detail,
               updated_at AS observed_at
          FROM settled
         WHERE refund_idempotency_key IS NOT NULL
           AND status <> 'REFUNDED'
           AND updated_at < now() - ${grace}
      ),

      -- 6. more went back than came in.
      over_refunded AS (
        SELECT 'over_refunded' AS kind,
               booking_id, charge_id, refunded_minor::text AS amount_minor,
               'refunded ' || refunded_minor::text || ' against a charge of '
                 || amount_minor::text AS detail,
               updated_at AS observed_at
          FROM settled
         WHERE refunded_minor > amount_minor
      ),

      -- 7. a signed delivery this system never managed to apply.
      unmatched_delivery AS (
        SELECT 'unmatched_delivery' AS kind,
               NULL::uuid AS booking_id, w.charge_id,
               NULL::text AS amount_minor,
               'signed delivery still unapplied' ||
                 COALESCE(' (' || w.error || ')', '') ||
                 COALESCE(', reference ' || w.reference, '') AS detail,
               w.received_at AS observed_at
          FROM webhook_deliveries w
         WHERE w.signature_valid = true
           AND w.processed_at IS NULL
           AND w.received_at >= ${from} AND w.received_at < ${to}
           AND w.received_at < now() - ${grace}
      )

      SELECT * FROM capture_without_confirmation
      UNION ALL SELECT * FROM confirmation_without_capture
      UNION ALL SELECT * FROM double_capture
      UNION ALL SELECT * FROM refund_without_capture
      UNION ALL SELECT * FROM refund_initiated_not_settled
      UNION ALL SELECT * FROM over_refunded
      UNION ALL SELECT * FROM unmatched_delivery
    `;
  }
}
