import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

/**
 * Fixtures for the INV-6 tenant isolation suite.
 *
 * ## The suite owns its fixtures
 *
 * Nothing here reads the seed script. A negative test that asserts against
 * seeded rows is asserting the seed's current shape: change the seed and the
 * suite either breaks noisily or — far worse — quietly stops proving anything,
 * because the "other venue" it probes no longer exists and every request
 * legitimately 404s. Every run builds its own two venues from nothing.
 *
 * ## Two of everything
 *
 * Venue A and Venue B each get a room, an equipment type, a VENUE_ADMIN, a
 * VENUE_STAFF and a CONFIRMED booking. Plus a CUSTOMER per venue who owns those
 * bookings, and one PLATFORM_ADMIN as the positive control — without which the
 * whole suite would pass against a server that denies everyone everything.
 *
 * ## Real UUIDs, real tokens
 *
 * Every cross-venue probe uses the actual primary key of the other venue's row,
 * read back from the INSERT. A 404 on a fabricated UUID proves only that the
 * row does not exist. Tokens are minted by the running API's own login path,
 * never hand-signed here: a hand-signed JWT would prove this file can sign, not
 * that the guards admit this user.
 */

export const BASE_URL = process.env.ATRIUM_BASE_URL ?? 'http://localhost:8080';
export const DATABASE_URL =
  process.env.ATRIUM_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://atrium:atrium@localhost:5432/atrium';

export const FIXTURE_TAG = 'authz-inv6';

const PASSWORD = 'TenantIsolation123!';

const OPEN_ALL_HOURS = {
  sun: { open: '00:00', close: '24:00' },
  mon: { open: '00:00', close: '24:00' },
  tue: { open: '00:00', close: '24:00' },
  wed: { open: '00:00', close: '24:00' },
  thu: { open: '00:00', close: '24:00' },
  fri: { open: '00:00', close: '24:00' },
  sat: { open: '00:00', close: '24:00' },
};

export interface Principal {
  userId: string;
  email: string;
  token: string;
  role: string;
  venueId: string | null;
  label: string;
}

export interface Tenant {
  label: 'A' | 'B';
  venueId: string;
  roomId: string;
  equipmentTypeId: string;
  admin: Principal;
  staff: Principal;
  customer: Principal;
  /** CONFIRMED, owned by `customer`, at `venueId`. */
  bookingId: string;
  /** HELD and unexpired, so write verbs have a legal target to be refused on. */
  heldBookingId: string;
}

export interface World {
  a: Tenant;
  b: Tenant;
  platformAdmin: Principal;
}

export async function connect(): Promise<Client> {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  return client;
}

/** Wait until the load balancer answers, so a cold stack does not fail the run. */
export async function waitForApi(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'never attempted';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.ok) return;
      lastError = `status ${res.status}`;
    } catch (err: unknown) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`API at ${BASE_URL} never became healthy: ${lastError}`);
}

/**
 * Mint a principal at a given role.
 *
 * `POST /auth/register` deliberately refuses to honour a `role` in its body —
 * it always produces a CUSTOMER, and P1 verified that. So a privileged
 * principal is made in three steps: register, promote in SQL, log in again. The
 * second login is the point: the token's claims are re-read from the row, so
 * the suite exercises the same token-minting path a real admin would.
 */
