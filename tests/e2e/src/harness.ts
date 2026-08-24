import { createHmac, randomUUID } from 'node:crypto';
import { Client } from 'pg';

/**
 * Fixtures and helpers for the payment integrity suite.
 *
 * ## Deterministic control instead of waiting on a probability
 *
 * Paygate runs with `PAYGATE_CHAOS=on` here, exactly as the deployed stack
 * does. That is right for the population and useless for a single test: a
 * duplicate delivery fires 30% of the time and a late one 5%, so a test that
 * waits for either is a coin flip wearing an assertion. Every scenario below
 * therefore FORCES its own case through `POST /paygate/_test/deliver` and
 * `/_test/delay` — the control surface documented as an extension in
 * `apps/paygate/README.md` — and asserts on the outcome rather than hoping.
 *
 * Natural deliveries still arrive alongside the forced ones. That is not noise
 * to be suppressed: absorbing them is precisely what INV-3 claims to do.
 *
 * ## The suite owns its fixtures
 *
 * Same rule as `tests/authz` and the concurrency proof, for the same reason:
 * asserting against seeded rows is asserting the seed's current shape.
 */

export const BASE_URL = process.env.ATRIUM_BASE_URL ?? 'http://localhost:8080';
export const PAYGATE_URL = process.env.ATRIUM_PAYGATE_URL ?? 'http://localhost:9000';
export const PAYGATE_SECRET = process.env.PAYGATE_SECRET ?? 'dev-paygate-hmac-secret';
export const DATABASE_URL =
  process.env.ATRIUM_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://atrium:atrium@localhost:5432/atrium';

export const FIXTURE_TAG = 'e2e-payments';

const PASSWORD = 'PaymentIntegrity123!';

const OPEN_ALL_HOURS = {
  sun: { open: '00:00', close: '24:00' },
  mon: { open: '00:00', close: '24:00' },
  tue: { open: '00:00', close: '24:00' },
  wed: { open: '00:00', close: '24:00' },
  thu: { open: '00:00', close: '24:00' },
  fri: { open: '00:00', close: '24:00' },
  sat: { open: '00:00', close: '24:00' },
};

/** Room 10000/h, equipment 5000/h. A one-hour hold with one unit costs 15000. */
export const ROOM_RATE_MINOR = 10_000n;
export const EQUIPMENT_RATE_MINOR = 5_000n;

export interface World {
  venueId: string;
  roomIds: string[];
  equipmentTypeId: string;
  customer: { userId: string; token: string; email: string };
  platformAdmin: { userId: string; token: string; email: string };
}

export async function connect(): Promise<Client> {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  return client;
}

export async function waitForStack(timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'never attempted';

  while (Date.now() < deadline) {
    try {
      const [api, paygate] = await Promise.all([
        fetch(`${BASE_URL}/health`),
        fetch(`${PAYGATE_URL}/health`),
      ]);
      if (api.ok && paygate.ok) {
        const gate = (await paygate.json()) as { test_endpoints: string };
        if (gate.test_endpoints !== 'on') {
          throw new Error(
            'Paygate test endpoints are off. This suite needs PAYGATE_TEST_ENDPOINTS=on and NODE_ENV != production.',
          );
        }
        return;
      }
      lastError = `api ${api.status}, paygate ${paygate.status}`;
    } catch (err: unknown) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await sleep(1_000);
  }

  throw new Error(`stack never became ready: ${lastError}`);
}

