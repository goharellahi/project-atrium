import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { BASE_URL, api, connect, sleep, waitForStack } from './harness.js';

/**
 * The overbooking buffer, end to end, through the endpoints a venue admin has.
 *
 * ## Why this suite exists
 *
 * The brief makes the buffer a Tier 1 operating rule: "a venue admin may enable
 * an overbooking buffer of up to 10% on any inventory to absorb no shows." P2
 * implemented the admission arithmetic and P2 could not test it, because
 * nothing wrote `venues.overbooking_buffer_pct` — the number could only be
 * changed with a psql session, so every claim about the buffer rested on a
 * value no user could set.
 *
 * Nothing here touches the column directly. The buffer is set with
 * `PATCH /venues/settings`, the equipment is created with
 * `POST /venues/equipment-types`, the rooms with `POST /venues/rooms`, and the
 * admission decisions are made by `POST /bookings/hold` against three replicas
 * behind nginx. If any link in that chain is missing, this suite fails.
 *
 * ## What the numbers mean
 *
 *   ceiling = floor(units_owned * (1 + buffer_pct / 100))
 *
 * Flooring is the part worth proving. Three units at 10% is 3.3, and 0.3 of a
 * camera is not a camera — admitting a fourth booking on the strength of it is
 * exactly the oversell INV-2 forbids. Rounding up instead would make a 1%
 * buffer behave like one whole extra unit on any fleet, which is not what "1%"
 * means.
 *
 * So a three-unit type at 10% still admits three and refuses the fourth. That
 * case is necessary but not sufficient: it is also what a zero buffer does. The
 * second and third scenarios below are what show the buffer *changes* an
 * outcome — ten units at 10% admits an eleventh, and the same ten units at 0%
 * refuses it.
 */

const PASSWORD = 'OverbookingBuffer123!';
const TAG = 'e2e-buffer';

const OPEN_ALL_HOURS = {
  sun: { open: '00:00', close: '24:00' },
  mon: { open: '00:00', close: '24:00' },
  tue: { open: '00:00', close: '24:00' },
  wed: { open: '00:00', close: '24:00' },
  thu: { open: '00:00', close: '24:00' },
  fri: { open: '00:00', close: '24:00' },
  sat: { open: '00:00', close: '24:00' },
};

interface Fixture {
  venueId: string;
  adminToken: string;
  customerToken: string;
}

let db: Client;
let fx: Fixture;

/**
 * The venue and the two principals.
 *
 * The venue row and the role promotion are the only SQL here, and both are
 * unavoidable: there is no endpoint that creates a venue (platform onboarding
 * is not in scope) and `POST /auth/register` deliberately always mints a
 * CUSTOMER, so a VENUE_ADMIN is made by registering, promoting, and logging in
 * again — the second login is the point, because the token's claims are re-read
 * from the row.
 *
 * Everything the suite actually asserts about goes through the API.
 */
