import { Injectable, NotFoundException } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { equipmentTypes, rooms, venues } from '../db/schema';

/**
 * Reading one room, and the equipment a booker may attach to it.
 *
 * ## Why these are not venue-scoped
 *
 * The same reason `/search` is not, stated once more because two endpoints now
 * depend on it: tenant isolation protects a venue's **bookings, customers and
 * revenue**. It does not protect the existence of its inventory, which is the
 * catalogue a marketplace publishes. `/search` has always returned every
 * venue's rooms to every signed-in caller; a room the catalogue already
 * advertises cannot become secret when addressed by its own id.
 *
 * So both routes here are readable by any authenticated user and are covered by
 * the INV-6 census as **probed**, not exempt — the assertion is not "another
 * venue is refused", it is "what comes back is inventory and nothing else".
 * `tests/authz` proves the projection, which is the property that actually
 * holds the line: the moment one of these grows a utilisation figure or a
 * revenue column, the probe fails.
 */
@Injectable()
export class RoomsService {
  constructor(private readonly db: Db) {}

  /**
   * One room, with the venue fields the catalogue already publishes.
   *
   * This is the endpoint the console needed and did not have. Until it existed
   * a room's name, venue, city and rate could only be carried on the link that
   * navigated to it, so a pasted or shared URL rendered as a bare UUID.
   */
  async findOne(roomId: string): Promise<unknown> {
    const [row] = await this.db
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
      .where(eq(rooms.id, roomId))
      .limit(1);

    if (!row) throw new NotFoundException();

    // Same shape as one `/search` row, deliberately. The console renders both
    // through one type, and a second spelling of "a room" would be a second
    // thing to keep in step.
    return { ...row, hourly_rate_minor: row.hourly_rate_minor.toString() };
  }

  /**
   * The equipment a customer may add to a booking of this room.
   *
   * ## Why this is not `GET /equipment-types`
   *
   * That route is the venue's own inventory view and stays staff-only. It is
   * reached without a room, so its scope can only come from the token — which
   * is precisely why a customer, who has no venue, gets 403 there and always
   * should.
   *
   * The booker's question is a different one: *what can I attach to THIS room?*
   * The room names the venue, so the scope comes from the path's subject rather
   * than from the caller — the room id is not being trusted as an authorisation
   * input (hard rule 4), it is the resource being read, and the venue is
   * derived from the row, never from the request.
   *
   * ## What is deliberately absent
   *
   * `units_owned`, `name` and the hourly rate, and nothing else. A booker needs
   * to know what exists, what it costs and how many the venue has at all — the
   * last of those is already implied by the 409 the hold path returns, which
   * quotes the ceiling. What must never appear here is anything operational:
   * how many units are out right now, utilisation, revenue, or which bookings
   * hold them. Peak concurrent usage is a live figure about another venue's
   * customers, and a competitor could poll it. The hold path is where capacity
   * is answered, inside the lock, where the answer cannot go stale.
   */
  async equipmentForRoom(roomId: string): Promise<{ data: unknown[] }> {
    const [room] = await this.db
      .select({ venueId: rooms.venueId })
      .from(rooms)
      .where(eq(rooms.id, roomId))
      .limit(1);

    if (!room) throw new NotFoundException();

    const rows = await this.db
      .select({
        id: equipmentTypes.id,
        name: equipmentTypes.name,
        units_owned: equipmentTypes.unitsOwned,
        hourly_rate_minor: equipmentTypes.hourlyRateMinor,
      })
      .from(equipmentTypes)
      .where(eq(equipmentTypes.venueId, room.venueId))
      .orderBy(asc(equipmentTypes.name), asc(equipmentTypes.id));

    return {
      data: rows.map((r) => ({
        ...r,
        hourly_rate_minor: r.hourly_rate_minor.toString(),
        // Echoed so the console can tell at a glance that this list belongs to
        // the room's venue rather than to the caller's. It is the same venue id
        // `GET /rooms/:id` already returns.
        venue_id: room.venueId,
      })),
    };
  }
}
