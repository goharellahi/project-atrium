import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { createDb, createPool, type Db } from '../db/client';
import { AvailabilityService } from '../rooms/availability.service';
import { SearchSchema } from '../bookings/bookings.schemas';
import { SearchService } from './search.service';
import type { Env } from '../config/env';

/**
 * The amenity filter, against a real Postgres.
 *
 * ## Why this suite is not a unit test
 *
 * `?amenity=wifi` answered 500 for every input from the day the endpoint was
 * written until P7 pointed a UI at it. The cause was not logic: the predicate
 * was right, the containment operator was right, and every unit test that could
 * have been written against the query builder would have passed. Drizzle
 * expanded the array into one placeholder per element, so Postgres was handed
 * `('wifi')::text[]` and answered `22P02 malformed array literal`.
 *
 * Only Postgres can tell you that. So this suite builds its own venue and rooms,
 * runs the real `SearchService` against them, and asserts on rows — which is
 * also the only way to pin the *semantics* the operator was chosen for:
 * containment is AND, not OR, and a query for two amenities must not return a
 * room that has one of them.
 *
 * It skips when there is no `DATABASE_URL`, so a checkout without a database
 * still passes. CI provisions one and applies the migrations, so it runs there.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const describeWithDb = DATABASE_URL ? describe : describe.skip;

/** Marks every row this suite creates, so cleanup cannot reach anything else. */
const TAG = 'p7-amenity-fixture';

describeWithDb('search: the amenity filter', () => {
  let pool: Pool;
  let db: Db;
  let search: SearchService;

  beforeAll(async () => {
    pool = createPool(DATABASE_URL!);
    db = createDb(pool);

    // `AvailabilityService` is only consulted when the query carries an
    // availability window, and none of these do. It is constructed with the one
    // field it reads rather than a full environment, so this suite does not
    // need JWT_SECRET and the rest of the boot contract to exercise search.
    search = new SearchService(
      db,
      new AvailabilityService(db, { ROOM_TURNAROUND_MINUTES: 15 } as Env),
    );

    await cleanup(db);

    await db.execute(sql`
      WITH v AS (
        INSERT INTO venues (name, city, timezone, operating_hours, overbooking_buffer_pct)
        VALUES (
          ${TAG},
          ${TAG},
          'Asia/Karachi',
          '{"mon":["09:00","21:00"],"tue":["09:00","21:00"],"wed":["09:00","21:00"],"thu":["09:00","21:00"],"fri":["09:00","21:00"],"sat":["09:00","21:00"],"sun":["09:00","21:00"]}'::jsonb,
          0
        )
        RETURNING id
      )
      INSERT INTO rooms (venue_id, name, capacity, hourly_rate_minor, amenities)
      SELECT v.id, r.name, 10, 1000, r.amenities
        FROM v, (VALUES
          ('both',      ARRAY['wifi','blackout','drum_kit']::text[]),
          ('wifi only', ARRAY['wifi','grand_piano']::text[]),
          ('neither',   ARRAY['cyclorama']::text[])
        ) AS r(name, amenities)
    `);
  });

  afterAll(async () => {
    if (db) await cleanup(db);
    if (pool) await pool.end();
  });

  /**
   * The regression itself. Before the fix this did not return the wrong rows —
   * it threw, and the endpoint answered 500.
   */
  it('answers a single amenity instead of failing to bind it', async () => {
    const result = await run(search, { city: TAG, amenity: 'wifi' });

    expect(result.filters_applied).toContain('amenity');
    expect(names(result)).toEqual(['both', 'wifi only']);
  });

  it('treats several amenities as AND, not OR', async () => {
    const result = await run(search, { city: TAG, amenity: 'wifi,blackout' });

    // `wifi only` has one of the two. Containment must exclude it; `&&` would
    // have returned it, and that is the reason `@>` was chosen.
    expect(names(result)).toEqual(['both']);
  });

  it('returns nothing for an amenity no room has, rather than erroring', async () => {
    const result = await run(search, { city: TAG, amenity: 'helipad' });

    expect(result.data).toHaveLength(0);
    expect(result.total).toBe(0);
    // "No results" and "your filter was ignored" have to be distinguishable.
    expect(result.filters_applied).toContain('amenity');
  });

  it('combines with the other filters', async () => {
    const result = await run(search, {
      city: TAG,
      amenity: 'wifi',
      min_capacity: '10',
      max_hourly_rate_minor: '1000',
    });

    expect(result.filters_applied).toEqual(
      expect.arrayContaining(['city', 'min_capacity', 'max_hourly_rate_minor', 'amenity']),
    );
    expect(names(result)).toEqual(['both', 'wifi only']);
  });

  it('accepts a repeated parameter as well as a comma separated one', async () => {
    const comma = await run(search, { city: TAG, amenity: 'wifi,blackout' });
    const repeated = await run(search, { city: TAG, amenity: ['wifi', 'blackout'] });

    expect(names(repeated)).toEqual(names(comma));
  });

  /**
   * Amenities are free text off a query string and reach Postgres as an array
   * parameter. A value containing the characters that delimit an array literal
   * must be data rather than syntax — which is the argument for binding the
   * array instead of building the literal by hand.
   */
  it('treats array punctuation in a value as data', async () => {
    const result = await run(search, { city: TAG, amenity: '{wifi,blackout}' });

    expect(result.data).toHaveLength(0);
  });
});

/** Parse through the real wire schema, so the test exercises the real coercion. */
async function run(
  search: SearchService,
  raw: Record<string, string | string[]>,
): Promise<{ data: unknown[]; total: number; filters_applied: string[] }> {
  const query = SearchSchema.parse(raw);
  return search.search(query);
}

function names(result: { data: unknown[] }): string[] {
  return result.data.map((room) => (room as { name: string }).name).sort();
}

async function cleanup(db: Db): Promise<void> {
  await db.execute(
    sql`DELETE FROM rooms WHERE venue_id IN (SELECT id FROM venues WHERE name = ${TAG})`,
  );
  await db.execute(sql`DELETE FROM venues WHERE name = ${TAG}`);
}