async function makeUser(
  role: 'CUSTOMER' | 'VENUE_ADMIN',
  venueId: string | null,
): Promise<string> {
  const email = `${TAG}-${role}-${randomUUID()}@atrium.test`.toLowerCase();

  const registered = await fetch(`${BASE_URL}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!registered.ok) throw new Error(`fixture: register failed ${registered.status}`);

  if (role !== 'CUSTOMER') {
    const promoted = await db.query(
      `UPDATE users SET role = $1::user_role, venue_id = $2::uuid WHERE email = $3`,
      [role, venueId, email],
    );
    if (promoted.rowCount !== 1) {
      throw new Error(`fixture: promoting to ${role} matched ${promoted.rowCount} rows`);
    }
  }

  const loggedIn = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!loggedIn.ok) throw new Error(`fixture: login failed ${loggedIn.status}`);

  const token = ((await loggedIn.json()) as { access_token: string }).access_token;

  const me = (await (
    await fetch(`${BASE_URL}/auth/me`, { headers: { authorization: `Bearer ${token}` } })
  ).json()) as { role: string };
  if (me.role !== role) throw new Error(`fixture: minted as ${me.role}, expected ${role}`);

  return token;
}

/** A fresh room, through the admin API rather than through SQL. */
async function createRoom(label: string): Promise<string> {
  const created = await api<{ id: string; venue_id: string }>(
    'POST',
    '/venues/rooms',
    fx.adminToken,
    { name: `${TAG}-${label}-${randomUUID()}`, capacity: 10, hourly_rate_minor: '10000' },
  );
  expect(created.status, created.text).toBe(201);
  expect(created.body.venue_id).toBe(fx.venueId);
  return created.body.id;
}

async function createEquipmentType(unitsOwned: number): Promise<string> {
  const created = await api<{ id: string; units_owned: number }>(
    'POST',
    '/venues/equipment-types',
    fx.adminToken,
    { name: `${TAG}-camera-${randomUUID()}`, hourly_rate_minor: '5000', units_owned: unitsOwned },
  );
  expect(created.status, created.text).toBe(201);
  expect(created.body.units_owned).toBe(unitsOwned);
  return created.body.id;
}

async function setBuffer(pct: number): Promise<void> {
  const updated = await api<{ overbooking_buffer_pct: number }>(
    'PATCH',
    '/venues/settings',
    fx.adminToken,
    { overbooking_buffer_pct: pct },
  );
  expect(updated.status, updated.text).toBe(200);
  expect(updated.body.overbooking_buffer_pct).toBe(pct);
}

/**
 * One slot, well clear of now and of every other scenario's slot.
 *
 * Each scenario gets its own hour so that a hold left over from the previous
 * one cannot contribute to this one's peak. Peak concurrent usage is measured
 * over the requested window, so two scenarios sharing an hour would measure
 * each other.
 */
function slotForScenario(index: number): { starts_at: string; ends_at: string } {
  const base = Date.now() + 3 * 86_400_000 + index * 6 * 3_600_000;
  const startsAt = new Date(Math.ceil(base / 3_600_000) * 3_600_000);
  return {
    starts_at: startsAt.toISOString(),
    ends_at: new Date(startsAt.getTime() + 3_600_000).toISOString(),
  };
}

interface Shortfall {
  equipment_type_id: string;
  requested: number;
  peak_in_use: number;
  ceiling: number;
  short_by: number;
}

async function hold(
  roomId: string,
  slot: { starts_at: string; ends_at: string },
  equipmentTypeId: string,
  quantity: number,
) {
  return api<{ id: string; message?: string; shortfalls?: Shortfall[] }>(
    'POST',
    '/bookings/hold',
    fx.customerToken,
    { room_id: roomId, ...slot, line_items: [{ equipment_type_id: equipmentTypeId, quantity }] },
  );
}

beforeAll(async () => {
  await waitForStack();
  db = await connect();

  const venue = await db.query<{ id: string }>(
    `INSERT INTO venues (name, city, timezone, operating_hours, overbooking_buffer_pct)
     VALUES ($1, $2, 'UTC', $3::jsonb, 0) RETURNING id`,
    [`${TAG} ${randomUUID()}`, TAG, JSON.stringify(OPEN_ALL_HOURS)],
  );
  const venueId = venue.rows[0]!.id;

  fx = {
    venueId,
    adminToken: await makeUser('VENUE_ADMIN', venueId),
    customerToken: await makeUser('CUSTOMER', null),
  };
}, 180_000);

afterAll(async () => {
  await db?.end();
});

describe('the buffer is settable through the API and the hold path honours it', () => {
  it('PATCH /venues/settings writes the buffer and the venue row agrees', async () => {
    await setBuffer(10);

    // Read the column, not the response. A response that echoes what it was
    // sent proves nothing about what was stored.
    const row = await db.query<{ pct: number }>(
      `SELECT overbooking_buffer_pct AS pct FROM venues WHERE id = $1::uuid`,
      [fx.venueId],
    );
    expect(row.rows[0]!.pct).toBe(10);
  });

  /**
   * The case the phase was asked to prove: three units at 10%.
   *
   * ceiling = floor(3 * 1.10) = floor(3.3) = 3. Peak reaches exactly 3 and is
   * admitted; the request that would take it to 4 is past 3.3 and is refused
   * with a 409 that quotes the arithmetic.
   */
  it('3 units at 10%: admits a peak of 3, refuses the request that would pass 3.3', async () => {
    await setBuffer(10);

    const equipmentTypeId = await createEquipmentType(3);
    const slot = slotForScenario(0);

    // Two units on one room, one on another, all in the same hour. Different
    // rooms, so no_room_overlap has nothing to say — this is purely an
    // equipment admission decision.
    const first = await hold(await createRoom('r0a'), slot, equipmentTypeId, 2);
    expect(first.status, first.text).toBe(201);

    const second = await hold(await createRoom('r0b'), slot, equipmentTypeId, 1);
    expect(second.status, second.text).toBe(201);

    // Peak concurrent usage is now exactly 3, at the ceiling.
    const peak = await peakInWindow(equipmentTypeId, slot);
    expect(peak).toBe(3);

    const fourth = await hold(await createRoom('r0c'), slot, equipmentTypeId, 1);
    expect(fourth.status, fourth.text).toBe(409);

    const shortfall = fourth.body.shortfalls?.[0];
    expect(shortfall).toBeDefined();
    expect(shortfall!.ceiling).toBe(3);
    expect(shortfall!.peak_in_use).toBe(3);
    expect(shortfall!.short_by).toBe(1);

    // The 0.3 of a unit that a 10% buffer buys on three units is not a unit,
    // and the database agrees: nothing was written.
    const after = await peakInWindow(equipmentTypeId, slot);
    expect(after).toBe(3);
  });

  /**
   * The case that shows the buffer does something.
   *
   * Ten units at 10% is a ceiling of 11 — a whole extra unit, so the buffer is
   * visible in the outcome rather than only in the arithmetic.
   */
  it('10 units at 10%: admits an eleventh unit and refuses a twelfth', async () => {
    await setBuffer(10);

    const equipmentTypeId = await createEquipmentType(10);
    const slot = slotForScenario(1);

    for (const [label, quantity] of [
      ['r1a', 5],
      ['r1b', 5],
      ['r1c', 1],
    ] as const) {
      const probe = await hold(await createRoom(label), slot, equipmentTypeId, quantity);
      expect(probe.status, `${label}: ${probe.text}`).toBe(201);
    }

    expect(await peakInWindow(equipmentTypeId, slot)).toBe(11);

    const twelfth = await hold(await createRoom('r1d'), slot, equipmentTypeId, 1);
    expect(twelfth.status, twelfth.text).toBe(409);
    expect(twelfth.body.shortfalls?.[0]?.ceiling).toBe(11);
  });

  /**
   * The control. Same fleet size, buffer off, and the eleventh unit that was
   * admitted above is now refused — so the difference is the buffer and not
   * something else about the fixture.
   */
  it('10 units at 0%: the same eleventh unit is refused', async () => {
    await setBuffer(0);

    const equipmentTypeId = await createEquipmentType(10);
    const slot = slotForScenario(2);

    const first = await hold(await createRoom('r2a'), slot, equipmentTypeId, 10);
    expect(first.status, first.text).toBe(201);

    const eleventh = await hold(await createRoom('r2b'), slot, equipmentTypeId, 1);
    expect(eleventh.status, eleventh.text).toBe(409);
    expect(eleventh.body.shortfalls?.[0]?.ceiling).toBe(10);
  });

  it('a buffer above 10% is refused and the stored value is unchanged', async () => {
    await setBuffer(10);

    const refused = await api('PATCH', '/venues/settings', fx.adminToken, {
      overbooking_buffer_pct: 11,
    });
    expect(refused.status).toBe(422);

    const row = await db.query<{ pct: number }>(
      `SELECT overbooking_buffer_pct AS pct FROM venues WHERE id = $1::uuid`,
      [fx.venueId],
    );
    expect(row.rows[0]!.pct).toBe(10);
  });

  it('a room refuses a non-zero buffer with 422 and says why', async () => {
    const refused = await api<{ message: string; applies_to: string }>(
      'POST',
      '/venues/rooms',
      fx.adminToken,
      {
        name: `${TAG}-buffered-${randomUUID()}`,
        capacity: 4,
        hourly_rate_minor: '5000',
        overbooking_buffer_pct: 5,
      },
    );

    expect(refused.status, refused.text).toBe(422);
    // The message has to carry the reason, not just the refusal. A venue admin
    // who is told "no" without being told that the buffer belongs on equipment
    // will try again somewhere else.
    expect(refused.body.message).toContain('INV-1');
    expect(refused.body.applies_to).toBe('equipment');

    // Zero is a legal thing to state explicitly, and states nothing new.
    const allowed = await api<{ overbooking_buffer_pct: number }>(
      'POST',
      '/venues/rooms',
      fx.adminToken,
      {
        name: `${TAG}-unbuffered-${randomUUID()}`,
        capacity: 4,
        hourly_rate_minor: '5000',
        overbooking_buffer_pct: 0,
      },
    );
    expect(allowed.status, allowed.text).toBe(201);
    expect(allowed.body.overbooking_buffer_pct).toBe(0);
  });
});

/**
 * Peak concurrent usage over the window, computed in SQL exactly as
 * `peakConcurrentUsage` does.
 *
 * Re-derived here rather than imported, deliberately. Importing the API's own
 * query would make this suite assert that the implementation agrees with
 * itself. Two independent statements of the same sweep line is the point: if
 * one of them is wrong, the test fails.
 */
async function peakInWindow(
  equipmentTypeId: string,
  slot: { starts_at: string; ends_at: string },
): Promise<number> {
  // The hold path answers before the row is visible to a different connection
  // only if the transaction has not committed; it has, since the API returned
  // 201. A short pause anyway, because the API and this client are separate
  // connections and a replica may still be flushing its log.
  await sleep(50);

  const result = await db.query<{ peak: number }>(
    `WITH req AS (SELECT $2::timestamptz AS s, $3::timestamptz AS e),
     overlapping AS (
       SELECT GREATEST(b.starts_at, req.s) AS window_start,
              LEAST(b.ends_at, req.e)      AS window_end,
              li.quantity
         FROM booking_line_items li
         JOIN bookings b ON b.id = li.booking_id
         CROSS JOIN req
        WHERE li.equipment_type_id = $1::uuid
          AND b.status IN ('HELD','PENDING_PAYMENT','CONFIRMED')
          AND NOT (b.status = 'HELD' AND b.expires_at IS NOT NULL AND b.expires_at <= now())
          AND b.starts_at < req.e
          AND b.ends_at   > req.s
     ),
     events AS (
       SELECT window_start AS at,  quantity AS delta, 1 AS tie_break FROM overlapping
       UNION ALL
       SELECT window_end   AS at, -quantity AS delta, 0 AS tie_break FROM overlapping
     ),
     running AS (
       SELECT SUM(delta) OVER (ORDER BY at, tie_break
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS in_use
         FROM events
     )
     SELECT COALESCE(MAX(in_use), 0)::int AS peak FROM running`,
    [equipmentTypeId, slot.starts_at, slot.ends_at],
  );

  return result.rows[0]?.peak ?? 0;
}
