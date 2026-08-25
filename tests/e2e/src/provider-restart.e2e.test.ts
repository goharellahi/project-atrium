import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import {
  PAYGATE_URL,
  api,
  connect,
  createHold,
  createWorld,
  deliver,
  pay,
  sleep,
  waitForStack,
  waitForStatus,
  type World,
} from './harness.js';

const run = promisify(execFile);

/**
 * The provider forgets, and the money survives it.
 *
 * ## The failure this exists for
 *
 * Paygate kept its whole ledger in a `Map` until P8, and said so on purpose:
 * "Paygate is a test double, not a system of record." The first half of that is
 * true and the second half does not follow. Render's free tier sleeps after
 * fifteen idle minutes, so a charge captured before a reviewer's coffee does not
 * exist after it — and the refund that follows answers `404 unknown_charge`.
 *
 * That is not a demo-data inconvenience, it is INV-5 unprovable. "Money is never
 * silently lost" cannot be demonstrated against a provider with amnesia: the
 * money is gone from the provider's point of view and owed from ours, which is
 * precisely the state the invariant says must be impossible to reach silently.
 * It also made `CHARGE_POLL_AFTER_SECONDS` inert, because asking a provider for
 * an outcome it structurally cannot remember always answers "never heard of it"
 * — and the API was reading that as an answer rather than as an absence of one.
 *
 * ## Why this test could not be written before
 *
 * Because it would have failed by construction, and failing by construction is
 * not a finding. Every other suite in this directory works because Paygate stays
 * up for the length of the run. This one is the only one that asserts anything
 * about what happens when it does not, and a provider restart mid lifecycle is
 * exactly what the free tier hands a reviewer.
 *
 * ## What "restart" means here
 *
 * The container is stopped and started, not reloaded: a new process, a new heap,
 * nothing carried over but the tables. `docker compose restart paygate` is the
 * closest local analogue of a free-tier instance waking from sleep, and it is
 * how this suite is skipped rather than faked when docker is not reachable —
 * see `restartPaygate`.
 */

let db: Client;
let world: World;

/** True when the stack is under our own `docker compose`, so it can be cycled. */
let canRestart = false;

