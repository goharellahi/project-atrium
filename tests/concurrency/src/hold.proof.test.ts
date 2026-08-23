import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import {
  BASE_URL,
  connect,
  createFixture,
  fireConcurrently,
  replicaSpread,
  tally,
  waitForApi,
  type Fixture,
  type HoldAttempt,
} from './harness.js';

/**
 * THE CONCURRENCY PROOF.
 *
 * 200 requests, released together, through nginx on :8080, against three API
 * replicas sharing one Postgres.
 *
 * Three things are asserted, and the third is the one most easily forgotten:
 *
 *   1. The HTTP responses are correct — exactly one success for the room, at
 *      most `units_owned` for the equipment, and every rejection a clean 409.
 *   2. The requests really were distributed. A run that nginx sent entirely to
 *      one replica proves nothing about a strategy whose entire claim is that
 *      it survives N processes; an in-process mutex would pass it.
 *   3. The DATABASE agrees. Responses can be right while the rows are wrong —
 *      a 409 returned after a successful commit, or a success whose row rolled
 *      back. So the invariants are re-read directly from Postgres afterwards,
 *      with the same sweep-line query the admission path uses.
 */

const CONCURRENCY = 200;
const EQUIPMENT_UNITS = 3;

let db: Client;
let fixture: Fixture;
let roomAttempts: HoldAttempt[];
let equipmentAttempts: HoldAttempt[];

const transcript: string[] = [];
const record = (line: string): void => {
  transcript.push(line);
  // eslint-disable-next-line no-console
  console.log(line);
};

beforeAll(async () => {
  await waitForApi();
  db = await connect();

  // One room per concurrent request for the equipment run, plus the single
  // contended room for the room run.
  //
  // The equipment test MUST use distinct rooms. If all 200 requests targeted
  // one room, `no_room_overlap` would reject 199 of them before the equipment
  // check ever ran, and the test would "pass" while proving nothing about
  // INV-2. Distinct rooms remove the room constraint from the picture so the
  // only thing that can bound the successes is the equipment admission check.
  fixture = await createFixture(db, {
    rooms: CONCURRENCY + 1,
    equipmentUnits: EQUIPMENT_UNITS,
  });

  record('');
  record('='.repeat(78));
  record('ATRIUM CONCURRENCY PROOF');
  record('='.repeat(78));
  record(`target            ${BASE_URL}  (nginx -> api1, api2, api3)`);
  record(`concurrency       ${CONCURRENCY} requests, released together`);
  record(`contended room    ${fixture.roomIds[0]}`);
  record(`contended slot    ${fixture.startsAt.toISOString()} .. ${fixture.endsAt.toISOString()}`);
  record(`equipment type    ${fixture.equipmentTypeId}  (units_owned = ${EQUIPMENT_UNITS})`);
  record('');
}, 180_000);

afterAll(async () => {
  record('='.repeat(78));
  record('');
  await db?.end();
});

