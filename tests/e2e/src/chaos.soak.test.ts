import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import {
  api,
  connect,
  createHold,
  createWorld,
  sleep,
  waitForStack,
  type World,
} from './harness.js';

/**
 * The honest INV-5 test: real traffic, chaos on, no deterministic controls.
 *
 * Everything in `payments.e2e.test.ts` forces its own scenario, which is right
 * for proving a specific property and wrong for proving there are no others.
 * This file does the opposite. It books, pays, cancels and abandons for a few
 * minutes with `PAYGATE_CHAOS=on` and touches none of the `_test` endpoints —
 * so duplicate deliveries, races on the response, transient 500s, 60-90 second
 * delays, out-of-order arrivals and corrupt signatures all land wherever they
 * land. Then it reconciles.
 *
 * The live path and the reconciler disagreeing under chaos is exactly what
 * INV-5 exists to catch, and the only way to find that out is to let the chaos
 * run and then ask.
 *
 * ## Run it with a short hold TTL
 *
 * The default TTL is eight minutes, so nothing abandoned during a three-minute
 * soak would ever expire and INV-4's branch would never fire — the most
 * interesting failure under chaos (a hold lapses while its payment is in
 * flight) would be exactly the one not exercised. Bring the stack up with
 * HOLD_TTL_SECONDS low for this run:
 *
 *   HOLD_TTL_SECONDS=45 docker compose up -d api1 api2 api3
 *   pnpm soak
 *
 * The suite reads the TTL back from a hold it creates and says what it saw, so
 * a run against the default is reported rather than silently weaker.
 */

interface ReconciliationReport {
  discrepancy_count: number;
  by_kind: Record<string, number>;
  totals: Record<string, string>;
  discrepancies: { kind: string; detail: string }[];
}

const SOAK_SECONDS = Number(process.env.ATRIUM_SOAK_SECONDS ?? 180);
const CONCURRENCY = Number(process.env.ATRIUM_SOAK_CONCURRENCY ?? 6);
const ROOMS = 40;

let db: Client;
let world: World;
let windowFrom: string;

interface Tally {
  holds: number;
  holdRejected: number;
  paid: number;
  payFailed: number;
  cancelled: number;
  abandoned: number;
  serverErrors: number;
}

const tally: Tally = {
  holds: 0,
  holdRejected: 0,
  paid: 0,
  payFailed: 0,
  cancelled: 0,
  abandoned: 0,
  serverErrors: 0,
};

let observedTtlSeconds = 0;

beforeAll(async () => {
  await waitForStack();
  db = await connect();
  world = await createWorld(db, ROOMS);
  const started = await db.query<{ now: string }>(`SELECT now()::text AS now`);
  windowFrom = new Date(started.rows[0]!.now).toISOString();
}, 180_000);

afterAll(async () => {
  await db?.end();
});

/**
 * One customer journey, start to finish, with no forced outcomes.
 *
 * The mix is deliberately uneven: most bookings are paid and kept, a fifth are
 * cancelled, and a tenth are abandoned at the hold. Abandonment is the one that
 * matters — with a short TTL those holds lapse while Paygate may still be
 * sitting on a delayed delivery, which is INV-4 arriving by accident rather
 * than by instruction.
 */
async function journey(index: number): Promise<void> {
  const roomIndex = index % ROOMS;
  // Spread across the calendar so journeys do not fight over the same slot;
  // a 409 from the exclusion constraint is correct but tells us nothing here.
  const hoursAhead = 24 + ((index * 7) % (60 * 24));

  let bookingId: string;
  try {
    const hold = await createHold(world, roomIndex, hoursAhead, index % 3 !== 0);
    bookingId = hold.id;
    tally.holds += 1;

    if (observedTtlSeconds === 0 && hold.expires_at) {
      observedTtlSeconds = Math.round(
        (new Date(hold.expires_at).getTime() - Date.now()) / 1000,
      );
    }
  } catch {
    tally.holdRejected += 1;
    return;
  }

  // A tenth are abandoned at the hold and never paid for.
  if (index % 10 === 0) {
    tally.abandoned += 1;
    return;
  }

  const paid = await api<{ charge_id: string | null }>(
    'POST',
    `/bookings/${bookingId}/pay`,
    world.customer.token,
  );

  if (paid.status >= 500 && paid.status !== 502 && paid.status !== 503) {
    tally.serverErrors += 1;
  }

  if (paid.status !== 200) {
    // 502/503 is Paygate's 10% transient branch surfacing. Deliberately NOT
    // retried here: leaving it is the more interesting state, because the
    // charge may exist at the provider with no outcome, and the reconciler is
    // supposed to be able to tell.
    tally.payFailed += 1;
    return;
  }
  tally.paid += 1;

  // A fifth of the paid ones cancel. Give the capture a moment to land first,
  // so the cancellation has a settled payment to refund rather than a pending
  // one — which is the ordinary case a real customer produces.
  if (index % 5 === 0) {
    await sleep(1_500);
    const cancelled = await api('POST', `/bookings/${bookingId}/cancel`, world.customer.token, {
      reason: 'soak',
    });
    if (cancelled.status === 200) tally.cancelled += 1;
    if (cancelled.status >= 500) tally.serverErrors += 1;
  }
}

