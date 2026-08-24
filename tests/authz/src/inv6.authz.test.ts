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
