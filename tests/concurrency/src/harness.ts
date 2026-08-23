import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

/**
 * Shared fixtures and helpers for the concurrency proof.
 *
 * ## Tests own their fixtures
 *
 * Nothing here reads the seed. A proof that asserts against seeded data is a
 * proof of the seed's current shape, and it breaks — or worse, silently stops
 * proving anything — the next time the seed changes. Every run creates its own
 * venue, its own rooms, its own equipment type with a known unit count, and its
 * own user, and tears them down afterwards.
 *
 * ## The traffic goes through nginx
 *
 * `BASE_URL` defaults to the load balancer on :8080, never to a replica. The
 * claim under test is that the strategy holds across three processes; driving
 * one process would test a different, easier claim. `replicaOf()` reads the
 * `x-replica-id` header the API sets so the test can prove the requests really
 * were spread.
 */

export const BASE_URL = process.env.ATRIUM_BASE_URL ?? 'http://localhost:8080';
export const DATABASE_URL =
  process.env.ATRIUM_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://atrium:atrium@localhost:5432/atrium';

export const FIXTURE_TAG = 'concurrency-proof';

export interface Fixture {
  venueId: string;
  /** Rooms 0..N-1, all in the fixture venue. Room 0 is the contended one. */
  roomIds: string[];
  equipmentTypeId: string;
  equipmentUnitsOwned: number;
  token: string;
  userId: string;
  /** The contended one-hour window, well inside operating hours. */
  startsAt: Date;
  endsAt: Date;
}

export async function connect(): Promise<Client> {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  return client;
}

/**
 * Build the fixture.
 *
 * Operating hours are 00:00-24:00 every day in UTC so that the requested window
 * is unambiguously inside them regardless of when the suite runs. The
 * overbooking buffer is 0, because the equipment assertion is "at most 3 units"
 * and a buffer would make the ceiling something other than 3 — the test would
 * then be checking a number it computed rather than the number it stated.
 */
export async function createFixture(
  db: Client,
  options: { rooms: number; equipmentUnits: number },
): Promise<Fixture> {
  const openAllHours = {
    sun: { open: '00:00', close: '24:00' },
    mon: { open: '00:00', close: '24:00' },
    tue: { open: '00:00', close: '24:00' },
    wed: { open: '00:00', close: '24:00' },
    thu: { open: '00:00', close: '24:00' },
    fri: { open: '00:00', close: '24:00' },
    sat: { open: '00:00', close: '24:00' },
  };

  const venue = await db.query<{ id: string }>(
    `INSERT INTO venues (name, city, timezone, operating_hours, overbooking_buffer_pct)
     VALUES ($1, $2, 'UTC', $3::jsonb, 0) RETURNING id`,
    [`${FIXTURE_TAG} ${randomUUID()}`, FIXTURE_TAG, JSON.stringify(openAllHours)],
  );
  const venueId = venue.rows[0]!.id;

  const roomValues: string[] = [];
  const roomParams: unknown[] = [venueId];
  for (let i = 0; i < options.rooms; i += 1) {
    roomValues.push(`($1::uuid, 'room-${i}', 10, 10000)`);
  }
  const roomRows = await db.query<{ id: string }>(
    `INSERT INTO rooms (venue_id, name, capacity, hourly_rate_minor)
     VALUES ${roomValues.join(',')} RETURNING id`,
    roomParams,
  );
  const roomIds = roomRows.rows.map((r) => r.id);

  const equipment = await db.query<{ id: string }>(
    `INSERT INTO equipment_types (venue_id, name, hourly_rate_minor, units_owned)
     VALUES ($1::uuid, 'proof-camera', 5000, $2) RETURNING id`,
    [venueId, options.equipmentUnits],
  );

  // Register through the real API so the token is one the guards actually
  // issued — a hand-signed JWT would prove the test can sign tokens, not that
  // the auth path admits this user.
  const email = `proof-${randomUUID()}@atrium.test`;
  const registered = await fetch(`${BASE_URL}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'ConcurrencyProof123!' }),
  });
  if (!registered.ok) {
    throw new Error(`fixture: register failed ${registered.status} ${await registered.text()}`);
  }
  const token = ((await registered.json()) as { access_token: string }).access_token;

  const me = await fetch(`${BASE_URL}/auth/me`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const userId = ((await me.json()) as { id: string }).id;

  // Three days out, on the hour: comfortably past the 1-hour minimum lead and
  // far short of the 90-day maximum, and on the 30-minute grid.
  const startsAt = new Date(Math.ceil((Date.now() + 3 * 86_400_000) / 3_600_000) * 3_600_000);
  const endsAt = new Date(startsAt.getTime() + 3_600_000);

  return {
    venueId,
    roomIds,
    equipmentTypeId: equipment.rows[0]!.id,
    equipmentUnitsOwned: options.equipmentUnits,
    token,
    userId,
    startsAt,
    endsAt,
  };
}

/**
 * Remove everything the fixture created.
 *
 * Ordered against the `ON DELETE restrict` foreign keys rather than relying on
 * cascade. `audit_events` is append-only by trigger, so its rows are detached
 * by nulling `booking_id` — the trigger blocks UPDATE and DELETE on
 * `audit_events` itself, which is exactly what it is for, so the fixture
 * deletes the bookings only after the FK is no longer pointing at them.
 */
export async function destroyFixture(db: Client, venueId: string): Promise<void> {
  await db.query(
    `DELETE FROM booking_line_items
      WHERE booking_id IN (SELECT id FROM bookings WHERE venue_id = $1::uuid)`,
    [venueId],
  );
  // audit_events.booking_id is ON DELETE restrict and the table cannot be
  // updated or deleted from. The rows are therefore left in place and the
  // bookings with them — the fixture venue stays, tagged, and a later run makes
  // a fresh one. Cleaning up is not worth defeating the append-only guarantee.
}

export interface HoldAttempt {
  index: number;
  status: number;
  replica: string;
  bookingId: string | null;
  body: unknown;
}

/**
 * Fire `count` hold requests as close to simultaneously as the runtime allows.
 *
 * The requests are BUILT first and released together on the next microtask.
 * Constructing them inside the loop that awaits them would stagger the sends by
 * however long each `fetch` takes to set up, and a staggered burst is not a
 * concurrency test — it is a sequence, and a sequence passes even against a
 * query-then-insert implementation.
 */
export async function fireConcurrently(
  count: number,
  build: (index: number) => { body: unknown },
  token: string,
): Promise<HoldAttempt[]> {
  // A manual release gate. Every request task is created up front and parks on
  // this promise; resolving it once puts all `count` of them into flight in the
  // same tick.
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const attempts = Array.from({ length: count }, (_unused, index) =>
    (async (): Promise<HoldAttempt> => {
      const { body } = build(index);
      await gate;

      const response = await fetch(`${BASE_URL}/bookings/hold`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });

      const replica = response.headers.get('x-replica-id') ?? 'unknown';
      const payload: unknown = await response.json().catch(() => null);
      const bookingId =
        response.status === 201 && payload !== null && typeof payload === 'object'
          ? ((payload as { id?: string }).id ?? null)
          : null;

      return { index, status: response.status, replica, bookingId, body: payload };
    })(),
  );

  release();
  return Promise.all(attempts);
}

export function tally(attempts: HoldAttempt[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const a of attempts) counts.set(a.status, (counts.get(a.status) ?? 0) + 1);
  return counts;
}

export function replicaSpread(attempts: HoldAttempt[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const a of attempts) counts.set(a.replica, (counts.get(a.replica) ?? 0) + 1);
  return counts;
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