describe('chaos soak', () => {
  it(`runs real traffic for ${SOAK_SECONDS}s with chaos on and no forced outcomes`, async () => {
    const deadline = Date.now() + SOAK_SECONDS * 1_000;
    let next = 0;

    const workers = Array.from({ length: CONCURRENCY }, async () => {
      while (Date.now() < deadline) {
        const index = next++;
        try {
          await journey(index);
        } catch (err: unknown) {
          // A journey throwing is itself a finding; record and keep going so
          // one bad request cannot end the soak.
          tally.serverErrors += 1;
          process.stdout.write(
            `journey ${index} threw: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }
    });

    await Promise.all(workers);

    process.stdout.write(
      `\n-- soak traffic ------------------------------------------------------\n` +
        `  hold TTL observed   ${observedTtlSeconds}s\n` +
        `  holds created       ${tally.holds}\n` +
        `  holds rejected 4xx  ${tally.holdRejected}\n` +
        `  paid                ${tally.paid}\n` +
        `  pay failed (5xx)    ${tally.payFailed}\n` +
        `  cancelled           ${tally.cancelled}\n` +
        `  abandoned at hold   ${tally.abandoned}\n` +
        `  unexpected 5xx      ${tally.serverErrors}\n`,
    );

    expect(tally.holds).toBeGreaterThan(20);
    // The hold and cancel paths must not 500 under any chaos branch. Paygate
    // failing is a 502/503 from the client and is counted separately.
    expect(tally.serverErrors).toBe(0);
  }, 600_000);

  it('drains every signed delivery', async () => {
    // Paygate's delayed branch is 60-90 seconds, so the backlog is not empty
    // the moment traffic stops. Waiting for it is part of the test: a delivery
    // that never lands is money the system cannot account for.
    const deadline = Date.now() + 240_000;
    let pending = -1;

    while (Date.now() < deadline) {
      const res = await db.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM webhook_deliveries
          WHERE signature_valid = true AND processed_at IS NULL
            AND received_at >= $1::timestamptz`,
        [windowFrom],
      );
      pending = Number(res.rows[0]!.n);
      if (pending === 0) break;
      await sleep(2_000);
    }

    const summary = await db.query<{ error: string | null; n: string }>(
      `SELECT error, COUNT(*)::text AS n FROM webhook_deliveries
        WHERE received_at >= $1::timestamptz GROUP BY error ORDER BY 2 DESC`,
      [windowFrom],
    );

    process.stdout.write(
      `\n-- deliveries --------------------------------------------------------\n` +
        summary.rows
          .map((r) => `  ${(r.error ?? 'applied').padEnd(20)} ${r.n}\n`)
          .join(''),
    );

    expect(pending).toBe(0);
  }, 300_000);

  it('reconciles to zero discrepancies', async () => {
    // grace_seconds=30 excuses only genuinely in-flight work. Everything the
    // soak started has had time to finish by now.
    const deadline = Date.now() + 180_000;
    let report: ReconciliationReport | null = null;

    while (Date.now() < deadline) {
      const to = new Date(Date.now() + 60_000).toISOString();
      const res = await api<ReconciliationReport>(
        'GET',
        `/admin/reconciliation?from=${windowFrom}&to=${to}&grace_seconds=30`,
        world.platformAdmin.token,
      );
      report = res.body;
      if (report && report.discrepancy_count === 0) break;
      await sleep(3_000);
    }

    process.stdout.write(
      `\n-- reconciliation ----------------------------------------------------\n` +
        `  discrepancies  ${report?.discrepancy_count}\n` +
        `  by kind        ${JSON.stringify(report?.by_kind)}\n` +
        `  totals         ${JSON.stringify(report?.totals)}\n` +
        (report && report.discrepancy_count > 0
          ? report.discrepancies
              .slice(0, 10)
              .map((d) => `    ${d.kind}: ${d.detail}\n`)
              .join('')
          : '') +
        `----------------------------------------------------------------------\n`,
    );

    expect(report?.discrepancy_count).toBe(0);
  }, 300_000);

  it('left no booking confirmed without a capture, and no capture unaccounted for', async () => {
    // The same claim as the report makes, asked directly of the tables. If
    // these two disagree with the reconciler, the reconciler is the thing that
    // is wrong — and that is worth knowing.
    const orphanConfirmed = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM bookings b
        WHERE b.status IN ('CONFIRMED','COMPLETED') AND b.venue_id = $1::uuid
          AND NOT EXISTS (SELECT 1 FROM payments p
                           WHERE p.booking_id = b.id
                             AND p.status IN ('SUCCEEDED','REFUNDED'))`,
      [world.venueId],
    );
    expect(orphanConfirmed.rows[0]!.n).toBe('0');

    const strandedCaptures = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM payments p
         JOIN bookings b ON b.id = p.booking_id
        WHERE b.venue_id = $1::uuid
          AND p.status = 'SUCCEEDED'
          AND b.status NOT IN ('CONFIRMED','COMPLETED')
          AND p.refund_id IS NULL`,
      [world.venueId],
    );
    expect(strandedCaptures.rows[0]!.n).toBe('0');
  });
});
