import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import {
  assertNoLeak,
  call,
  connect,
  createWorld,
  secretsOf,
  waitForApi,
  type Probe,
  type Principal,
  type Tenant,
  type World,
} from './harness.js';
import { recordProbe, unprobed } from './routes.js';

/**
 * INV-6 — tenant isolation. The brief's REQUIRED NEGATIVE TEST.
 *
 * The claim under test: a VENUE_ADMIN or VENUE_STAFF of Venue A, holding a
 * valid token and addressing a **real** Venue B UUID, gets a denial and no
 * data — on every venue-scoped route, read and write, single and list. A
 * PLATFORM_ADMIN is the positive control: without it the suite would pass
 * against a server that denies everyone.
 *
 * Runs against the load balancer on :8080, not a replica, for the same reason
 * the concurrency proof does: the claim is about the deployed system.
 */

let db: Client;
let world: World;

/** Denials are 404 by design (ARCHITECTURE.md Assumption 6); 403 also satisfies the brief. */
function expectDenied(probe: Probe, other: Tenant): void {
  expect([403, 404]).toContain(probe.status);
  assertNoLeak(probe, secretsOf(other));
}

beforeAll(async () => {
  await waitForApi();
  db = await connect();
  world = await createWorld(db);
}, 120_000);

afterAll(async () => {
  await db?.end();
});

// ---------------------------------------------------------------------------
// Cross-venue reads and writes, by real UUID
// ---------------------------------------------------------------------------

