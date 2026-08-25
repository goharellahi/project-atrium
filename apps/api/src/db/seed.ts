/* eslint-disable no-console */
import { Pool, type PoolClient } from 'pg';
import { hash } from '@node-rs/argon2';
import { fromLocalParts, toLocalParts, WEEKDAY_KEYS } from '../common/time/zoned-time';

/**
 * Atrium seed. One script, two profiles, one code path.
 *
 *   pnpm --filter @atrium/api db:seed -- --profile=demo
 *   pnpm --filter @atrium/api db:seed -- --profile=full
 *
 * ## The constraint that shapes this entire file
 *
 * `no_room_overlap` is live while the seed runs. Generating booking times
 * randomly would mean every collision is a rejected INSERT and an aborted
 * transaction, and as each room's calendar fills the collision rate climbs
 * toward one — at 250,000 rows it would not finish. So slots are not sampled,
 * they are WALKED: for each room, a cursor moves forward through the calendar,
 * emits a booking, and advances past the turnaround. Non-overlap is a property
 * of the generator, not something the database has to enforce after the fact.
 * Density is varied per room instead of varying times randomly, which produces
 * a realistically uneven calendar without reintroducing collisions.
 * (ARCHITECTURE.md §7, Assumption 4.)
 *
 * ## Determinism
 *
 * A seeded LCG, not `Math.random()`. Two runs of the same profile produce the
 * same database, so a query plan captured in P7 can be compared against a later
 * one, and a bug found against seeded data can be reproduced.
 */

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

interface Profile {
  name: string;
  venues: number;
  rooms: number;
  equipmentUnits: number;
  users: number;
  bookings: number;
  monthsBack: number;
  monthsForward: number;
  cities: readonly City[];
}

interface City {
  name: string;
  timezone: string;
  currency: string;
}

const CITIES: readonly City[] = [
  { name: 'Karachi', timezone: 'Asia/Karachi', currency: 'PKR' },
  { name: 'Dubai', timezone: 'Asia/Dubai', currency: 'AED' },
  { name: 'London', timezone: 'Europe/London', currency: 'GBP' },
];

const PROFILES: Record<string, Profile> = {
  /**
   * Sized to fit a 500 MB free-tier database with room to spare. 25k bookings
   * plus their line items and audit rows lands around 30 MB including indexes;
   * the gist index on `slot` is the largest single object.
   */
  demo: {
    name: 'demo',
    venues: 8,
    rooms: 60,
    equipmentUnits: 200,
    users: 400,
    bookings: 25_000,
    // 18 months. The span is not cosmetic: a room can only emit
    // `open_hours / (avg_duration + turnaround)` bookings per day, so the
    // calendar has to be wide enough that every room's apportioned share fits
    // inside what its own density can produce. Too narrow and the quiet rooms
    // run out of days and the seed quietly under-delivers.
    monthsBack: 12,
    monthsForward: 6,
    cities: CITIES,
  },
  full: {
    name: 'full',
    venues: 40,
    rooms: 800,
    equipmentUnits: 2_500,
    users: 5_000,
    bookings: 250_000,
    // 24 months, as the brief asks for.
    monthsBack: 18,
    monthsForward: 6,
    cities: CITIES,
  },
};

// ---------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------

/**
 * A 32-bit linear congruential generator (Numerical Recipes constants).
 *
 * Not cryptographic and not trying to be. What it must be is REPRODUCIBLE, so
 * that "the seed produced a booking that breaks X" is a claim someone else can
 * check. `Math.random()` cannot make that promise.
 */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const pick = <T>(rng: () => number, items: readonly T[]): T =>
  items[Math.floor(rng() * items.length)]!;

const intBetween = (rng: () => number, lo: number, hi: number): number =>
  lo + Math.floor(rng() * (hi - lo + 1));

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

const AMENITIES = [
  'wifi', 'air_conditioning', 'blackout', 'grand_piano', 'drum_kit',
  'iso_booth', 'green_screen', 'cyclorama', 'live_room', 'street_level',
  'loading_bay', 'kitchenette',
] as const;

const ROOM_PREFIXES = [
  'Studio', 'Live Room', 'Control Room', 'Rehearsal', 'Stage',
  'Tracking Room', 'Edit Suite', 'Podcast Booth',
] as const;

const EQUIPMENT_NAMES = [
  'Canon C70 Cinema Camera',
  'Sennheiser MKH 416 Shotgun Mic',
  'Aputure 600d LED',
  'Neumann U87 Condenser',
  'DJI RS4 Gimbal',
  'Yamaha Stage Piano',
] as const;

const VENUE_SUFFIXES = [
  'Sound', 'Studios', 'Works', 'Collective', 'House', 'Rooms', 'Lab', 'Yard',
] as const;

/** A weekday-keyed operating-hours blob. Sundays are shorter, one day is closed. */
function operatingHours(rng: () => number): Record<string, { open: string; close: string } | null> {
  const closedDay = pick(rng, WEEKDAY_KEYS);
  const openHour = intBetween(rng, 7, 10);
  const closeHour = intBetween(rng, 19, 23);

  const hours: Record<string, { open: string; close: string } | null> = {};
  for (const day of WEEKDAY_KEYS) {
    if (day === closedDay) {
      hours[day] = null;
    } else if (day === 'sun') {
      hours[day] = { open: `${pad(openHour + 2)}:00`, close: `${pad(closeHour - 3)}:00` };
    } else {
      hours[day] = { open: `${pad(openHour)}:00`, close: `${pad(closeHour)}:00` };
    }
  }
  return hours;
}

const pad = (n: number): string => String(n).padStart(2, '0');

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface SeedSummary {
  profile: string;
  venues: number;
  rooms: number;
  equipmentTypes: number;
  users: number;
  policies: number;
  /** How many of `policies` are venue overrides rather than the platform default. */
  venuePolicies: number;
  /** Settled bookings that were given a frozen cancellation policy. */
  snapshots: number;
  payments: number;
  bookings: number;
  lineItems: number;
  /** What the generator meant to write, so a divergence from the count shows. */
  intendedBookings: number;
  intendedLineItems: number;
  emptyWindow: { room_id: string; room_name: string; starts_at: string; ends_at: string } | null;
  logins: { role: string; email: string; password: string; venue: string | null }[];
  elapsedSeconds: number;
}

/**
 * Run a profile against a database URL. The CLI and the boot-time path both
 * come through here, so there is exactly one seeding implementation.
 *
 * Exported because Render's free tier has no shell: the only way to seed the
 * deployed database is from inside the process that can already reach it. See
 * `seedOnBootIfUnseeded` in `main.ts` for the guard that makes that safe.
 */