async function restartPaygate(): Promise<string> {
  const before = await paygateHealth();

  await run('docker', ['compose', 'restart', 'paygate'], { cwd: repoRoot() });

  // The container answers /health only once its migrations have run, which is
  // the state this test needs — a provider that is up but has not opened its
  // ledger would answer 404 for a reason that has nothing to do with the point.
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${PAYGATE_URL}/health`);
      if (res.ok) {
        const health = (await res.json()) as {
          store: string;
          started_at: string;
        };
        if (health.store !== 'postgres') {
          throw new Error(
            `paygate came back on the ${health.store} store — this suite is meaningless against it`,
          );
        }

        /**
         * The restart has to be real, and this is where that is established.
         *
         * A `docker compose restart` that quietly did nothing would leave every
         * assertion below passing for the wrong reason: the charge would still
         * be there, and the test would be proving that a process which never
         * died remembers things. `started_at` is minted when the process boots,
         * so a different value is a different process.
         */
        if (health.started_at === before.started_at) {
          await sleep(1_000);
          continue;
        }
        return health.started_at;
      }
    } catch {
      /* still coming up */
    }
    await sleep(1_000);
  }
  throw new Error('paygate did not come back as a new process after restart');
}

async function paygateHealth(): Promise<{ store: string; started_at: string }> {
  const res = await fetch(`${PAYGATE_URL}/health`);
  return (await res.json()) as { store: string; started_at: string };
}

function repoRoot(): string {
  // tests/e2e/src -> repo root
  return new URL('../../..', import.meta.url).pathname;
}

beforeAll(async () => {
  await waitForStack();
  db = await connect();
  world = await createWorld(db, 4);

  try {
    await run('docker', ['compose', 'ps', '--format', 'json'], { cwd: repoRoot() });
    canRestart = true;
  } catch {
    canRestart = false;
  }
}, 180_000);

afterAll(async () => {
  await db?.end();
});

describe('the provider remembers a charge across a restart', () => {
  it('reports a durable ledger on /health', async () => {
    const health = (await (await fetch(`${PAYGATE_URL}/health`)).json()) as {
      store: string;
      durable: boolean;
      started_at: string;
    };

    // Stated on the health endpoint because "does this provider remember
    // anything" is the first thing a reviewer needs to know about it, and for
    // six phases the answer was no and nothing said so.
    expect(health.store).toBe('postgres');
    expect(health.durable).toBe(true);
    // Used by the restart below to prove the process actually changed.
    expect(health.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  /**
   * The whole lifecycle, with the provider dying in the middle of it.
   *
   * Pay, confirm, restart Paygate, then cancel — and the refund has to settle.
   * Before P8 the cancel produced `404 unknown_charge` and the money was
   * stranded: owed by us, unknown to the provider, and reported by
   * reconciliation as a discrepancy nobody could act on.
   */
  it('pays, restarts the provider, and still refunds for real', async ({ skip }) => {
    if (!canRestart) {
      skip('docker compose is not reachable from here, so the provider cannot be cycled');
      return;
    }

    const hold = await createHold(world, 0, 96, false);
    const paid = await pay(world, hold.id);
    expect(paid.charge_id).not.toBeNull();
    const chargeId = paid.charge_id!;

    // Force the capture rather than waiting on a chaos branch. What is under
    // test is the restart, not the delivery odds.
    await deliver(chargeId, { event: 'charge.succeeded' });
    await waitForStatus(db, hold.id, ['CONFIRMED']);

    const seenBefore = await fetch(`${PAYGATE_URL}/paygate/charges/${chargeId}`);
    expect(seenBefore.status).toBe(200);

    // ---- the provider dies here ------------------------------------------
    const healthBefore = await paygateHealth();
    const startedAfter = await restartPaygate();
    expect(startedAfter, 'paygate did not actually restart').not.toBe(healthBefore.started_at);

    // The assertion that was impossible before: a brand new process, and the
    // charge is still there. In memory this was a 404 every time.
    const seenAfter = await fetch(`${PAYGATE_URL}/paygate/charges/${chargeId}`);
    expect(seenAfter.status, 'the provider forgot a charge it had captured').toBe(200);

    const recalled = (await seenAfter.json()) as {
      charge_id: string;
      status: string;
      amount_minor: number;
      reference: string;
    };
    expect(recalled.charge_id).toBe(chargeId);
    expect(recalled.status).toBe('succeeded');
    // The reference survives as the opaque string it is. Paygate has never
    // known what a booking is and does not start now.
    expect(recalled.reference).toBe(hold.id);

    // ---- and the money can still be given back ---------------------------
    const cancelled = await api(
      'POST',
      `/bookings/${hold.id}/cancel`,
      world.customer.token,
      { reason: 'provider restart test' },
    );
    expect(cancelled.status, cancelled.text).toBe(200);

    const payment = await waitFor(
      'the refund to be accepted by the provider',
      async () => {
        const { rows } = await db.query<{ refund_id: string | null; failure_reason: string | null }>(
          'SELECT refund_id, failure_reason FROM payments WHERE booking_id = $1::uuid',
          [hold.id],
        );
        return rows[0]!;
      },
      (row) => row.refund_id !== null || row.failure_reason !== null,
    );

    // The precise failure this phase set out to remove. Asserted on rather than
    // inferred from a status, so a regression names itself.
    expect(payment.failure_reason, 'the refund was rejected after the restart').toBeNull();
    expect(payment.refund_id).not.toBeNull();

    await deliver(chargeId, { event: 'refund.succeeded', refundId: payment.refund_id! });

    const settled = await waitFor(
      'the refund to settle',
      async () => {
        const { rows } = await db.query<{ status: string; refunded_minor: string }>(
          'SELECT status, refunded_minor::text AS refunded_minor FROM payments WHERE booking_id = $1::uuid',
          [hold.id],
        );
        return rows[0]!;
      },
      (row) => row.status === 'REFUNDED',
    );
    expect(BigInt(settled.refunded_minor)).toBeGreaterThan(0n);
  }, 180_000);

  /**
   * The other half, and the one the reconciliation report depends on.
   *
   * `CHARGE_POLL_AFTER_SECONDS` exists so the API can ask the provider about an
   * outcome a lost webhook never delivered. Against an amnesiac provider that
   * question had exactly one possible answer, so the path could never repair
   * anything. Here the webhook is never delivered at all and the provider is
   * restarted before the poll runs — and the charge is still answerable.
   */
  it('answers a lookup for a charge whose webhook was never delivered', async ({ skip }) => {
    if (!canRestart) {
      skip('docker compose is not reachable from here');
      return;
    }

    const hold = await createHold(world, 1, 120, false);
    const paid = await pay(world, hold.id);
    const chargeId = paid.charge_id!;

    await restartPaygate();

    const looked = await fetch(`${PAYGATE_URL}/paygate/charges/${chargeId}`);
    expect(looked.status).toBe(200);
    const state = (await looked.json()) as { status: string };

    // Whatever the outcome was, the provider has one. That is the entire
    // difference between a poll that can repair a lost webhook and a poll that
    // can only ever be told "never heard of it".
    expect(['succeeded', 'failed', 'processing']).toContain(state.status);
  }, 180_000);
});

/** Local copy of the harness helper, imported lazily to keep the import list flat. */
async function waitFor<T>(
  what: string,
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (done(last)) return last;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}; last saw ${JSON.stringify(last)}`);
}