describe('a venue principal cannot reach another venue by direct valid UUID', () => {
  const actors: { name: string; pick: (t: Tenant) => Principal }[] = [
    { name: 'VENUE_ADMIN', pick: (t) => t.admin },
    { name: 'VENUE_STAFF', pick: (t) => t.staff },
  ];

  for (const actor of actors) {
    it(`${actor.name} of A: GET /bookings/:id of B is denied`, async () => {
      recordProbe('GET /bookings/:id');
      const me = actor.pick(world.a);
      const probe = await call('GET', `/bookings/${world.b.bookingId}`, me);
      expectDenied(probe, world.b);
      // The id is the one thing the caller already knew. Everything else about
      // the row — who owns it, which room, which venue — must be absent.
      expect(probe.text).not.toContain(world.b.customer.userId);
    });

    it(`${actor.name} of A: POST /bookings/:id/checkout on B is denied`, async () => {
      recordProbe('POST /bookings/:id/checkout');
      const probe = await call('POST', `/bookings/${world.b.heldBookingId}/checkout`, actor.pick(world.a));
      expectDenied(probe, world.b);
    });

    it(`${actor.name} of A: POST /bookings/:id/cancel on B is denied`, async () => {
      recordProbe('POST /bookings/:id/cancel');
      const probe = await call('POST', `/bookings/${world.b.heldBookingId}/cancel`, actor.pick(world.a), {
        reason: 'cross-tenant probe',
      });
      expectDenied(probe, world.b);
    });

    it(`${actor.name} of A: POST /bookings/:id/pay on B is denied`, async () => {
      recordProbe('POST /bookings/:id/pay');
      const probe = await call('POST', `/bookings/${world.b.heldBookingId}/pay`, actor.pick(world.a));
      expectDenied(probe, world.b);
    });

    it(`${actor.name} of A: GET /equipment-types/:id of B is denied`, async () => {
      recordProbe('GET /equipment-types/:id');
      const probe = await call('GET', `/equipment-types/${world.b.equipmentTypeId}`, actor.pick(world.a));
      expectDenied(probe, world.b);
    });
  }

  it('the write probes did not mutate venue B', async () => {
    // A denial that still performed the write would pass every status
    // assertion above. Read the rows back rather than trusting the response.
    const rows = await db.query<{ id: string; status: string }>(
      `SELECT id, status FROM bookings WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[world.b.bookingId, world.b.heldBookingId]],
    );
    const byId = new Map(rows.rows.map((r) => [r.id, r.status]));
    expect(byId.get(world.b.bookingId)).toBe('CONFIRMED');
    expect(byId.get(world.b.heldBookingId)).toBe('HELD');
  });
});

// ---------------------------------------------------------------------------
// Lists — the leak that has no UUID in the URL
// ---------------------------------------------------------------------------

describe('list endpoints do not leak the other venue', () => {
  it('GET /bookings for A contains no venue B row', async () => {
    recordProbe('GET /bookings');
    const probe = await call('GET', '/bookings?page_size=100', world.a.admin);
    expect(probe.status).toBe(200);

    const body = probe.json as { data: { venue_id: string; id: string }[] };
    expect(body.data.every((row) => row.venue_id === world.a.venueId)).toBe(true);
    expect(body.data.some((row) => row.id === world.b.bookingId)).toBe(false);
  });

  it('GET /equipment-types for A contains no venue B row', async () => {
    recordProbe('GET /equipment-types');
    const probe = await call('GET', '/equipment-types', world.a.admin);
    expect(probe.status).toBe(200);

    const body = probe.json as { data: { id: string; venue_id: string }[] };
    expect(body.data.every((row) => row.venue_id === world.a.venueId)).toBe(true);
    assertNoLeak(probe, [world.b.equipmentTypeId, world.b.venueId]);
  });
});

// ---------------------------------------------------------------------------
// Policy — venue-scoped writes with no id in the request at all
// ---------------------------------------------------------------------------

describe('cancellation policy is scoped to the token venue', () => {
  it('GET returns the caller venue policy and never another venue id', async () => {
    recordProbe('GET /venues/cancellation-policy');
    const probe = await call('GET', '/venues/cancellation-policy', world.a.admin);
    expect(probe.status).toBe(200);
    assertNoLeak(probe, [world.b.venueId]);
  });

  it('PUT by A cannot change B — the venue comes from the token, not the body', async () => {
    recordProbe('PUT /venues/cancellation-policy');

    const before = await call('GET', '/venues/cancellation-policy', world.b.admin);
    expect(before.status).toBe(200);

    // A `venue_id` in the body is the attack. It must be ignored, not honoured.
    //
    // The ladder is complete and bottoms out at zero. An earlier version of this
    // test sent a single 72-hour tier and got a 422 — correctly, because
    // TiersSchema refuses a ladder a cancellation could fall off the end of. It
    // also meant the request was rejected before the `venue_id` could do
    // anything, so the test was passing its own validation check while proving
    // nothing at all about tenant scoping.
    const written = await call('PUT', '/venues/cancellation-policy', world.a.admin, {
      venue_id: world.b.venueId,
      tiers: [
        { min_hours_before: 72, room_refund_pct: 100, equipment_refund_pct: 100 },
        { min_hours_before: 24, room_refund_pct: 40, equipment_refund_pct: 90 },
        { min_hours_before: 0, room_refund_pct: 0, equipment_refund_pct: 0 },
      ],
    });
    expect([200, 201]).toContain(written.status);

    const after = await call('GET', '/venues/cancellation-policy', world.b.admin);
    expect((after.json as { tiers: unknown }).tiers).toEqual(
      (before.json as { tiers: unknown }).tiers,
    );

    const mine = await call('GET', '/venues/cancellation-policy', world.a.admin);
    expect((mine.json as { tiers: { min_hours_before: number }[] }).tiers[0]!.min_hours_before).toBe(72);
  });
});

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

describe('reports', () => {
  it('GET /admin/reconciliation is refused to a VENUE_ADMIN and served to a PLATFORM_ADMIN', async () => {
    recordProbe('GET /admin/reconciliation');
    const range = 'from=2000-01-01T00:00:00.000Z&to=2100-01-01T00:00:00.000Z';

    const denied = await call('GET', `/admin/reconciliation?${range}`, world.a.admin);
    expect([403, 404]).toContain(denied.status);
    assertNoLeak(denied, secretsOf(world.b));

    const allowed = await call('GET', `/admin/reconciliation?${range}`, world.platformAdmin);
    expect(allowed.status).toBe(200);
  });

  it('GET /venues/reports/revenue reports the token venue, and a venue_id in the query changes nothing', async () => {
    recordProbe('GET /venues/reports/revenue');
    // Sixty days forward, not the century-wide window the reconciliation probe
    // above uses. This report caps its range at 366 days and answers 422 beyond
    // it, and the window still has to CONTAIN the fixture bookings — they sit
    // 10 to 12 days out — or `by_room` comes back empty and the no-leak
    // assertion passes without having had anything to leak.
    const now = Date.now();
    const range =
      `from=${new Date(now - 86_400_000).toISOString()}` +
      `&to=${new Date(now + 60 * 86_400_000).toISOString()}`;

    const mine = await call('GET', `/venues/reports/revenue?${range}`, world.a.admin);
    expect(mine.status).toBe(200);
    expect((mine.json as { venue_id: string }).venue_id).toBe(world.a.venueId);
    // The report names rooms, so B's room id is exactly the kind of thing that
    // would leak if the scope came from anywhere but the token — and A's own
    // room being present is what makes its absence meaningful.
    expect(mine.text).toContain(world.a.roomId);
    assertNoLeak(mine, secretsOf(world.b));

    // There is no `venue_id` parameter on this route. Sending one anyway is the
    // attack, and the only acceptable outcomes are "ignored" or "rejected" —
    // never "honoured". Asserting the venue is still A's covers both.
    const tampered = await call(
      'GET',
      `/venues/reports/revenue?${range}&venue_id=${world.b.venueId}`,
      world.a.admin,
    );
    expect(tampered.status).toBe(200);
    expect((tampered.json as { venue_id: string }).venue_id).toBe(world.a.venueId);
    assertNoLeak(tampered, secretsOf(world.b));

    // The documented mirror of reconciliation: a PLATFORM_ADMIN has no venue in
    // their token, so this route refuses them rather than inventing one or
    // silently widening to the whole platform. See ReportsController.
    const platform = await call('GET', `/venues/reports/revenue?${range}`, world.platformAdmin);
    expect([403, 404]).toContain(platform.status);
  });
});

// ---------------------------------------------------------------------------
// Catalogue routes — cross-venue by design, and therefore checked for what
// they must NOT carry rather than for a denial
// ---------------------------------------------------------------------------

describe('public catalogue routes carry no tenant data', () => {
  it('GET /rooms/:id/availability for B returns free/busy only, no booking or customer identifiers', async () => {
    recordProbe('GET /rooms/:id/availability');
    const from = new Date(Date.now() + 9 * 86_400_000).toISOString();
    const to = new Date(Date.now() + 12 * 86_400_000).toISOString();

    const probe = await call(
      'GET',
      `/rooms/${world.b.roomId}/availability?from=${from}&to=${to}&duration_minutes=60`,
      world.a.admin,
    );

    // Availability is deliberately reachable across venues: cross-venue search
    // is a Tier-1 requirement, and a customer cannot book what they cannot see
    // the calendar for. What it must never do is describe WHO holds a slot.
    expect(probe.status).toBe(200);
    assertNoLeak(probe, [
      world.b.bookingId,
      world.b.heldBookingId,
      world.b.customer.userId,
      world.b.customer.email,
    ]);
  });

  it('GET /rooms/:id for B is readable and carries only catalogue fields', async () => {
    recordProbe('GET /rooms/:id');
    const probe = await call('GET', `/rooms/${world.b.roomId}`, world.a.admin);

    // Deliberately readable across venues — it is one row of the catalogue
    // `/search` already publishes, and a room the catalogue advertises cannot
    // become secret when addressed by its own id. See CROSS_VENUE_BY_DESIGN.
    expect(probe.status).toBe(200);
    expect((probe.json as { id: string }).id).toBe(world.b.roomId);

    // The projection is the assertion. Nothing about B's customers, bookings or
    // staff may ride along, and no operational figure may appear here later
    // without this failing first.
    assertNoLeak(probe, [
      world.b.bookingId,
      world.b.heldBookingId,
      world.b.customer.userId,
      world.b.customer.email,
      world.b.admin.email,
    ]);
    for (const forbidden of ['revenue', 'utilisation', 'utilization', 'occupancy']) {
      expect(probe.text.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('GET /rooms/:id/equipment-types is readable by a CUSTOMER and leaks nothing operational', async () => {
    recordProbe('GET /rooms/:id/equipment-types');

    // The role that actually books. Until P8 this list did not exist and
    // `GET /equipment-types` answered a customer 403, so equipment line items
    // were unreachable through the UI by the only role that can use them.
    const probe = await call('GET', `/rooms/${world.b.roomId}/equipment-types`, world.a.customer);
    expect(probe.status).toBe(200);

    const body = probe.json as {
      data: { id: string; name: string; units_owned: number; hourly_rate_minor: string }[];
    };
    expect(body.data.some((row) => row.id === world.b.equipmentTypeId)).toBe(true);

    // Exactly four keys. A fifth is the failure this test exists for: peak
    // usage, how many are out right now, or anything a competitor could poll.
    for (const row of body.data) {
      expect(Object.keys(row).sort()).toEqual([
        'hourly_rate_minor',
        'id',
        'name',
        'units_owned',
        'venue_id',
      ]);
    }

    assertNoLeak(probe, [
      world.b.bookingId,
      world.b.heldBookingId,
      world.b.customer.userId,
      world.b.customer.email,
      world.b.admin.email,
    ]);
    for (const forbidden of ['peak', 'in_use', 'reserved', 'revenue', 'utilis', 'utiliz']) {
      expect(probe.text.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('GET /search returns rooms across venues but no booking or customer identifiers', async () => {
    recordProbe('GET /search');
    const probe = await call('GET', '/search?city=' + encodeURIComponent(`authz-inv6-B`), world.a.admin);
    expect(probe.status).toBe(200);
    assertNoLeak(probe, [
      world.b.bookingId,
      world.b.heldBookingId,
      world.b.customer.userId,
      world.b.customer.email,
      world.b.admin.email,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Venue administration — writes, which is where isolation actually costs money
// ---------------------------------------------------------------------------

describe('venue administration is scoped to the token venue', () => {
  it('GET /venues/settings returns the caller venue and never another', async () => {
    recordProbe('GET /venues/settings');

    const probe = await call('GET', '/venues/settings', world.a.admin);
    expect(probe.status).toBe(200);
    expect((probe.json as { id: string }).id).toBe(world.a.venueId);
    assertNoLeak(probe, secretsOf(world.b));

    // A PLATFORM_ADMIN has no venue on their token, so there is nothing to
    // administer through this route. Refused rather than given a guess.
    const platform = await call('GET', '/venues/settings', world.platformAdmin);
    expect([403, 404]).toContain(platform.status);
  });

  it('PATCH /venues/settings by A cannot touch B, even naming B in the body', async () => {
    recordProbe('PATCH /venues/settings');

    const beforeB = await db.query<{ pct: number; name: string }>(
      `SELECT overbooking_buffer_pct AS pct, name FROM venues WHERE id = $1::uuid`,
      [world.b.venueId],
    );

    // `venue_id` and `id` are not parameters of this endpoint. Sending them is
    // the attack: the only acceptable outcomes are ignored or rejected, never
    // honoured. There is no check to forget because there is nothing to check.
    const written = await call('PATCH', '/venues/settings', world.a.admin, {
      venue_id: world.b.venueId,
      id: world.b.venueId,
      overbooking_buffer_pct: 7,
      name: 'renamed by the wrong tenant',
    });
    expect(written.status).toBe(200);
    expect((written.json as { id: string }).id).toBe(world.a.venueId);

    // Read the row back. A write that was "denied" but still landed would pass
    // every status assertion above.
    const afterB = await db.query<{ pct: number; name: string }>(
      `SELECT overbooking_buffer_pct AS pct, name FROM venues WHERE id = $1::uuid`,
      [world.b.venueId],
    );
    expect(afterB.rows[0]).toEqual(beforeB.rows[0]);

    const afterA = await db.query<{ pct: number }>(
      `SELECT overbooking_buffer_pct AS pct FROM venues WHERE id = $1::uuid`,
      [world.a.venueId],
    );
    expect(afterA.rows[0]!.pct).toBe(7);
  });

  it('the buffer is capped at 10% and a room may not carry one at all', async () => {
    const tooHigh = await call('PATCH', '/venues/settings', world.a.admin, {
      overbooking_buffer_pct: 40,
    });
    expect(tooHigh.status).toBe(422);

    const stored = await db.query<{ pct: number }>(
      `SELECT overbooking_buffer_pct AS pct FROM venues WHERE id = $1::uuid`,
      [world.a.venueId],
    );
    expect(stored.rows[0]!.pct).toBeLessThanOrEqual(10);

    // The P2 rule that had never run against a real request: a room is one
    // physical space, so a buffer on it would violate INV-1 directly.
    const onARoom = await call('POST', '/venues/rooms', world.a.admin, {
      name: 'buffered room',
      capacity: 4,
      hourly_rate_minor: '5000',
      overbooking_buffer_pct: 5,
    });
    expect(onARoom.status).toBe(422);
    expect(onARoom.text).toContain('INV-1');

    const created = await db.query(
      `SELECT 1 FROM rooms WHERE venue_id = $1::uuid AND name = 'buffered room'`,
      [world.a.venueId],
    );
    expect(created.rowCount).toBe(0);
  });

  it('GET /venues/rooms lists only the caller venue rooms', async () => {
    recordProbe('GET /venues/rooms');
    const probe = await call('GET', '/venues/rooms', world.a.admin);
    expect(probe.status).toBe(200);

    const body = probe.json as { data: { id: string; venue_id: string }[] };
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.every((row) => row.venue_id === world.a.venueId)).toBe(true);
    assertNoLeak(probe, [world.b.roomId, world.b.venueId]);
  });

  it('POST /venues/rooms writes to the token venue, whatever the body claims', async () => {
    recordProbe('POST /venues/rooms');

    const name = `census room ${Date.now()}`;
    const probe = await call('POST', '/venues/rooms', world.a.admin, {
      venue_id: world.b.venueId,
      name,
      capacity: 8,
      hourly_rate_minor: '12345',
      amenities: ['wifi'],
    });
    expect([200, 201]).toContain(probe.status);
    expect((probe.json as { venue_id: string }).venue_id).toBe(world.a.venueId);

    const row = await db.query<{ venue_id: string }>(
      `SELECT venue_id FROM rooms WHERE name = $1`,
      [name],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]!.venue_id).toBe(world.a.venueId);
  });

  it('PATCH /venues/rooms/:id of B by A is refused and changes nothing', async () => {
    recordProbe('PATCH /venues/rooms/:id');

    const before = await db.query<{ name: string; rate: string }>(
      `SELECT name, hourly_rate_minor::text AS rate FROM rooms WHERE id = $1::uuid`,
      [world.b.roomId],
    );

    const probe = await call('PATCH', `/venues/rooms/${world.b.roomId}`, world.a.admin, {
      name: 'repriced by the wrong tenant',
      hourly_rate_minor: '1',
    });
    expectDenied(probe, world.b);

    const after = await db.query<{ name: string; rate: string }>(
      `SELECT name, hourly_rate_minor::text AS rate FROM rooms WHERE id = $1::uuid`,
      [world.b.roomId],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('POST /venues/equipment-types writes to the token venue, whatever the body claims', async () => {
    recordProbe('POST /venues/equipment-types');

    const name = `census camera ${Date.now()}`;
    const probe = await call('POST', '/venues/equipment-types', world.a.admin, {
      venue_id: world.b.venueId,
      name,
      hourly_rate_minor: '4000',
      units_owned: 3,
    });
    expect([200, 201]).toContain(probe.status);
    expect((probe.json as { venue_id: string }).venue_id).toBe(world.a.venueId);

    const row = await db.query<{ venue_id: string }>(
      `SELECT venue_id FROM equipment_types WHERE name = $1`,
      [name],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]!.venue_id).toBe(world.a.venueId);
  });

  it('PATCH /venues/equipment-types/:id of B by A is refused and changes nothing', async () => {
    recordProbe('PATCH /venues/equipment-types/:id');

    const before = await db.query<{ units: number; rate: string }>(
      `SELECT units_owned AS units, hourly_rate_minor::text AS rate
         FROM equipment_types WHERE id = $1::uuid`,
      [world.b.equipmentTypeId],
    );

    const probe = await call(
      'PATCH',
      `/venues/equipment-types/${world.b.equipmentTypeId}`,
      world.a.admin,
      { units_owned: 999, hourly_rate_minor: '1' },
    );
    expectDenied(probe, world.b);

    const after = await db.query<{ units: number; rate: string }>(
      `SELECT units_owned AS units, hourly_rate_minor::text AS rate
         FROM equipment_types WHERE id = $1::uuid`,
      [world.b.equipmentTypeId],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('a VENUE_STAFF may read the settings but not write them', async () => {
    const read = await call('GET', '/venues/settings', world.a.staff);
    expect(read.status).toBe(200);

    // Staff run the desk. What the venue charges, when it opens and how much
    // inventory it claims to own is an owner's decision.
    for (const [method, path, body] of [
      ['PATCH', '/venues/settings', { overbooking_buffer_pct: 0 }],
      ['POST', '/venues/rooms', { name: 'staff room', capacity: 2, hourly_rate_minor: '100' }],
      ['POST', '/venues/equipment-types', { name: 'staff kit', hourly_rate_minor: '100', units_owned: 1 }],
    ] as const) {
      const probe = await call(method, path, world.a.staff, body);
      expect([403, 404]).toContain(probe.status);
    }

    const leaked = await db.query(
      `SELECT 1 FROM rooms WHERE venue_id = $1::uuid AND name = 'staff room'`,
      [world.a.venueId],
    );
    expect(leaked.rowCount).toBe(0);
  });

  it('a CUSTOMER cannot reach venue administration at all', async () => {
    // A body only on the verbs that take one — `fetch` refuses a GET with one,
    // and the failure looks like a test bug rather than an authorisation
    // result, which is exactly what it was the first time this ran.
    for (const [method, path, body] of [
      ['GET', '/venues/settings', undefined],
      ['PATCH', '/venues/settings', { overbooking_buffer_pct: 0 }],
      ['GET', '/venues/rooms', undefined],
      ['POST', '/venues/rooms', { name: 'customer room', capacity: 2, hourly_rate_minor: '100' }],
    ] as const) {
      const probe = await call(method, path, world.a.customer, body);
      expect([403, 404], `${method} ${path}`).toContain(probe.status);
    }
  });
});

// ---------------------------------------------------------------------------
// Holds — the write that legitimately crosses venues, and its one boundary
// ---------------------------------------------------------------------------

describe('a hold cannot staple one venue equipment to another venue room', () => {
  it('POST /bookings/hold with A room and B equipment is refused and creates nothing', async () => {
    recordProbe('POST /bookings/hold');

    const startsAt = new Date(Math.ceil((Date.now() + 5 * 86_400_000) / 3_600_000) * 3_600_000);
    const probe = await call('POST', '/bookings/hold', world.a.customer, {
      room_id: world.a.roomId,
      starts_at: startsAt.toISOString(),
      ends_at: new Date(startsAt.getTime() + 3_600_000).toISOString(),
      line_items: [{ equipment_type_id: world.b.equipmentTypeId, quantity: 1 }],
    });

    expect(probe.status).toBe(422);

    const created = await db.query(
      `SELECT 1 FROM bookings WHERE room_id = $1::uuid AND starts_at = $2`,
      [world.a.roomId, startsAt.toISOString()],
    );
    expect(created.rowCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Customers, and the positive control
// ---------------------------------------------------------------------------

describe('customers and the platform admin', () => {
  it('a CUSTOMER cannot read another customer booking', async () => {
    const probe = await call('GET', `/bookings/${world.b.bookingId}`, world.a.customer);
    expect([403, 404]).toContain(probe.status);
    assertNoLeak(probe, secretsOf(world.b));
  });

  it('a CUSTOMER list contains only their own bookings', async () => {
    const probe = await call('GET', '/bookings?page_size=100', world.a.customer);
    expect(probe.status).toBe(200);
    const body = probe.json as { data: { user_id: string }[] };
    expect(body.data.every((row) => row.user_id === world.a.customer.userId)).toBe(true);
  });

  it('a PLATFORM_ADMIN reads both venues — the suite cannot pass by denying everyone', async () => {
    for (const tenant of [world.a, world.b]) {
      const probe = await call('GET', `/bookings/${tenant.bookingId}`, world.platformAdmin);
      expect(probe.status).toBe(200);
      expect((probe.json as { venue_id: string }).venue_id).toBe(tenant.venueId);
    }
  });

  it('an unauthenticated request reaches nothing', async () => {
    const probe = await call('GET', `/bookings/${world.a.bookingId}`, null);
    expect(probe.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// The ledger. Declared last on purpose — vitest runs a file in declaration
// order, so by the time this executes every probe above has had its turn.
// ---------------------------------------------------------------------------

describe('probe ledger', () => {
  it('every route listed as probed was actually requested', () => {
    // `routes.ts` claims a set of covered routes and `route-census.unit.test.ts`
    // holds the API to it. This closes the other end: a route cannot be claimed
    // as covered by writing a line in a list — a real request has to have been
    // made against it.
    expect(unprobed(), 'listed in PROBED but never requested').toEqual([]);
  });
});