export async function runSeed(
  profileName: string,
  databaseUrl: string,
): Promise<SeedSummary> {
  const profile = PROFILES[profileName];
  if (!profile) {
    throw new Error(
      `Unknown profile "${profileName}". Expected one of: ${Object.keys(PROFILES).join(', ')}`,
    );
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();

  try {
    return await seed(client, profile);
  } finally {
    client.release();
    await pool.end();
  }
}

async function main(): Promise<void> {
  const profileArg =
    process.argv.find((a) => a.startsWith('--profile='))?.split('=')[1] ?? 'demo';

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  report(await runSeed(profileArg, databaseUrl));
}

const SEED_PASSWORD = 'AtriumDemo123!';

async function seed(client: PoolClient, profile: Profile): Promise<SeedSummary> {
  const startedAt = Date.now();
  // Fixed seed. Same profile in, same database out.
  const rng = makeRng(0xa7_21_00_01);

  console.log(`seeding profile "${profile.name}"`);

  await truncate(client);

  /**
   * One argon2id hash, computed once and reused for every seeded account.
   *
   * The parameters are memory-hard by design (19 MiB, ~50 ms each), so hashing
   * 5,000 distinct users would cost four minutes of pure CPU and prove nothing
   * — every seeded account shares the same known password anyway. Hashing once
   * keeps the seed honest (these are real argon2id hashes, verifiable by the
   * real login path) without paying for 5,000 identical computations.
   */
  const passwordHash = await hash(SEED_PASSWORD, {
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });

  // Immediately after the truncate, and before anything can need it.
  //
  // `truncate()` empties `cancellation_policies`, which includes the platform
  // default that migration 0003 inserted — and a migration runs once, so a
  // rebuilt database never gets it back. Restoring it here is not tidiness:
  // without that row every confirmation throws while resolving its policy
  // snapshot, so no booking can reach CONFIRMED at all. See the P5 log.
  const platformPolicies = await seedCancellationPolicies(client);

  const venues = await seedVenues(client, profile, rng);

  // After the venues exist and before any booking does, so that every snapshot
  // resolved below has the full set of policies to resolve against.
  const venuePolicies = await seedVenuePolicies(client, venues, profile, rng);
  const policies = platformPolicies + venuePolicies;
  const rooms = await seedRooms(client, profile, venues, rng);
  const equipment = await seedEquipment(client, profile, venues, rng);
  const users = await seedUsers(client, profile, venues, passwordHash, rng);

  const { bookings, lineItems, emptyWindow } = await seedBookings(
    client,
    profile,
    venues,
    rooms,
    equipment,
    users,
    rng,
  );

  // Every settled booking gets the payment it implies. See seedPayments.
  const payments = await seedPayments(client);

  // ...and the cancellation terms it was settled under. Must run after the
  // bookings exist and after every policy row does. See seedPolicySnapshots.
  const snapshots = await seedPolicySnapshots(client);

  await client.query('ANALYZE');

  /**
   * The summary is counted FROM THE DATABASE, not from what this process thinks
   * it inserted.
   *
   * P5 caught the demo profile advertising 25,000 bookings and delivering
   * 14,138, and the only reason that was catchable is that somebody went and
   * counted. A summary assembled from in-memory tallies can only ever report
   * the generator's intent — it agrees with itself by construction, including
   * when a batch was rejected or an apportionment lost rows. Counting the
   * tables closes that loop. It also caught this file over-reporting its own
   * user count by three, which nobody had noticed because nothing checked.
   *
   * `written` is still returned alongside so a divergence is visible rather
   * than smoothed over: if the generator meant to write 250,000 and the table
   * holds fewer, the seed says both numbers.
   */
  const counted = await countRows(client);

  return {
    profile: profile.name,
    venues: counted.venues,
    rooms: counted.rooms,
    equipmentTypes: counted.equipment_types,
    users: counted.users,
    policies,
    venuePolicies,
    snapshots,
    payments: counted.payments,
    bookings: counted.bookings,
    lineItems: counted.booking_line_items,
    intendedBookings: bookings,
    intendedLineItems: lineItems,
    emptyWindow,
    logins: users.logins,
    elapsedSeconds: Math.round((Date.now() - startedAt) / 100) / 10,
  };
}

interface RowCounts {
  venues: number;
  rooms: number;
  equipment_types: number;
  users: number;
  bookings: number;
  booking_line_items: number;
  payments: number;
}

/** Row counts straight from the tables the seed just wrote. */
async function countRows(client: PoolClient): Promise<RowCounts> {
  const { rows } = await client.query<Record<keyof RowCounts, string>>(`
    SELECT (SELECT count(*) FROM venues)             AS venues,
           (SELECT count(*) FROM rooms)              AS rooms,
           (SELECT count(*) FROM equipment_types)    AS equipment_types,
           (SELECT count(*) FROM users)              AS users,
           (SELECT count(*) FROM bookings)           AS bookings,
           (SELECT count(*) FROM booking_line_items) AS booking_line_items,
           (SELECT count(*) FROM payments)           AS payments
  `);
  const row = rows[0]!;
  return {
    venues: Number(row.venues),
    rooms: Number(row.rooms),
    equipment_types: Number(row.equipment_types),
    users: Number(row.users),
    bookings: Number(row.bookings),
    booking_line_items: Number(row.booking_line_items),
    payments: Number(row.payments),
  };
}

/**
 * Order matters — foreign keys are `ON DELETE restrict`, deliberately, so a
 * booking cannot be orphaned in production. RESTART IDENTITY CASCADE truncates
 * the whole graph in one statement instead of fighting that ordering.
 *
 * `audit_events` has a BEFORE UPDATE OR DELETE trigger enforcing append-only.
 * TRUNCATE is neither, so it passes — which is the correct behaviour: the
 * trigger exists to stop the application rewriting history, not to make a
 * database rebuild impossible.
 */
async function truncate(client: PoolClient): Promise<void> {
  await client.query(`
    TRUNCATE TABLE
      audit_events, webhook_deliveries, payment_events, payments,
      booking_line_items, bookings, cancellation_policies,
      users, equipment_types, rooms, venues
    RESTART IDENTITY CASCADE
  `);
}

/**
 * Put back the platform default cancellation policy that `truncate` removed.
 *
 * Migration `0003` inserts this row, and a migration runs exactly once. The
 * seed then truncates the table, so on any rebuilt-and-seeded database the row
 * was simply gone — and because the application resolves a booking's policy
 * snapshot at the moment of confirmation, its absence meant every
 * `charge.succeeded` threw and no booking could reach CONFIRMED. The endpoint
 * that reads the policy returned 500 for the same reason.
 *
 * That is the whole bug, and it is worth stating what class it belongs to:
 * data the application cannot run without was owned by a migration, while a
 * different file was free to delete it. Restoring it here makes the seed
 * responsible for the contents of every table it empties.
 *
 * The tiers are duplicated from `0003` rather than imported from it, because
 * a migration is a historical artefact — editing it to share a constant with
 * runtime code would mean changing a migration that has already run.
 */
async function seedCancellationPolicies(client: PoolClient): Promise<number> {
  await client.query(`
    INSERT INTO cancellation_policies (venue_id, tiers, created_at)
    VALUES (NULL, '[
      { "min_hours_before": 48, "room_refund_pct": 100, "equipment_refund_pct": 100 },
      { "min_hours_before": 24, "room_refund_pct": 50,  "equipment_refund_pct": 100 },
      { "min_hours_before": 2,  "room_refund_pct": 0,   "equipment_refund_pct": 100 },
      { "min_hours_before": 0,  "room_refund_pct": 0,   "equipment_refund_pct": 0 }
    ]'::jsonb,
    -- Backdated deliberately, and it is load bearing rather than decorative.
    -- Snapshots are resolved AS OF the booking's confirmation, and the seed
    -- writes bookings up to eighteen months old. A platform default stamped
    -- now() would post-date most of them, so an as-of resolution would find no
    -- policy at all for the oldest bookings. The platform default has existed
    -- for as long as the platform has; saying so here makes that true in data.
    now() - interval '3 years')
  `);

  return 1;
}

/**
 * Give some venues their own cancellation policy, written partway through the
 * seeded history.
 *
 * ## Why the seed writes these at all
 *
 * Two reasons, and the second is the one that matters.
 *
 * First, `resolved_from: 'venue'` was unreachable on demo data: every venue
 * inherited the platform default, so the override half of "policy is data, not
 * code" had nothing behind it on the deployed instance.
 *
 * Second — and this is the property most likely to be probed — a venue policy
 * whose `created_at` sits in the MIDDLE of that venue's booking history is what
 * makes the snapshot demonstrable. Bookings that venue confirmed before the
 * change carry the platform tiers; bookings it confirmed after carry the
 * venue's. Both are visible at once, on one venue, in one list. If every policy
 * were written at seed time the snapshots would all resolve identically and a
 * reviewer would have no way to see that freezing them did anything.
 *
 * `cancellation_policies` is append-only, so this is an INSERT per venue and
 * never an UPDATE — the same rule the live endpoint follows.
 */
async function seedVenuePolicies(
  client: PoolClient,
  venues: SeededVenue[],
  profile: Profile,
  rng: () => number,
): Promise<number> {
  const values: unknown[] = [];
  const tuples: string[] = [];

  for (const [i, venue] of venues.entries()) {
    // Every third venue, so the platform default remains the common case and
    // the override is visibly the exception.
    if (i % 3 !== 0) continue;

    // Somewhere in the older half of the booking window, so that venue has
    // bookings on both sides of the change.
    const monthsAgo = 1 + rng() * Math.max(1, profile.monthsBack - 1);

    // Stricter than the platform default in the 24-48 hour band, so a booking
    // cancelled in that window refunds a visibly different amount depending on
    // which side of the change it was confirmed.
    const tiers = [
      { min_hours_before: 72, room_refund_pct: 100, equipment_refund_pct: 100 },
      { min_hours_before: 24, room_refund_pct: 25, equipment_refund_pct: 50 },
      { min_hours_before: 0, room_refund_pct: 0, equipment_refund_pct: 0 },
    ];

    const base = values.length;
    values.push(venue.id, JSON.stringify(tiers), monthsAgo.toFixed(3));
    tuples.push(
      `($${base + 1}::uuid, $${base + 2}::jsonb,` +
        ` now() - ($${base + 3}::numeric * interval '1 month'))`,
    );
  }

  if (tuples.length === 0) return 0;

  await client.query(
    `INSERT INTO cancellation_policies (venue_id, tiers, created_at)
     VALUES ${tuples.join(',')}`,
    values,
  );

  return tuples.length;
}

/**
 * Freeze onto every settled booking the cancellation policy that was live when
 * it confirmed.
 *
 * ## The gap this closes
 *
 * The seed writes CONFIRMED, COMPLETED, CANCELLED and REFUNDED rows directly
 * into the table. The live path that reaches those states is
 * `onChargeSucceeded`, and that is where `policy_snapshot` is written — so no
 * seeded booking had one. On the deployed demo data every booking detail page
 * read "No terms are frozen onto this booking" and the cancel panel could not
 * quote a refund, which made the entire policy-as-data story invisible on
 * exactly the data a reviewer looks at first.
 *
 * ## Why the fix is here and not in the cancellation path
 *
 * The tempting fix is to have cancellation fall back to the live policy when a
 * booking has no snapshot. That would be a correctness regression wearing the
 * costume of a convenience: the guarantee is that a policy change cannot alter
 * an already CONFIRMED booking, and a fallback silently breaks it for every
 * booking whose snapshot is missing for any reason — including the ones where
 * it is missing because something went wrong. A missing snapshot on a CONFIRMED
 * booking is a defect to see, not a case to paper over. So the seed writes
 * what the live path would have written, and the cancellation path stays
 * strict.
 *
 * ## As of when
 *
 * `bookings.created_at`, which for a seeded settled booking is its confirmation
 * — the seed has no separate holding phase. The lateral picks the newest policy
 * for that venue that already existed at that instant, falling back to the
 * newest platform policy that already existed at that instant. That is exactly
 * `PaymentsService.resolveTiers`, with "at that instant" added; the live one
 * needs no as-of clause because for it the instant is always now.
 *
 * CANCELLED is included alongside the other three. A seeded cancellation is a
 * cancellation OF a confirmed booking — that is the only cancellation that
 * moves money — so the terms it was cancelled under are precisely the thing
 * that should be on the row.
 */
async function seedPolicySnapshots(client: PoolClient): Promise<number> {
  // `src` is the same table again, and it has to be.
  //
  // A LATERAL in an UPDATE ... FROM may only reference tables in the FROM
  // clause, and the UPDATE target is not one of them — Postgres answers
  // "invalid reference to FROM-clause entry for table b". Joining `bookings`
  // back in under another name gives the lateral something it is allowed to
  // correlate with, and `src.id = b.id` keeps it to one row per booking.
  const updated = await client.query(`
    UPDATE bookings b
       SET policy_snapshot = jsonb_build_object(
             'tiers', p.tiers,
             'policy_id', p.id,
             'resolved_from', CASE WHEN p.venue_id IS NULL THEN 'platform' ELSE 'venue' END,
             'snapshot_at', to_char(src.created_at AT TIME ZONE 'UTC',
                                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
           )
      FROM bookings src
      JOIN LATERAL (
        SELECT cp.id, cp.tiers, cp.venue_id
          FROM cancellation_policies cp
         WHERE (cp.venue_id = src.venue_id OR cp.venue_id IS NULL)
           AND cp.created_at <= src.created_at
         -- A venue's own policy beats the platform default; among those, the
         -- newest that already existed wins. Same precedence as resolveTiers.
         ORDER BY (cp.venue_id IS NOT NULL) DESC, cp.created_at DESC
         LIMIT 1
      ) p ON true
     WHERE src.id = b.id
       AND b.status IN ('CONFIRMED','COMPLETED','CANCELLED','REFUNDED')
  `);

  return updated.rowCount ?? 0;
}

/**
 * Give every settled booking the payment it implies.
 *
 * Without this the seed produces thousands of CONFIRMED and COMPLETED bookings
 * with no captured charge behind them — and that is not a cosmetic gap, it is
 * precisely the `confirmation_without_capture` discrepancy: a room given away
 * for free. `GET /admin/reconciliation` reported it correctly, in the thousands,
 * on a freshly seeded database, which meant INV-5's "zero discrepancies on
 * clean data" could never be demonstrated.
 *
 * The reconciler was right and the seed was wrong. Fixed on the seed's side
 * rather than by teaching the report to ignore seeded rows, which would have
 * blinded it to the real failure it exists to catch.
 *
 * Rows are synthesised in SQL from the bookings that already exist:
 *
 *   - CONFIRMED / COMPLETED -> a SUCCEEDED payment for the full total, plus the
 *     `charge.succeeded` event that a real capture would have written.
 *   - REFUNDED              -> a REFUNDED payment with `refunded_minor` set,
 *     plus both events, so `refund_without_capture` does not fire on them.
 *   - CANCELLED / EXPIRED / HELD -> nothing. No money ever moved.
 *
 * Keys and ids follow the same derivation the live path uses (`charge:<booking>`),
 * so a seeded booking is indistinguishable from one that went through Paygate
 * and `POST /bookings/:id/pay` on it is idempotent for the same reason.
 *
 * ## What these charges are NOT, said plainly
 *
 * `ch_seed_<uuid>` is invented here. Paygate is a separate process with its own
 * store and has never heard of it, so a REFUND against a seeded charge is
 * rejected 404 `unknown_charge` and can never settle. Found in P8 by cancelling
 * a seeded CONFIRMED booking through the console: the refund is quoted
 * correctly, the cancellation succeeds, the booking becomes CANCELLED, the
 * refund key is minted — and the money never comes back, which
 * `GET /admin/reconciliation` then reports as `refund_initiated_not_settled`.
 * The report is right. The seed is what is lying.
 *
 * Three ways to make it true were considered and all three are worse:
 *
 *   1. **Register every charge with Paygate.** 20,000 HTTP calls into a service
 *      that fails 10% of them on purpose, and whose store is in memory — one
 *      restart and the data is synthetic again.
 *   2. **Register only the cancellable ones.** Paygate mints its own charge
 *      ids, so the seed would have to write back whatever it returned; and
 *      every charge it accepts triggers a webhook to the API, which would try
 *      to CONFIRM bookings that are already CONFIRMED and fill the audit trail
 *      with illegal-transition errors. Seeding by side effect.
 *   3. **Special-case `ch_seed_` in the refund path.** A payment path that
 *      knows about seed data is a fail condition, not a shortcut.
 *
 * So the seed states the limitation instead of hiding it: it is printed at the
 * end of every run, it is in README's Known Issues, and the API now records the
 * provider's own rejection on the payment row so the reconciliation report can
 * say which kind of failure it found. A refund of a booking made through the
 * console settles for real; only seeded history cannot.
 */
async function seedPayments(client: PoolClient): Promise<number> {
  const inserted = await client.query(`
    INSERT INTO payments
      (booking_id, idempotency_key, charge_id, amount_minor, status,
       refund_id, refund_idempotency_key, refunded_minor, created_at, updated_at)
    SELECT
      b.id,
      'charge:' || b.id::text,
      'ch_seed_' || replace(b.id::text, '-', ''),
      b.total_minor,
      CASE WHEN b.status = 'REFUNDED' THEN 'REFUNDED' ELSE 'SUCCEEDED' END::payment_status,
      CASE WHEN b.status = 'REFUNDED'
           THEN 're_seed_' || replace(b.id::text, '-', '') END,
      CASE WHEN b.status = 'REFUNDED'
           THEN 'refund:ch_seed_' || replace(b.id::text, '-', '') END,
      CASE WHEN b.status = 'REFUNDED' THEN b.total_minor ELSE 0 END,
      b.created_at,
      b.created_at
      FROM bookings b
     WHERE b.status IN ('CONFIRMED','COMPLETED','REFUNDED')
  `);

  // The idempotency ledger, so the seeded charges look exactly like applied
  // ones. Without the capture event a seeded REFUNDED booking would be flagged
  // as a refund against a charge that never captured.
  await client.query(`
    INSERT INTO payment_events (charge_id, event, occurred_at, applied_at)
    SELECT p.charge_id, 'charge.succeeded', p.created_at, p.created_at
      FROM payments p
     WHERE p.charge_id IS NOT NULL
  `);

  await client.query(`
    INSERT INTO payment_events (charge_id, event, occurred_at, applied_at)
    SELECT p.charge_id, 'refund.succeeded', p.updated_at, p.updated_at
      FROM payments p
     WHERE p.status = 'REFUNDED' AND p.charge_id IS NOT NULL
  `);

  return inserted.rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

interface SeededVenue {
  id: string;
  name: string;
  city: City;
  timezone: string;
  hours: Record<string, { open: string; close: string } | null>;
  bufferPct: number;
}

async function seedVenues(
  client: PoolClient,
  profile: Profile,
  rng: () => number,
): Promise<SeededVenue[]> {
  const rows: SeededVenue[] = [];
  const values: unknown[] = [];
  const tuples: string[] = [];

  for (let i = 0; i < profile.venues; i += 1) {
    const city = profile.cities[i % profile.cities.length]!;
    const hours = operatingHours(rng);
    // Equipment only, and capped at 10% by a CHECK constraint. Most venues run
    // at 0 so the buffer is visible in the data without being the default.
    const bufferPct = i % 4 === 0 ? intBetween(rng, 1, 10) : 0;
    const name = `${city.name} ${pick(rng, VENUE_SUFFIXES)} ${i + 1}`;

    const base = values.length;
    values.push(name, city.name, city.timezone, JSON.stringify(hours), bufferPct);
    tuples.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::jsonb, $${base + 5})`);

    rows.push({ id: '', name, city, timezone: city.timezone, hours, bufferPct });
  }

  const result = await client.query<{ id: string }>(
    `INSERT INTO venues (name, city, timezone, operating_hours, overbooking_buffer_pct)
     VALUES ${tuples.join(',')} RETURNING id`,
    values,
  );

  result.rows.forEach((r, i) => {
    rows[i]!.id = r.id;
  });

  console.log(`  venues: ${rows.length}`);
  return rows;
}

interface SeededRoom {
  id: string;
  venue: SeededVenue;
  /** Position within its venue. Drives the equipment assignment — see below. */
  indexInVenue: number;
  name: string;
  hourlyRateMinor: number;
}

async function seedRooms(
  client: PoolClient,
  profile: Profile,
  venues: SeededVenue[],
  rng: () => number,
): Promise<SeededRoom[]> {
  const rows: SeededRoom[] = [];
  const values: unknown[] = [];
  const tuples: string[] = [];
  const perVenue = new Map<string, number>();

  for (let i = 0; i < profile.rooms; i += 1) {
    const venue = venues[i % venues.length]!;
    const indexInVenue = perVenue.get(venue.id) ?? 0;
    perVenue.set(venue.id, indexInVenue + 1);

    const name = `${pick(rng, ROOM_PREFIXES)} ${String.fromCharCode(65 + (indexInVenue % 26))}`;
    const capacity = intBetween(rng, 2, 60);
    const hourlyRateMinor = intBetween(rng, 15, 220) * 100;

    const amenityCount = intBetween(rng, 2, 5);
    const amenities: string[] = [];
    for (let a = 0; a < amenityCount; a += 1) {
      const amenity = pick(rng, AMENITIES);
      if (!amenities.includes(amenity)) amenities.push(amenity);
    }

    const base = values.length;
    values.push(venue.id, name, capacity, hourlyRateMinor, amenities);
    tuples.push(
      `($${base + 1}::uuid, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::text[])`,
    );

    rows.push({ id: '', venue, indexInVenue, name, hourlyRateMinor });
  }

  const result = await client.query<{ id: string }>(
    `INSERT INTO rooms (venue_id, name, capacity, hourly_rate_minor, amenities)
     VALUES ${tuples.join(',')} RETURNING id`,
    values,
  );

  result.rows.forEach((r, i) => {
    rows[i]!.id = r.id;
  });

  console.log(`  rooms: ${rows.length}`);
  return rows;
}

interface SeededEquipment {
  id: string;
  venueId: string;
  name: string;
  unitsOwned: number;
}

async function seedEquipment(
  client: PoolClient,
  profile: Profile,
  venues: SeededVenue[],
  rng: () => number,
): Promise<SeededEquipment[]> {
  const typesPerVenue = EQUIPMENT_NAMES.length;
  const unitsPerType = Math.max(
    3,
    Math.floor(profile.equipmentUnits / (venues.length * typesPerVenue)),
  );

  const rows: SeededEquipment[] = [];
  const values: unknown[] = [];
  const tuples: string[] = [];

  for (const venue of venues) {
    for (const name of EQUIPMENT_NAMES) {
      const unitsOwned = unitsPerType + intBetween(rng, 0, 2);
      const rate = intBetween(rng, 5, 60) * 100;

      const base = values.length;
      values.push(venue.id, name, rate, unitsOwned);
      tuples.push(`($${base + 1}::uuid, $${base + 2}, $${base + 3}, $${base + 4})`);

      rows.push({ id: '', venueId: venue.id, name, unitsOwned });
    }
  }

  const result = await client.query<{ id: string }>(
    `INSERT INTO equipment_types (venue_id, name, hourly_rate_minor, units_owned)
     VALUES ${tuples.join(',')} RETURNING id`,
    values,
  );

  result.rows.forEach((r, i) => {
    rows[i]!.id = r.id;
  });

  console.log(`  equipment types: ${rows.length} (${unitsPerType}+ units each)`);
  return rows;
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

interface SeededUsers {
  platformAdmin: string;
  staff: { id: string; venueId: string; role: string }[];
  customers: { id: string }[];
  logins: { role: string; email: string; password: string; venue: string | null }[];
}

/**
 * Five named test logins, plus bulk accounts.
 *
 * The brief asks for one per role PLUS a second VENUE_ADMIN at a different
 * venue, and the second admin is the point: INV-6 is not "an admin cannot read
 * the platform", it is "an admin of venue A cannot read venue B". A single
 * admin account cannot demonstrate that either way, so the isolation tests need
 * two real admins at two real venues to have anything to prove.
 */
async function seedUsers(
  client: PoolClient,
  profile: Profile,
  venues: SeededVenue[],
  passwordHash: string,
  _rng: () => number,
): Promise<SeededUsers> {
  const venueA = venues[0]!;
  const venueB = venues[1] ?? venues[0]!;

  const named = [
    { email: 'admin@atrium.test', role: 'PLATFORM_ADMIN', venueId: null, label: 'PLATFORM_ADMIN', venue: null },
    { email: 'admin.a@atrium.test', role: 'VENUE_ADMIN', venueId: venueA.id, label: 'VENUE_ADMIN (venue A)', venue: venueA.name },
    { email: 'admin.b@atrium.test', role: 'VENUE_ADMIN', venueId: venueB.id, label: 'VENUE_ADMIN (venue B)', venue: venueB.name },
    { email: 'staff.a@atrium.test', role: 'VENUE_STAFF', venueId: venueA.id, label: 'VENUE_STAFF (venue A)', venue: venueA.name },
    { email: 'customer@atrium.test', role: 'CUSTOMER', venueId: null, label: 'CUSTOMER', venue: null },
  ];

  const namedValues: unknown[] = [];
  const namedTuples: string[] = [];
  for (const user of named) {
    const base = namedValues.length;
    namedValues.push(user.email, passwordHash, user.role, user.venueId);
    namedTuples.push(
      `($${base + 1}, $${base + 2}, $${base + 3}::user_role, $${base + 4}::uuid)`,
    );
  }

  const namedResult = await client.query<{ id: string; email: string }>(
    `INSERT INTO users (email, password_hash, role, venue_id)
     VALUES ${namedTuples.join(',')} RETURNING id, email`,
    namedValues,
  );

  const byEmail = new Map(namedResult.rows.map((r) => [r.email, r.id]));

  // Bulk accounts: one staff member per venue beyond the named pair, the rest
  // customers. Inserted in batches because a single statement with 5,000 tuples
  // exceeds Postgres' 65,535 bind-parameter limit.
  const staff: { id: string; venueId: string; role: string }[] = [];
  const customers: { id: string }[] = [];

  const bulkRows: { email: string; role: string; venueId: string | null }[] = [];
  for (let i = 0; i < venues.length; i += 1) {
    bulkRows.push({ email: `staff${i}@venue.atrium.test`, role: 'VENUE_STAFF', venueId: venues[i]!.id });
  }
  const customerCount = Math.max(0, profile.users - bulkRows.length - named.length);
  for (let i = 0; i < customerCount; i += 1) {
    bulkRows.push({ email: `customer${i}@atrium.test`, role: 'CUSTOMER', venueId: null });
  }

  for (const batch of chunk(bulkRows, 2_000)) {
    const values: unknown[] = [];
    const tuples: string[] = [];
    for (const row of batch) {
      const base = values.length;
      values.push(row.email, passwordHash, row.role, row.venueId);
      tuples.push(`($${base + 1}, $${base + 2}, $${base + 3}::user_role, $${base + 4}::uuid)`);
    }
    const result = await client.query<{ id: string; role: string; venue_id: string | null }>(
      `INSERT INTO users (email, password_hash, role, venue_id)
       VALUES ${tuples.join(',')} RETURNING id, role, venue_id`,
      values,
    );
    for (const r of result.rows) {
      if (r.role === 'CUSTOMER') customers.push({ id: r.id });
      else staff.push({ id: r.id, venueId: r.venue_id!, role: r.role });
    }
  }

  // The named CUSTOMER books too, so the demo login has bookings to look at.
  customers.push({ id: byEmail.get('customer@atrium.test')! });

  console.log(`  users: ${named.length + bulkRows.length}`);

  return {
    platformAdmin: byEmail.get('admin@atrium.test')!,
    staff,
    customers,
    logins: named.map((u) => ({
      role: u.label,
      email: u.email,
      password: SEED_PASSWORD,
      venue: u.venue,
    })),
  };
}

// ---------------------------------------------------------------------------
// Bookings — the part the exclusion constraint cares about
// ---------------------------------------------------------------------------

/**
 * Status mix, as cumulative weights.
 *
 * Reports need something to read, so the past is mostly COMPLETED with a
 * realistic tail of cancellations, and the future is CONFIRMED. Note what is
 * NOT seeded: HELD. A seeded hold would have an `expires_at` in the past the
 * moment the seed finished, so the first hold request against that room would
 * expire it — seeding rows whose only purpose is to be immediately deleted
 * makes the concurrency proof's starting state depend on timing.
 */
const PAST_STATUSES: readonly [string, number][] = [
  ['COMPLETED', 0.78],
  ['CANCELLED', 0.9],
  ['EXPIRED', 0.96],
  ['REFUNDED', 1.0],
];

const FUTURE_STATUSES: readonly [string, number][] = [
  ['CONFIRMED', 0.86],
  ['CANCELLED', 0.96],
  ['EXPIRED', 1.0],
];

function weightedStatus(rng: () => number, table: readonly [string, number][]): string {
  const roll = rng();
  for (const [status, ceiling] of table) if (roll < ceiling) return status;
  return table[table.length - 1]![0];
}

async function seedBookings(
  client: PoolClient,
  profile: Profile,
  venues: SeededVenue[],
  rooms: SeededRoom[],
  equipment: SeededEquipment[],
  users: SeededUsers,
  rng: () => number,
): Promise<{
  bookings: number;
  lineItems: number;
  emptyWindow: SeedSummary['emptyWindow'];
}> {
  const equipmentByVenue = new Map<string, SeededEquipment[]>();
  for (const item of equipment) {
    const list = equipmentByVenue.get(item.venueId) ?? [];
    list.push(item);
    equipmentByVenue.set(item.venueId, list);
  }

  const venuesById = new Map(venues.map((v) => [v.id, v]));

  /**
   * One room is left deliberately empty, and its identity is printed.
   *
   * The concurrency proof owns its own fixtures and does not read the seed —
   * tests that assert against seeded data break the moment the seed changes.
   * This room exists for the *manual* demonstration: a reviewer wanting to fire
   * curl at a slot that is definitely free needs somewhere to aim, and hunting
   * for a gap in 25,000 bookings is not a good use of their five minutes.
   */
  const reservedRoom = rooms[rooms.length - 1]!;
  const bookableRooms = rooms.slice(0, -1);

  const now = new Date();
  const rangeStart = addMonths(now, -profile.monthsBack);

  const rangeEnd = addMonths(now, profile.monthsForward);

  /**
   * Density varies per room rather than times varying randomly. A busy room
   * books most of its available slots; a quiet one skips most. That is what
   * makes the calendar look uneven without reintroducing collisions.
   *
   * Densities are drawn FIRST and the per-room target is then apportioned in
   * proportion to them. Splitting the total evenly instead would set every room
   * the same target while giving the quiet ones a quarter of the throughput to
   * reach it — they run out of calendar, nothing takes up the slack, and the
   * seed silently delivers around half the bookings it advertised. Apportioning
   * means a room's target is always below what its own density can produce.
   */
  const densities = bookableRooms.map(() => 0.3 + rng() * 0.6);

  /**
   * How many non-overlapping slots each room's calendar can hold, counted by
   * walking it — not estimated.
   *
   * ## Why this pass exists (P6)
   *
   * Up to P6 the walk simply ran forward from the start of the range and
   * stopped the moment it had produced its target. Since the cursor only moves
   * forward, that packs every room's whole allocation into the OLDEST part of
   * the calendar and leaves the newest part almost empty. The full profile
   * looked correct by every count that was being checked — 250,000 rows, 24
   * months of span — while actually delivering 21,000 bookings a month for the
   * first year and 52 in the last month.
   *
   * That is fatal to a benchmark rather than untidy. Room availability, cross
   * venue search and create-hold all query the FUTURE, and the future was the
   * empty end. Every p95 in LOAD_TEST.md would have been measured against a
   * region of the table with almost nothing in it, and the numbers would have
   * been fast, reproducible and meaningless.
   *
   * ## Why counting is exact rather than estimated
   *
   * Slot geometry — how long each candidate booking is, and therefore where the
   * cursor lands next — is drawn from a per-room generator that depends only on
   * the room index. Emission does not affect it: a slot that is skipped advances
   * the cursor by `duration + turnaround`, and a slot that is emitted advances
   * it by `ends_at + turnaround`, which is the same instant. So the counting
   * pass and the emitting pass see an identical sequence of candidate slots, and
   * the count is the real capacity of that room's calendar, not a formula about
   * average opening hours that a venue closing on Tuesdays would falsify.
   */
  const capacities = bookableRooms.map((room, roomIndex) =>
    countRoomSlots(
      venuesById.get(room.venue.id)!,
      rangeStart,
      rangeEnd,
      geometryRng(roomIndex),
    ),
  );

  const targets = apportion(profile.bookings, densities, capacities);

  let written = 0;
  let lineItemsWritten = 0;
  let pending: BookingDraft[] = [];

  for (const [roomIndex, room] of bookableRooms.entries()) {
    const venue = venuesById.get(room.venue.id)!;
    const target = targets[roomIndex]!;
    if (target === 0) continue;

    const drafts = walkRoomCalendar(
      room,
      venue,
      rangeStart,
      rangeEnd,
      now,
      target,
      capacities[roomIndex]!,
      geometryRng(roomIndex),
      rng,
      users,
      equipmentByVenue.get(venue.id) ?? [],
    );

    pending.push(...drafts);
    written += drafts.length;

    if (pending.length >= 2_000) {
      lineItemsWritten += await flush(client, pending);
      pending = [];
      process.stdout.write(`\r  bookings: ${written}/${profile.bookings}`);
    }
  }

  if (pending.length > 0) lineItemsWritten += await flush(client, pending);
  process.stdout.write(`\r  bookings: ${written}/${profile.bookings}\n`);
  console.log(`  line items: ${lineItemsWritten}`);

  // A window on the reserved room that is inside its operating hours.
  const emptyWindow = firstOpenWindow(reservedRoom, venuesById.get(reservedRoom.venue.id)!, now);

  return { bookings: written, lineItems: lineItemsWritten, emptyWindow };
}

/**
 * The slot-geometry generator for one room.
 *
 * Seeded from the room's index alone, so the counting pass and the emitting
 * pass can each construct it and get the identical stream. Kept separate from
 * the shared content generator (statuses, customers, equipment) precisely so
 * that consuming a content draw on one pass and not the other cannot shift the
 * geometry out from under the count.
 */
function geometryRng(roomIndex: number): () => number {
  return makeRng((Math.imul(roomIndex + 1, 2_654_435_761) ^ 0x5e_ed_10_7e) >>> 0);
}

/**
 * Split `total` across rooms in proportion to density, without ever giving a
 * room more slots than its calendar physically holds.
 *
 * The naive proportional split overshoots on cramped rooms — a venue open six
 * hours a day cannot absorb the share a density of 0.9 implies — and whatever
 * it cannot take is simply lost, which is the shape of the shortfall P5 caught
 * at 14,138 of 25,000. Here the overflow is redistributed: rooms are capped at
 * capacity, the leftover is re-apportioned across whoever still has headroom,
 * and the loop repeats until either the total is placed or no room has room.
 *
 * The remainder from integer rounding is handed to the roomiest rooms last, so
 * the sum is EXACTLY `total` rather than approximately it. That exactness is
 * the point: "did the seed deliver what it advertised" has to be a yes/no
 * question, not a question about tolerance.
 */
function apportion(
  total: number,
  weights: readonly number[],
  capacities: readonly number[],
): number[] {
  const allocated = new Array<number>(weights.length).fill(0);
  let remaining = Math.min(total, capacities.reduce((a, b) => a + b, 0));

  // At most a handful of rounds in practice; the bound is a guard, not a plan.
  for (let round = 0; round < 32 && remaining > 0; round += 1) {
    const openIdx = allocated
      .map((a, i) => (a < capacities[i]! ? i : -1))
      .filter((i) => i >= 0);
    if (openIdx.length === 0) break;

    const weightSum = openIdx.reduce((sum, i) => sum + weights[i]!, 0);
    if (weightSum <= 0) break;

    const before = remaining;
    for (const i of openIdx) {
      if (remaining <= 0) break;
      const want = Math.max(1, Math.floor((before * weights[i]!) / weightSum));
      const give = Math.min(want, capacities[i]! - allocated[i]!, remaining);
      allocated[i] = allocated[i]! + give;
      remaining -= give;
    }
    // No forward progress with headroom still available means the weights are
    // degenerate; fall through to the sweep below rather than spinning.
    if (remaining === before) break;
  }

  // Whatever integer rounding left over goes to the rooms with the most spare
  // calendar, one at a time.
  if (remaining > 0) {
    const bySpare = allocated
      .map((a, i) => ({ i, spare: capacities[i]! - a }))
      .filter((r) => r.spare > 0)
      .sort((a, b) => b.spare - a.spare);
    for (const { i, spare } of bySpare) {
      if (remaining <= 0) break;
      const give = Math.min(spare, remaining);
      allocated[i] = allocated[i]! + give;
      remaining -= give;
    }
  }

  return allocated;
}

/**
 * Walk one room's calendar and count the candidate slots, emitting nothing.
 *
 * Draws only from the geometry generator, in the same order the emitting walk
 * does, so the two agree slot for slot.
 */
function countRoomSlots(
  venue: SeededVenue,
  rangeStart: Date,
  rangeEnd: Date,
  geometry: () => number,
): number {
  let count = 0;
  for (const _ of candidateSlots(venue, rangeStart, rangeEnd, geometry)) count += 1;
  return count;
}

/**
 * The candidate slots for one room's calendar, in order.
 *
 * The cursor only ever moves forward and always clears the turnaround, so no
 * two slots this yields can overlap. That is the whole trick: `no_room_overlap`
 * stays armed for the entire seed and is never asked to reject anything, rather
 * than being dropped and recreated — which would leave the seeded calendar
 * unverified by the one rule it is supposed to respect.
 */
function* candidateSlots(
  venue: SeededVenue,
  rangeStart: Date,
  rangeEnd: Date,
  geometry: () => number,
): Generator<{ startsAt: Date; endsAt: Date }> {
  let cursor = new Date(rangeStart);
  let guard = 0;
  const GUARD_LIMIT = 4_000_000;

  while (cursor < rangeEnd && guard < GUARD_LIMIT) {
    guard += 1;

    const local = toLocalParts(cursor, venue.timezone);
    const dayHours = venue.hours[local.weekday];

    if (!dayHours) {
      cursor = nextLocalMorning(venue.timezone, cursor);
      continue;
    }

    const openMinutes = Number(dayHours.open.slice(0, 2)) * 60;
    const closeMinutes = Number(dayHours.close.slice(0, 2)) * 60;

    const dayOpen = fromLocalParts(
      local.year, local.month, local.day,
      Math.floor(openMinutes / 60), openMinutes % 60,
      venue.timezone,
    );
    const dayClose = fromLocalParts(
      local.year, local.month, local.day,
      Math.floor(closeMinutes / 60) % 24, closeMinutes % 60,
      venue.timezone,
    );

    if (cursor < dayOpen) cursor = dayOpen;

    if (cursor >= dayClose) {
      cursor = nextLocalMorning(venue.timezone, cursor);
      continue;
    }

    // 1 to 4 hours, on the grid.
    const durationMinutes = intBetween(geometry, 2, 8) * 30;
    const endsAt = new Date(cursor.getTime() + durationMinutes * 60_000);

    if (endsAt > dayClose) {
      cursor = nextLocalMorning(venue.timezone, cursor);
      continue;
    }

    yield { startsAt: new Date(cursor), endsAt };

    // Past the booking AND past the turnaround — the same advance whether the
    // caller took this slot or skipped it, which is what makes the counting
    // pass and the emitting pass see one identical sequence.
    cursor = new Date(endsAt.getTime() + 15 * 60_000);
  }

  return;
}

interface BookingDraft {
  venueId: string;
  roomId: string;
  userId: string;
  startsAt: Date;
  endsAt: Date;
  status: string;
  totalMinor: number;
  currency: string;
  /**
   * When the booking was made, which for a settled booking is also when it
   * confirmed and therefore when its cancellation policy was frozen.
   *
   * Left to `DEFAULT now()` until P8, which meant every seeded booking — the
   * two-year-old COMPLETED ones included — claimed to have been created in the
   * same second the seed ran. Harmless while nothing read it; not harmless once
   * the policy snapshot has to be resolved *as of* a moment in time, because
   * every booking would resolve against the newest policy and the whole point
   * of freezing a snapshot would be invisible.
   */
  createdAt: Date;
  lineItem: { equipmentTypeId: string; quantity: number; rateMinor: number } | null;
}

/**
 * Emit `target` bookings for one room, spread evenly across its whole calendar.
 *
 * ## Striding, not coin flipping (P6)
 *
 * The slot to take is chosen by an exact stride over the candidate sequence:
 * candidate `i` is emitted iff `floor((i+1) * p) > floor(i * p)`, where
 * `p = target / capacity`. Two properties follow, and both were missing before.
 *
 * It emits EXACTLY `target` rows, so "the seed delivered 250,000" is a fact
 * about the generator rather than a hope about a Bernoulli trial averaging out.
 * And the rows it emits are spread across the entire range instead of packed
 * against its start, which is what the previous stop-at-target walk did — see
 * the note on `countRoomSlots`. A benchmark that queries next week has to find
 * next week populated.
 *
 * What it gives up is clumping WITHIN a room: this room's bookings are now
 * evenly spaced rather than bursty. Unevenness across the platform survives,
 * because `target` still varies per room with density, so busy rooms and quiet
 * rooms still look different from each other. Trading intra-room burstiness for
 * a calendar that is actually populated where the queries look is the right way
 * round for a benchmark fixture, and it is recorded here rather than silently.
 */
function walkRoomCalendar(
  room: SeededRoom,
  venue: SeededVenue,
  rangeStart: Date,
  rangeEnd: Date,
  now: Date,
  target: number,
  capacity: number,
  geometry: () => number,
  rng: () => number,
  users: SeededUsers,
  venueEquipment: SeededEquipment[],
): BookingDraft[] {
  const drafts: BookingDraft[] = [];
  if (target <= 0 || capacity <= 0) return drafts;

  /**
   * Equipment assignment is deterministic, not random, and that is a
   * correctness decision rather than a stylistic one.
   *
   * Rooms in one venue DO overlap in time, so randomly attaching equipment
   * would let peak concurrent usage of a type exceed `units_owned` — the seed
   * would then be publishing data that violates INV-2, and the reconciliation
   * and availability endpoints would report a platform that had already
   * oversold before a single request arrived.
   *
   * Mapping each room to ONE equipment type by its position in the venue bounds
   * peak usage for a type at `ceil(rooms_in_venue / equipment_types)` — around
   * 2 for the demo profile and 4 for full, against a minimum of 3 units owned
   * for demo and ~10 for full. Safe by construction, and re-derivable from the
   * numbers rather than hoped for.
   */
  const assignedEquipment =
    venueEquipment.length > 0
      ? venueEquipment[room.indexInVenue % venueEquipment.length]!
      : null;

  const want = Math.min(target, capacity);
  let index = 0;

  for (const slot of candidateSlots(venue, rangeStart, rangeEnd, geometry)) {
    // Integer arithmetic, not `i * (target / capacity)`.
    //
    // The float form is off by an ulp on some ratios, so `capacity * p` lands
    // fractionally below `target` and the room emits one row fewer than it was
    // allocated. Spread over 800 rooms that cost 46 bookings out of 250,000 —
    // small, invisible, and precisely the kind of quiet shortfall this seed has
    // already been caught delivering once. Multiplying first keeps every
    // comparison exact, so a room emits its target or its capacity, never
    // "almost".
    const take =
      Math.floor(((index + 1) * want) / capacity) > Math.floor((index * want) / capacity);
    index += 1;
    if (!take) continue;
    if (drafts.length >= want) break;

    const isPast = slot.endsAt < now;
    const status = weightedStatus(rng, isPast ? PAST_STATUSES : FUTURE_STATUSES);

    const durationHours = (slot.endsAt.getTime() - slot.startsAt.getTime()) / 3_600_000;
    const attachEquipment = assignedEquipment !== null && rng() < 0.35;
    const equipmentTotal = attachEquipment ? Math.round(durationHours * 4_000) : 0;

    drafts.push({
      venueId: venue.id,
      roomId: room.id,
      userId: pick(rng, users.customers).id,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      status,
      createdAt: bookedAt(slot.startsAt, now, rng),
      totalMinor: Math.round(room.hourlyRateMinor * durationHours) + equipmentTotal,
      currency: venue.city.currency,
      lineItem: attachEquipment
        ? {
            equipmentTypeId: assignedEquipment.id,
            quantity: 1,
            rateMinor: 4_000,
          }
        : null,
    });
  }

  return drafts;
}

/**
 * Insert a batch of bookings and their line items.
 *
 * `bookings.slot` is a GENERATED column and is deliberately absent from the
 * column list — Postgres computes it, which is the point: seeded rows carry the
 * same turnaround buffer as rows created through the API, so the seed cannot
 * produce a calendar the hold path would consider invalid.
 */
async function flush(client: PoolClient, drafts: BookingDraft[]): Promise<number> {
  let lineItems = 0;

  for (const batch of chunk(drafts, 500)) {
    const values: unknown[] = [];
    const tuples: string[] = [];

    for (const d of batch) {
      const base = values.length;
      values.push(
        d.venueId, d.roomId, d.userId,
        d.startsAt.toISOString(), d.endsAt.toISOString(),
        d.status, d.totalMinor, d.currency,
        d.createdAt.toISOString(),
      );
      tuples.push(
        `($${base + 1}::uuid, $${base + 2}::uuid, $${base + 3}::uuid,` +
          ` $${base + 4}::timestamptz, $${base + 5}::timestamptz,` +
          ` $${base + 6}::booking_status, $${base + 7}::bigint, $${base + 8},` +
          ` $${base + 9}::timestamptz, $${base + 9}::timestamptz)`,
      );
    }

    const result = await client.query<{ id: string }>(
      `INSERT INTO bookings
         (venue_id, room_id, user_id, starts_at, ends_at, status, total_minor, currency,
          created_at, updated_at)
       VALUES ${tuples.join(',')}
       RETURNING id`,
      values,
    );

    const liValues: unknown[] = [];
    const liTuples: string[] = [];

    result.rows.forEach((row, i) => {
      const draft = batch[i]!;
      if (!draft.lineItem) return;
      const base = liValues.length;
      liValues.push(
        row.id,
        draft.lineItem.equipmentTypeId,
        draft.lineItem.quantity,
        draft.lineItem.rateMinor,
      );
      liTuples.push(
        `($${base + 1}::uuid, $${base + 2}::uuid, $${base + 3}, $${base + 4}::bigint)`,
      );
    });

    if (liTuples.length > 0) {
      await client.query(
        `INSERT INTO booking_line_items (booking_id, equipment_type_id, quantity, rate_minor)
         VALUES ${liTuples.join(',')}`,
        liValues,
      );
      lineItems += liTuples.length;
    }
  }

  return lineItems;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * When a booking was made, given when it starts.
 *
 * Between one and roughly six weeks of lead time, never in the future. The
 * exact distribution does not matter; that the instant is *before* the booking
 * and *spread out* does, because it is the instant the policy snapshot is
 * resolved as of. If every booking claimed to have been created at seed time,
 * every snapshot would resolve against the newest policy row and a seeded
 * database could not demonstrate the one property the design exists for — that
 * a policy written after a booking confirmed does not reach back to it.
 */
function bookedAt(startsAt: Date, now: Date, rng: () => number): Date {
  const days = 1 + Math.floor(rng() * 45);
  const withinDay = Math.floor(rng() * 86_400_000);
  const booked = new Date(startsAt.getTime() - days * 86_400_000 - withinDay);

  // A booking made in the future is not a booking. Future slots with long lead
  // times clamp to "just now" rather than being skipped.
  const latest = now.getTime() - 60_000;
  return booked.getTime() > latest ? new Date(latest) : booked;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function addMonths(date: Date, months: number): Date {
  const copy = new Date(date);
  copy.setUTCMonth(copy.getUTCMonth() + months);
  return copy;
}

/** 00:00 local on the day after `instant`, as an absolute instant. */
function nextLocalMorning(timezone: string, instant: Date): Date {
  const noon = new Date(instant.getTime() + 12 * 3_600_000);
  const p = toLocalParts(noon, timezone);
  return fromLocalParts(p.year, p.month, p.day + 1, 0, 0, timezone);
}

function firstOpenWindow(
  room: SeededRoom,
  venue: SeededVenue,
  now: Date,
): SeedSummary['emptyWindow'] {
  for (let dayOffset = 2; dayOffset < 14; dayOffset += 1) {
    const probe = new Date(now.getTime() + dayOffset * 86_400_000);
    const local = toLocalParts(probe, venue.timezone);
    const dayHours = venue.hours[local.weekday];
    if (!dayHours) continue;

    const openHour = Number(dayHours.open.slice(0, 2));
    const startsAt = fromLocalParts(local.year, local.month, local.day, openHour + 1, 0, venue.timezone);

    return {
      room_id: room.id,
      room_name: `${venue.name} — ${room.name}`,
      starts_at: startsAt.toISOString(),
      ends_at: new Date(startsAt.getTime() + 3_600_000).toISOString(),
    };
  }
  return null;
}

function report(s: SeedSummary): void {
  console.log('');
  console.log(`seed complete — profile "${s.profile}" in ${s.elapsedSeconds}s`);
  console.log(
    `  ${s.venues} venues · ${s.rooms} rooms · ${s.equipmentTypes} equipment types · ` +
      `${s.users} users · ${s.bookings} bookings · ${s.lineItems} line items · ` +
      `${s.payments} payments`,
  );
  console.log(
    `  ${s.policies} cancellation policies (1 platform default + ${s.venuePolicies} venue ` +
      `overrides) · ${s.snapshots} settled bookings carry a frozen snapshot`,
  );
  console.log('  (counted from the tables, not tallied in memory)');
  console.log('');
  console.log('  WARNING — seeded charges are synthetic. ch_seed_* exists in this database');
  console.log('    and not at Paygate, so cancelling a SEEDED confirmed booking quotes the');
  console.log('    right refund and then cannot settle it: the provider answers 404');
  console.log('    unknown_charge, and reconciliation reports refund_initiated_not_settled,');
  console.log('    correctly. Book through the console to exercise a refund end to end.');
  console.log('    See seedPayments in this file for why, and for what was rejected.');

  // Said out loud, every time, rather than left for someone to notice. A seed
  // that under-delivers silently is the exact failure P5 spent a phase finding.
  if (s.bookings !== s.intendedBookings || s.lineItems !== s.intendedLineItems) {
    console.log('');
    console.log('  ⚠ SHORTFALL — the generator and the tables disagree:');
    console.log(`      bookings   intended ${s.intendedBookings}, table holds ${s.bookings}`);
    console.log(`      line items intended ${s.intendedLineItems}, table holds ${s.lineItems}`);
  }
  console.log('');
  console.log('TEST LOGINS  (password is the same for every seeded account)');
  console.log('─'.repeat(78));
  for (const login of s.logins) {
    console.log(
      `  ${login.role.padEnd(24)} ${login.email.padEnd(26)} ${login.password}` +
        (login.venue ? `\n  ${''.padEnd(24)} venue: ${login.venue}` : ''),
    );
  }
  console.log('─'.repeat(78));
  console.log('  The two VENUE_ADMINs are at DIFFERENT venues on purpose: INV-6 is');
  console.log('  "admin of A cannot read B", which one admin account cannot demonstrate.');

  if (s.emptyWindow) {
    console.log('');
    console.log('KNOWN-EMPTY WINDOW  (no seeded booking touches this room at all)');
    console.log(`  room_id   ${s.emptyWindow.room_id}`);
    console.log(`  room      ${s.emptyWindow.room_name}`);
    console.log(`  starts_at ${s.emptyWindow.starts_at}`);
    console.log(`  ends_at   ${s.emptyWindow.ends_at}`);
  }
  console.log('');
}

/**
 * Only when this file IS the process, never when it is imported.
 *
 * Without the guard, `import { runSeed } from './db/seed'` in the API's
 * bootstrap would truncate the database as a side effect of loading a module —
 * at import time, before any flag had been read. `nest build` emits CommonJS,
 * so `require.main` is the reliable test here.
 */
if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(`seed failed: ${err instanceof Error ? err.stack : String(err)}`);
    process.exit(1);
  });
}