describe('INV-1 — rooms never double book', () => {
  it(`admits exactly one of ${CONCURRENCY} concurrent holds for the same slot`, async () => {
    const room = fixture.roomIds[0]!;

    roomAttempts = await fireConcurrently(
      CONCURRENCY,
      () => ({
        body: {
          room_id: room,
          starts_at: fixture.startsAt.toISOString(),
          ends_at: fixture.endsAt.toISOString(),
        },
      }),
      fixture.token,
    );

    const statuses = tally(roomAttempts);
    const spread = replicaSpread(roomAttempts);

    record('-- INV-1: same room, same one-hour slot --------------------------------');
    record(`  responses        ${formatTally(statuses)}`);
    record(`  replica spread   ${formatSpread(spread)}`);

    const created = roomAttempts.filter((a) => a.status === 201);
    const conflicts = roomAttempts.filter((a) => a.status === 409);
    const other = roomAttempts.filter((a) => a.status !== 201 && a.status !== 409);

    if (other.length > 0) {
      record(`  UNEXPECTED       ${JSON.stringify(other.slice(0, 3), null, 2)}`);
    }

    // Exactly one success.
    expect(created).toHaveLength(1);

    // Every other request got a clean 409 — not a 500, not a timeout. A 500
    // here would mean the exclusion violation escaped as a server error, which
    // is a correctness failure even though the data would be intact.
    expect(other).toHaveLength(0);
    expect(conflicts).toHaveLength(CONCURRENCY - 1);

    // No duplicate successes hiding behind identical ids.
    const distinctIds = new Set(created.map((a) => a.bookingId));
    expect(distinctIds.size).toBe(1);

    // The proof is only a proof if the load balancer actually spread the load.
    expect(spread.size).toBeGreaterThanOrEqual(3);
    for (const [replica, count] of spread) {
      expect(count, `replica ${replica} served no requests`).toBeGreaterThan(0);
    }

    record(`  distinct booking ${[...distinctIds][0]}`);
    record('');
  }, 180_000);

  it('the database agrees — one active booking for that room and slot', async () => {
    const result = await db.query<{ count: string; ids: string[] }>(
      `SELECT count(*)::text AS count, array_agg(id::text) AS ids
         FROM bookings
        WHERE room_id = $1::uuid
          AND status IN ('HELD','PENDING_PAYMENT','CONFIRMED')
          AND slot && tstzrange($2::timestamptz, $3::timestamptz, '[)')`,
      [
        fixture.roomIds[0],
        fixture.startsAt.toISOString(),
        fixture.endsAt.toISOString(),
      ],
    );

    const count = Number(result.rows[0]!.count);
    record('-- INV-1 re-read from Postgres ----------------------------------------');
    record(`  active bookings overlapping the slot: ${count}`);
    record(`  ids: ${JSON.stringify(result.rows[0]!.ids)}`);
    record('');

    expect(count).toBe(1);

    // And the audit trail: exactly one event per transition, never zero.
    const audit = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM audit_events
        WHERE booking_id = $1::uuid AND from_state = 'DRAFT' AND to_state = 'HELD'`,
      [result.rows[0]!.ids[0]],
    );
    expect(Number(audit.rows[0]!.count)).toBe(1);
  }, 60_000);
});

describe('INV-2 — equipment never oversells at any instant', () => {
  it(`admits at most ${EQUIPMENT_UNITS} of ${CONCURRENCY} concurrent holds for ${EQUIPMENT_UNITS} units`, async () => {
    // Distinct rooms, identical time window, one unit each. The rooms cannot
    // collide, so the ONLY thing that can limit the successes is the equipment
    // admission check.
    equipmentAttempts = await fireConcurrently(
      CONCURRENCY,
      (index) => ({
        body: {
          room_id: fixture.roomIds[index + 1],
          starts_at: fixture.startsAt.toISOString(),
          ends_at: fixture.endsAt.toISOString(),
          line_items: [{ equipment_type_id: fixture.equipmentTypeId, quantity: 1 }],
        },
      }),
      fixture.token,
    );

    const statuses = tally(equipmentAttempts);
    const spread = replicaSpread(equipmentAttempts);

    const created = equipmentAttempts.filter((a) => a.status === 201);
    const conflicts = equipmentAttempts.filter((a) => a.status === 409);
    const other = equipmentAttempts.filter((a) => a.status !== 201 && a.status !== 409);

    record(`-- INV-2: ${CONCURRENCY} distinct rooms, 1 unit each, ${EQUIPMENT_UNITS} units owned ----------`);
    record(`  responses        ${formatTally(statuses)}`);
    record(`  replica spread   ${formatSpread(spread)}`);
    record(`  admitted         ${created.length} (ceiling ${EQUIPMENT_UNITS})`);

    if (other.length > 0) {
      record(`  UNEXPECTED       ${JSON.stringify(other.slice(0, 3), null, 2)}`);
    }

    expect(other).toHaveLength(0);
    expect(created.length).toBeLessThanOrEqual(EQUIPMENT_UNITS);
    expect(created.length).toBeGreaterThan(0);
    expect(conflicts.length).toBe(CONCURRENCY - created.length);
    expect(spread.size).toBeGreaterThanOrEqual(3);

    record('');
  }, 180_000);

  it('the database agrees — peak concurrent usage never exceeds units_owned', async () => {
    // The same sweep line the admission path runs, executed independently here.
    // Re-deriving it rather than calling the API is the point: if the
    // application's own query were wrong, asking the application would agree
    // with itself.
    const result = await db.query<{ peak: string }>(
      `WITH ov AS (
         SELECT b.starts_at, b.ends_at, li.quantity
           FROM booking_line_items li
           JOIN bookings b ON b.id = li.booking_id
          WHERE li.equipment_type_id = $1::uuid
            AND b.status IN ('HELD','PENDING_PAYMENT','CONFIRMED')
       ),
       ev AS (
         SELECT starts_at AS at,  quantity AS d, 1 AS ord FROM ov
         UNION ALL
         SELECT ends_at   AS at, -quantity AS d, 0 AS ord FROM ov
       ),
       run AS (
         SELECT SUM(d) OVER (ORDER BY at, ord
                             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS in_use
           FROM ev
       )
       SELECT COALESCE(MAX(in_use), 0)::text AS peak FROM run`,
      [fixture.equipmentTypeId],
    );

    const peak = Number(result.rows[0]!.peak);

    const reserved = await db.query<{ total: string }>(
      `SELECT COALESCE(SUM(li.quantity), 0)::text AS total
         FROM booking_line_items li
         JOIN bookings b ON b.id = li.booking_id
        WHERE li.equipment_type_id = $1::uuid
          AND b.status IN ('HELD','PENDING_PAYMENT','CONFIRMED')`,
      [fixture.equipmentTypeId],
    );

    record('-- INV-2 re-read from Postgres ----------------------------------------');
    record(`  units_owned                    ${EQUIPMENT_UNITS}`);
    record(`  peak concurrent usage          ${peak}`);
    record(`  total units reserved (rows)    ${reserved.rows[0]!.total}`);
    record('');

    expect(peak).toBeLessThanOrEqual(EQUIPMENT_UNITS);
  }, 60_000);
});

describe('the run itself', () => {
  it('produced no 5xx anywhere and touched all three replicas', () => {
    const all = [...roomAttempts, ...equipmentAttempts];
    const serverErrors = all.filter((a) => a.status >= 500);
    const spread = replicaSpread(all);

    record('-- run summary --------------------------------------------------------');
    record(`  total requests   ${all.length}`);
    record(`  5xx responses    ${serverErrors.length}`);
    record(`  replicas seen    ${[...spread.keys()].sort().join(', ')}`);
    record(`  per replica      ${formatSpread(spread)}`);
    record('');

    expect(serverErrors).toHaveLength(0);
    expect(spread.size).toBeGreaterThanOrEqual(3);
    expect([...spread.keys()].sort()).toEqual(['api1', 'api2', 'api3']);
  });
});

function formatTally(counts: Map<number, number>): string {
  return [...counts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([status, n]) => `${status} x${n}`)
    .join(', ');
}

function formatSpread(counts: Map<string, number>): string {
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([replica, n]) => `${replica}=${n}`)
    .join(' ');
}