async function makeUser(
  db: Client,
  label: string,
  role: 'CUSTOMER' | 'PLATFORM_ADMIN',
): Promise<{ userId: string; token: string; email: string }> {
  // Lowercased: register normalises the address, so a mixed-case label would
  // make the promotion below match zero rows. tests/authz learned this the
  // expensive way.
  const email = `${FIXTURE_TAG}-${label}-${randomUUID()}@atrium.test`.toLowerCase();

  const registered = await fetch(`${BASE_URL}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!registered.ok) {
    throw new Error(`fixture: register ${label} failed ${registered.status}`);
  }

  if (role !== 'CUSTOMER') {
    const promoted = await db.query(
      `UPDATE users SET role = $1::user_role WHERE email = $2`,
      [role, email],
    );
    if (promoted.rowCount !== 1) {
      throw new Error(`fixture: promoting ${label} matched ${promoted.rowCount} rows`);
    }
  }

  const loggedIn = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!loggedIn.ok) throw new Error(`fixture: login ${label} failed ${loggedIn.status}`);

  const token = ((await loggedIn.json()) as { access_token: string }).access_token;
  const me = (await (
    await fetch(`${BASE_URL}/auth/me`, { headers: { authorization: `Bearer ${token}` } })
  ).json()) as { id: string; role: string };

  if (me.role !== role) throw new Error(`fixture: ${label} is ${me.role}, expected ${role}`);

  return { userId: me.id, token, email };
}

/**
 * One venue, several rooms, one equipment type, a customer and a platform admin.
 *
 * Several rooms because each scenario books its own, so no scenario can be
 * rejected by another scenario's booking sitting in the exclusion constraint.
 */
export async function createWorld(db: Client, rooms = 8): Promise<World> {
  const venue = await db.query<{ id: string }>(
    `INSERT INTO venues (name, city, timezone, operating_hours, overbooking_buffer_pct)
     VALUES ($1, $2, 'UTC', $3::jsonb, 0) RETURNING id`,
    [`${FIXTURE_TAG} ${randomUUID()}`, FIXTURE_TAG, JSON.stringify(OPEN_ALL_HOURS)],
  );
  const venueId = venue.rows[0]!.id;

  const roomIds: string[] = [];
  for (let i = 0; i < rooms; i += 1) {
    const room = await db.query<{ id: string }>(
      `INSERT INTO rooms (venue_id, name, capacity, hourly_rate_minor)
       VALUES ($1::uuid, $2, 10, $3::bigint) RETURNING id`,
      [venueId, `e2e-room-${i}`, ROOM_RATE_MINOR.toString()],
    );
    roomIds.push(room.rows[0]!.id);
  }

  const equipment = await db.query<{ id: string }>(
    `INSERT INTO equipment_types (venue_id, name, hourly_rate_minor, units_owned)
     VALUES ($1::uuid, 'e2e-camera', $2::bigint, 20) RETURNING id`,
    [venueId, EQUIPMENT_RATE_MINOR.toString()],
  );

  return {
    venueId,
    roomIds,
    equipmentTypeId: equipment.rows[0]!.id,
    customer: await makeUser(db, 'customer', 'CUSTOMER'),
    platformAdmin: await makeUser(db, 'platform', 'PLATFORM_ADMIN'),
  };
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

export interface Response<T = unknown> {
  status: number;
  body: T;
  text: string;
}

export async function api<T = unknown>(
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<Response<T>> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...extraHeaders,
  };
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed as T, text };
}

export interface HoldResponse {
  id: string;
  status: string;
  total_minor: string;
  expires_at: string | null;
}

/** A hold `hoursAhead` from now, on a fresh grid-aligned boundary. */
export async function createHold(
  world: World,
  roomIndex: number,
  hoursAhead: number,
  withEquipment = true,
): Promise<HoldResponse> {
  const startsAt = new Date(
    Math.ceil((Date.now() + hoursAhead * 3_600_000) / 1_800_000) * 1_800_000,
  );
  const endsAt = new Date(startsAt.getTime() + 3_600_000);

  const res = await api<HoldResponse>('POST', '/bookings/hold', world.customer.token, {
    room_id: world.roomIds[roomIndex],
    starts_at: startsAt.toISOString(),
    ends_at: endsAt.toISOString(),
    line_items: withEquipment
      ? [{ equipment_type_id: world.equipmentTypeId, quantity: 1 }]
      : [],
  });

  if (res.status !== 201) {
    throw new Error(`hold failed ${res.status}: ${res.text}`);
  }
  return res.body;
}

export interface PayResponse {
  payment_id: string;
  booking_id: string;
  charge_id: string | null;
  status: string;
  amount_minor: string;
  outcome: string;
}

/**
 * Pay, retrying through Paygate's 10% transient-failure branch.
 *
 * The retry is not a workaround, it is the contract under test. Paygate records
 * the idempotency key BEFORE deciding to return 500, so the charge survives the
 * failure and a retry adopts it rather than minting a second one. Atrium derives
 * that key from the booking id, so this loop cannot produce two charges no
 * matter how many times it goes round — which is the assertion the INV-3
 * scenario then makes explicitly against Paygate's own records.
 */
export async function pay(
  world: World,
  bookingId: string,
  attempts = 6,
  headers: Record<string, string> = {},
): Promise<PayResponse> {
  let last = '';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const res = await api<PayResponse>(
      'POST',
      `/bookings/${bookingId}/pay`,
      world.customer.token,
      undefined,
      headers,
    );
    if (res.status === 200) return res.body;
    last = `${res.status} ${res.text}`;
    // 502 is Paygate's transient branch surfacing through our client.
    if (res.status !== 502 && res.status !== 503) break;
    await sleep(150 * attempt);
  }
  throw new Error(`pay failed after ${attempts} attempts: ${last}`);
}

// ---------------------------------------------------------------------------
// Paygate control surface
// ---------------------------------------------------------------------------

export interface DeliveryRecord {
  delivery_id: string;
  response_status: number | null;
  signature_corrupted: boolean;
  event: string;
}

export async function paygate<T = unknown>(
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${PAYGATE_URL}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

/**
 * Force `times` deliveries of one event, now. Each gets a fresh delivery id.
 *
 * `corrupt_signature` defaults to **false**, which is a deliberate departure
 * from Paygate's own default of "draw the seeded 2% branch".
 *
 * The reason is that this is the suite's instrument, not its subject. A forced
 * delivery exists to put a known event in front of the API; letting it corrupt
 * its own signature 2% of the time means roughly one run in fourteen fails an
 * INV-3 assertion for a reason INV-3 is not about. That happened on the first
 * green run here: three of twenty-seven deliveries drew the branch and the API
 * correctly answered 401 to all three.
 *
 * Nothing is hidden by this. Paygate's NATURAL deliveries still draw the branch
 * and still arrive in the middle of these tests, and the bad-signature block
 * forces it on deliberately.
 */
export async function deliver(
  chargeId: string,
  options: { event?: string; times?: number; corruptSignature?: boolean } = {},
): Promise<DeliveryRecord[]> {
  const res = await paygate<{ deliveries: DeliveryRecord[] }>('/paygate/_test/deliver', {
    charge_id: chargeId,
    ...(options.event ? { event: options.event } : {}),
    times: options.times ?? 1,
    corrupt_signature: options.corruptSignature ?? false,
  });
  if (res.status !== 200) {
    throw new Error(`_test/deliver failed ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res.body.deliveries;
}

/** Park the next delivery. Omit `chargeId` to arm it before the charge exists. */
export async function armDelay(seconds: number, chargeId?: string): Promise<void> {
  const res = await paygate('/paygate/_test/delay', {
    seconds,
    ...(chargeId ? { charge_id: chargeId } : {}),
  });
  if (res.status !== 200) throw new Error(`_test/delay failed ${res.status}`);
}

/** Sign a body exactly as Paygate does — over the raw bytes that go on the wire. */
export function signBody(raw: string): string {
  return createHmac('sha256', PAYGATE_SECRET).update(raw, 'utf8').digest('hex');
}

/**
 * POST a webhook straight at the API, bypassing Paygate.
 *
 * The only way to test a delivery for a charge Paygate never issued: Paygate
 * cannot be asked to send one for a charge it does not have.
 */
export async function postWebhook(
  raw: string,
  options: { signature?: string; deliveryId?: string } = {},
): Promise<{ status: number; text: string }> {
  const res = await fetch(`${BASE_URL}/webhooks/paygate`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-paygate-signature': options.signature ?? signBody(raw),
      'x-paygate-delivery': options.deliveryId ?? randomUUID(),
    },
    body: raw,
  });
  return { status: res.status, text: await res.text() };
}