async function makePrincipal(
  db: Client,
  label: string,
  role: string,
  venueId: string | null,
): Promise<Principal> {
  // Lowercased here, and it is not cosmetic.
  //
  // `POST /auth/register` normalises the address before storing it, so a
  // fixture label like `adminA` produces a row spelled `admina` and the
  // promotion below — `WHERE email = $3` — matches ZERO rows. Postgres reports
  // that as a perfectly successful UPDATE, the principal stays a CUSTOMER, and
  // the whole suite then passes for the wrong reason: every cross-venue probe
  // is denied because the caller is a customer with no venue at all, not
  // because tenant isolation works. Found by running it; the role assertion at
  // the end of this function is what caught it.
  const email = `${FIXTURE_TAG}-${label}-${randomUUID()}@atrium.test`.toLowerCase();

  const registered = await fetch(`${BASE_URL}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!registered.ok) {
    throw new Error(
      `fixture: register ${label} failed ${registered.status} ${await registered.text()}`,
    );
  }

  if (role !== 'CUSTOMER') {
    const promoted = await db.query(
      `UPDATE users SET role = $1::user_role, venue_id = $2::uuid WHERE email = $3`,
      [role, venueId, email],
    );
    // An UPDATE that matches nothing is a successful UPDATE as far as Postgres
    // is concerned. Checked here so the failure names its own cause instead of
    // surfacing three lines later as a confusing role mismatch.
    if (promoted.rowCount !== 1) {
      throw new Error(
        `fixture: promoting ${label} to ${role} matched ${promoted.rowCount} rows, expected 1 (email ${email})`,
      );
    }
  }

  const loggedIn = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!loggedIn.ok) {
    throw new Error(`fixture: login ${label} failed ${loggedIn.status} ${await loggedIn.text()}`);
  }
  const token = ((await loggedIn.json()) as { access_token: string }).access_token;

  const me = (await (
    await fetch(`${BASE_URL}/auth/me`, { headers: { authorization: `Bearer ${token}` } })
  ).json()) as { id: string; role: string };

  if (me.role !== role) {
    throw new Error(`fixture: ${label} minted as ${me.role}, expected ${role}`);
  }

  return { userId: me.id, email, token, role, venueId, label };
}

/**
 * One tenant: venue, room, equipment type, three users, two bookings.
 *
 * Bookings are inserted in SQL rather than through `POST /bookings/hold`,
 * because the hold path applies operating hours, lead time and the exclusion
 * constraint — none of which this suite is about, all of which would make the
 * fixture fail for reasons unrelated to authorisation. `slot` is generated by
 * Postgres either way, so the rows are indistinguishable from real ones.
 */
async function createTenant(db: Client, label: 'A' | 'B', offsetDays: number): Promise<Tenant> {
  const venue = await db.query<{ id: string }>(
    `INSERT INTO venues (name, city, timezone, operating_hours, overbooking_buffer_pct)
     VALUES ($1, $2, 'UTC', $3::jsonb, 0) RETURNING id`,
    [
      `${FIXTURE_TAG} venue ${label} ${randomUUID()}`,
      `${FIXTURE_TAG}-${label}`,
      JSON.stringify(OPEN_ALL_HOURS),
    ],
  );
  const venueId = venue.rows[0]!.id;

  const room = await db.query<{ id: string }>(
    `INSERT INTO rooms (venue_id, name, capacity, hourly_rate_minor)
     VALUES ($1::uuid, $2, 10, 10000) RETURNING id`,
    [venueId, `room-${label}`],
  );
  const roomId = room.rows[0]!.id;

  const equipment = await db.query<{ id: string }>(
    `INSERT INTO equipment_types (venue_id, name, hourly_rate_minor, units_owned)
     VALUES ($1::uuid, $2, 5000, 4) RETURNING id`,
    [venueId, `camera-${label}`],
  );
  const equipmentTypeId = equipment.rows[0]!.id;

  const admin = await makePrincipal(db, `admin${label}`, 'VENUE_ADMIN', venueId);
  const staff = await makePrincipal(db, `staff${label}`, 'VENUE_STAFF', venueId);
  const customer = await makePrincipal(db, `cust${label}`, 'CUSTOMER', null);

  // Offset per tenant so A's and B's fixture bookings can never collide on the
  // exclusion constraint.
  const base = Date.now() + (10 + offsetDays) * 86_400_000;
  const startsAt = new Date(Math.ceil(base / 3_600_000) * 3_600_000);
  const endsAt = new Date(startsAt.getTime() + 3_600_000);

  const confirmed = await db.query<{ id: string }>(
    `INSERT INTO bookings (venue_id, room_id, user_id, starts_at, ends_at, status, total_minor, currency)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'CONFIRMED', 10000, 'PKR') RETURNING id`,
    [venueId, roomId, customer.userId, startsAt.toISOString(), endsAt.toISOString()],
  );

  const heldStart = new Date(startsAt.getTime() + 4 * 3_600_000);
  const held = await db.query<{ id: string }>(
    `INSERT INTO bookings (venue_id, room_id, user_id, starts_at, ends_at, status, expires_at, total_minor, currency)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'HELD', now() + interval '1 hour', 10000, 'PKR')
     RETURNING id`,
    [
      venueId,
      roomId,
      customer.userId,
      heldStart.toISOString(),
      new Date(heldStart.getTime() + 3_600_000).toISOString(),
    ],
  );

  return {
    label,
    venueId,
    roomId,
    equipmentTypeId,
    admin,
    staff,
    customer,
    bookingId: confirmed.rows[0]!.id,
    heldBookingId: held.rows[0]!.id,
  };
}

export async function createWorld(db: Client): Promise<World> {
  const a = await createTenant(db, 'A', 0);
  const b = await createTenant(db, 'B', 30);
  const platformAdmin = await makePrincipal(db, 'platform', 'PLATFORM_ADMIN', null);
  return { a, b, platformAdmin };
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

export interface Probe {
  status: number;
  /** The raw body, asserted on directly — not just the status. */
  text: string;
  json: unknown;
}

export async function call(
  method: string,
  path: string,
  principal: Principal | null,
  body?: unknown,
): Promise<Probe> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (principal) headers.authorization = `Bearer ${principal.token}`;

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const text = await res.text();
  let json: unknown = null;
  try {
    json = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, text, json };
}

/**
 * The body assertion, and it matters as much as the status.
 *
 * "and never data" is the brief's phrase. A 403 whose message helpfully names
 * the room, or a 404 that echoes the venue it could not find, has still
 * confirmed the row exists and handed back an identifier the prober did not
 * have. So every denial is checked against every identifier belonging to the
 * other tenant, not merely for a status code.
 */
export function assertNoLeak(probe: Probe, forbidden: string[]): void {
  const haystack = probe.text.toLowerCase();
  const leaked = forbidden.filter(
    (needle) => needle.length > 0 && haystack.includes(needle.toLowerCase()),
  );
  if (leaked.length > 0) {
    throw new Error(
      `response leaked identifiers belonging to the other tenant: ${leaked.join(', ')}\nbody: ${probe.text}`,
    );
  }
}

/** Everything about a tenant that a denial must never echo back. */
export function secretsOf(tenant: Tenant): string[] {
  return [
    tenant.venueId,
    tenant.roomId,
    tenant.equipmentTypeId,
    tenant.customer.userId,
    tenant.customer.email,
    tenant.admin.userId,
    tenant.admin.email,
    tenant.staff.email,
  ];
}
