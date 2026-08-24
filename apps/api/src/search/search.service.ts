import { Injectable } from '@nestjs/common';
import { and, asc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client';
import { rooms, venues } from '../db/schema';
import { isWithinOperatingHours, parseOperatingHours } from '../common/time/operating-hours';
import { AvailabilityService } from '../rooms/availability.service';
import type { SearchQuery } from '../bookings/bookings.schemas';

/**
 * Cross-venue room search.
 *
 * Deliberately NOT venue-scoped, and that is not a hole in INV-6. Tenant
 * isolation protects a venue's *bookings, customers and revenue* — not the
 * existence of its rooms, which is exactly the catalogue a marketplace exists to
 * publish. What this endpoint returns is inventory: name, capacity, amenities,
 * price. No booking, no customer, no operational data crosses a venue boundary
 * here. The isolation tests in `tests/authz` probe the endpoints that do carry
 * that data.
 */
@Injectable()
export class SearchService {
  constructor(
    private readonly db: Db,
    private readonly availability: AvailabilityService,
  ) {}

  async search(query: SearchQuery): Promise<{
    data: unknown[];
    page: number;
    page_size: number;
    total: number;
    filters_applied: string[];
  }> {
    const predicates: SQL[] = [];
    const applied: string[] = [];

    if (query.city) {
      // Case-insensitive so "karachi" and "Karachi" are the same city. An
      // index on lower(city) is a P7 concern; this phase is about being right.
      predicates.push(sql`lower(${venues.city}) = lower(${query.city})`);
      applied.push('city');
    }

    if (query.min_capacity !== undefined) {
      predicates.push(gte(rooms.capacity, query.min_capacity));
      applied.push('min_capacity');
    }

    if (query.max_hourly_rate_minor !== undefined) {
      predicates.push(lte(rooms.hourlyRateMinor, BigInt(query.max_hourly_rate_minor)));
      applied.push('max_hourly_rate_minor');
    }

    if (query.amenity.length > 0) {
      // `@>` is containment: the room must have EVERY requested amenity, not
      // any of them. "A room with wifi and a piano" is one room, not the union
      // of two sets — `&&` would return rooms with only one of the two.
      //
      // `sql.param` is load bearing. Drizzle expands a bare JS array in a `sql`
      // template into one placeholder per element, so `${query.amenity}` became
      // `($1)` bound to the string `wifi` and Postgres answered
      // `22P02 malformed array literal: "wifi"` — a 500 on every request that
      // named an amenity, for every input, since the endpoint was written.
      // Wrapping it binds the array as a single parameter and lets the driver
      // encode it.
      //
      // The same trap is documented on `uuidArray` in
      // `bookings/equipment-availability.ts`, which exists because the hold path
      // hit it first. That helper builds a literal and re-validates each id;
      // amenities are free text from a query string, so binding the array as a
      // parameter is the safer half of the same lesson — there is no literal to
      // escape.
      predicates.push(sql`${rooms.amenities} @> ${sql.param(query.amenity)}::text[]`);
      applied.push('amenity');
    }

    // The availability window is applied in two parts, and the split matters.
    //
    // Operating hours are per-venue, timezone-dependent and stored as jsonb —
    // expressing "is this UTC interval inside Tuesday 09:00-21:00 Asia/Karachi"
    // in SQL would mean reimplementing tz arithmetic in Postgres. Instead the
    // venues are filtered in TypeScript FIRST, and the surviving venue ids
    // become a normal SQL predicate. Pagination therefore still happens in the
    // database over the correct candidate set, rather than over a page that
    // gets thinned out afterwards — which would make page sizes lie.
    if (query.from && query.to) {
      const openVenueIds = await this.venuesOpenFor(query.from, query.to, query.city);
      applied.push('availability_window');

      if (openVenueIds.length === 0) {
        return {
          data: [],
          page: query.page,
          page_size: query.page_size,
          total: 0,
          filters_applied: applied,
        };
      }
      predicates.push(inArray(rooms.venueId, openVenueIds));
    }

    const where = predicates.length > 0 ? and(...predicates) : undefined;

    // Without an availability window, count and page in SQL and stop.
    if (!query.from || !query.to) {
      const [rowsPage, counted] = await Promise.all([
        this.page(where, query.page, query.page_size),
        this.count(where),
      ]);
      return {
        data: rowsPage,
        page: query.page,
        page_size: query.page_size,
        total: counted,
        filters_applied: applied,
      };
    }

    // With one, the booking-conflict filter must be applied before paging, or
    // `total` would count rooms that are not in fact available. Candidates are
    // capped so a filterless query cannot pull the whole catalogue into memory;
    // the cap is reported rather than hidden.
    const CANDIDATE_CAP = 2_000;
    const candidates = await this.page(where, 1, CANDIDATE_CAP);
    const ids = candidates.map((r) => r.id);
    const free = await this.availability.freeRoomIds(ids, query.from, query.to);

    const available = candidates.filter((r) => free.has(r.id));
    const start = (query.page - 1) * query.page_size;

    return {
      data: available.slice(start, start + query.page_size),
      page: query.page,
      page_size: query.page_size,
      total: available.length,
      filters_applied: applied,
      ...(candidates.length === CANDIDATE_CAP
        ? { truncated_at_candidates: CANDIDATE_CAP }
        : {}),
    };
  }

  /**
   * Venue ids whose operating hours contain `[from, to)` on the relevant local
   * day. City is passed through so an availability search does not evaluate
   * hours for every venue on the platform.
   */
  private async venuesOpenFor(
    from: Date,
    to: Date,
    city: string | undefined,
  ): Promise<string[]> {
    const rows = await this.db
      .select({
        id: venues.id,
        timezone: venues.timezone,
        operatingHours: venues.operatingHours,
      })
      .from(venues)
      .where(city ? sql`lower(${venues.city}) = lower(${city})` : undefined);

    return rows
      .filter((v) => {
        const hours = parseOperatingHours(v.operatingHours);
        return hours !== null && isWithinOperatingHours(hours, v.timezone, from, to);
      })
      .map((v) => v.id);
  }

  private async page(where: SQL | undefined, page: number, pageSize: number) {
    const rows = await this.db
      .select({
        id: rooms.id,
        name: rooms.name,
        capacity: rooms.capacity,
        amenities: rooms.amenities,
        hourly_rate_minor: rooms.hourlyRateMinor,
        min_duration_minutes: rooms.minDurationMinutes,
        max_duration_minutes: rooms.maxDurationMinutes,
        venue_id: venues.id,
        venue_name: venues.name,
        city: venues.city,
        timezone: venues.timezone,
      })
      .from(rooms)
      .innerJoin(venues, eq(venues.id, rooms.venueId))
      .where(where)
      // A stable secondary sort on id. Without it, two rooms at the same price
      // can swap places between pages and one of them is never shown.
      .orderBy(asc(rooms.hourlyRateMinor), asc(rooms.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    return rows.map((r) => ({ ...r, hourly_rate_minor: r.hourly_rate_minor.toString() }));
  }

  private async count(where: SQL | undefined): Promise<number> {
    const [row] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(rooms)
      .innerJoin(venues, eq(venues.id, rooms.venueId))
      .where(where);
    return row?.total ?? 0;
  }
}