// ---------------------------------------------------------------------------
// Waiting
// ---------------------------------------------------------------------------

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll the database until a booking reaches one of `statuses`.
 *
 * Polling and not sleeping-then-asserting: the webhook path is asynchronous by
 * design, so a fixed sleep is either flaky or slow, and usually both.
 */
export async function waitForStatus(
  db: Client,
  bookingId: string,
  statuses: string[],
  timeoutMs = 30_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let seen = 'unknown';

  while (Date.now() < deadline) {
    const res = await db.query<{ status: string }>(
      `SELECT status FROM bookings WHERE id = $1::uuid`,
      [bookingId],
    );
    seen = res.rows[0]?.status ?? 'missing';
    if (statuses.includes(seen)) return seen;
    await sleep(250);
  }

  throw new Error(
    `booking ${bookingId} was ${seen} after ${timeoutMs}ms, expected one of ${statuses.join(', ')}`,
  );
}

/** Poll until `check` passes, so an assertion never races the async worker. */
export async function waitFor<T>(
  what: string,
  probe: () => Promise<T>,
  check: (value: T) => boolean,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;

  while (Date.now() < deadline) {
    last = await probe();
    if (check(last)) return last;
    await sleep(250);
  }

  throw new Error(`timed out waiting for ${what}; last saw ${JSON.stringify(last)}`);
}
