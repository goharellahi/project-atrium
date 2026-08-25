import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { equipmentTypes, rooms, venues } from '../db/schema';
import { log } from '../common/logger';
import type { AuthPrincipal } from '../common/context/request-context';
import type {
  CreateEquipmentTypeInput,
  CreateRoomInput,
  UpdateEquipmentTypeInput,
  UpdateRoomInput,
  UpdateVenueSettingsInput,
} from './venues.schemas';

/**
 * Venue administration — the write half of a venue's own configuration.
 *
 * ## Why this exists now
 *
 * The overbooking buffer is a **Tier 1** operating rule: a venue admin may
 * enable a buffer of up to 10% on any inventory to absorb no-shows. It has been
 * implemented in the hold path since P2 and completely unreachable since P2,
 * because nothing ever wrote `venues.overbooking_buffer_pct`. A rule that can
 * only be exercised with a psql session is not implemented, it is merely
 * present — and the room-side 422 that refuses a buffer had never run against a
 * real request at all.
 *
 * The console for these endpoints is Tier 2 and comes later. The endpoints come
 * now, because a Tier 1 rule depends on them.
 *
 * ## The scope rule, in one sentence
 *
 * Every method here derives the venue from `principal.venueId` and from nowhere
 * else. There is no method that takes a venue id. A room or equipment id in a
 * path is filtered by `venue_id = <token's venue>` in the same WHERE clause
 * that finds it, so another venue's row is not "found and then refused" — it is
 * never selected, and the response is 404 rather than 403 so a valid UUID
 * cannot be used to confirm the row exists (Assumption 6).
 */
@Injectable()
export class VenuesAdminService {
  constructor(private readonly db: Db) {}

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  async settings(principal: AuthPrincipal): Promise<unknown> {
    const venueId = this.scope(principal);

    const [row] = await this.db
      .select()
      .from(venues)
      .where(eq(venues.id, venueId))
      .limit(1);

    if (!row) throw new NotFoundException();
    return present(row);
  }

  /**
   * Update the caller's venue.
   *
   * `overbooking_buffer_pct` is the field this endpoint was built for. It is
   * capped at 10 by the schema, by `venues_overbooking_buffer_ck`, and by
   * `admissionCeiling` flooring the product — see `venues.schemas.ts` for why
   * all three are wanted.
   *
   * A buffer change takes effect on the next hold and not retroactively, which
   * is the only coherent reading: the admission decision is made inside the
   * hold transaction against the row as it stands. Lowering a buffer therefore
   * cannot un-admit a booking that is already held or confirmed, and must not —
   * those units are genuinely committed.
   */
  async updateSettings(
    input: UpdateVenueSettingsInput,
    principal: AuthPrincipal,
  ): Promise<unknown> {
    const venueId = this.scope(principal);

    const patch: Partial<typeof venues.$inferInsert> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.city !== undefined) patch.city = input.city;
    if (input.timezone !== undefined) patch.timezone = input.timezone;
    if (input.operating_hours !== undefined) patch.operatingHours = input.operating_hours;
    if (input.overbooking_buffer_pct !== undefined) {
      patch.overbookingBufferPct = input.overbooking_buffer_pct;
    }

    const [row] = await this.db
      .update(venues)
      .set(patch)
      .where(eq(venues.id, venueId))
      .returning();

    if (!row) throw new NotFoundException();

    log().info(
      { venueId, fields: Object.keys(input), bufferPct: row.overbookingBufferPct },
      'venue.settings.updated',
    );

    return present(row);
  }

  // -------------------------------------------------------------------------
  // Rooms
  // -------------------------------------------------------------------------

  async createRoom(input: CreateRoomInput, principal: AuthPrincipal): Promise<unknown> {
    const venueId = this.scope(principal);
    this.refuseRoomBuffer(input.overbooking_buffer_pct);

    const [row] = await this.db
      .insert(rooms)
      .values({
        venueId,
        name: input.name,
        capacity: input.capacity,
        hourlyRateMinor: input.hourly_rate_minor,
        amenities: input.amenities,
        minDurationMinutes: input.min_duration_minutes,
        maxDurationMinutes: input.max_duration_minutes,
      })
      .returning();

    log().info({ venueId, roomId: row!.id }, 'venue.room.created');
    return presentRoom(row!);
  }

  async updateRoom(
    roomId: string,
    input: UpdateRoomInput,
    principal: AuthPrincipal,
  ): Promise<unknown> {
    const venueId = this.scope(principal);
    this.refuseRoomBuffer(input.overbooking_buffer_pct);

    // Read inside the same venue filter the write uses. The read is what makes
    // the duration coherence check possible at all — a PATCH that names only
    // one bound has to be compared against the stored other one.
    const [existing] = await this.db
      .select()
      .from(rooms)
      .where(and(eq(rooms.id, roomId), eq(rooms.venueId, venueId)))
      .limit(1);

    if (!existing) throw new NotFoundException();

    const min = input.min_duration_minutes ?? existing.minDurationMinutes;
    const max = input.max_duration_minutes ?? existing.maxDurationMinutes;
    if (min > max) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: 'Unprocessable Entity',
        message: `min_duration_minutes (${min}) would exceed max_duration_minutes (${max})`,
        issues: [
          {
            path: 'min_duration_minutes',
            code: 'custom',
            message: 'Checked against the stored value for whichever bound was not sent',
          },
        ],
      });
    }

    const patch: Partial<typeof rooms.$inferInsert> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.capacity !== undefined) patch.capacity = input.capacity;
    if (input.hourly_rate_minor !== undefined) patch.hourlyRateMinor = input.hourly_rate_minor;
    if (input.amenities !== undefined) patch.amenities = input.amenities;
    if (input.min_duration_minutes !== undefined) patch.minDurationMinutes = min;
    if (input.max_duration_minutes !== undefined) patch.maxDurationMinutes = max;

    // Nothing but a rejected buffer was sent. Answering 200 with the unchanged
    // row would be a lie by omission; the schema's own "at least one field"
    // rule cannot see this case because the field WAS sent.
    if (Object.keys(patch).length === 0) return presentRoom(existing);

    const [row] = await this.db
      .update(rooms)
      .set(patch)
      .where(and(eq(rooms.id, roomId), eq(rooms.venueId, venueId)))
      .returning();

    if (!row) throw new NotFoundException();

    log().info({ venueId, roomId, fields: Object.keys(patch) }, 'venue.room.updated');
    return presentRoom(row);
  }

  async listRooms(principal: AuthPrincipal): Promise<{ data: unknown[] }> {
    const venueId = this.scope(principal);
    const rows = await this.db
      .select()
      .from(rooms)
      .where(eq(rooms.venueId, venueId))
      .orderBy(asc(rooms.name), asc(rooms.id));
    return { data: rows.map(presentRoom) };
  }

  /**
   * The rule the brief states and P2 could not test: **a room takes no
   * overbooking buffer.**
   *
   * A buffer means "admit more than you own, because some will not turn up".
   * For equipment that is a quantity over an interval and the arithmetic is
   * meaningful — 10% of six cameras is a real, if fractional, seventh unit, and
   * `admissionCeiling` floors it away. A room is one physical space. Admitting
   * 1.1 bookings for it is admitting two, and two active bookings for one room
   * at overlapping times is INV-1 violated in the most direct way available:
   * `no_room_overlap` would reject the second insert anyway, so the buffer
   * could not even take effect — it would just turn a clear 422 into a
   * confusing 409 at hold time.
   *
   * So it is refused at the point of configuration, with the reason, rather
   * than accepted and quietly ignored. Zero is accepted because "no buffer" is
   * a legal thing to state explicitly.
   */
  private refuseRoomBuffer(bufferPct: number | undefined): void {
    if (bufferPct === undefined || bufferPct === 0) return;

    throw new UnprocessableEntityException({
      statusCode: 422,
      error: 'Unprocessable Entity',
      message:
        'A room cannot carry an overbooking buffer. A room is a single physical space, so admitting more bookings than it can hold would double-book it and violate INV-1 directly — the exclusion constraint would refuse the second booking regardless. The buffer applies to equipment, where it is a quantity over an interval: set it with PATCH /venues/settings.',
      field: 'overbooking_buffer_pct',
      received: bufferPct,
      allowed: 0,
      applies_to: 'equipment',
    });
  }

  // -------------------------------------------------------------------------
  // Equipment types
  // -------------------------------------------------------------------------

  async createEquipmentType(
    input: CreateEquipmentTypeInput,
    principal: AuthPrincipal,
  ): Promise<unknown> {
    const venueId = this.scope(principal);

    const [row] = await this.db
      .insert(equipmentTypes)
      .values({
        venueId,
        name: input.name,
        hourlyRateMinor: input.hourly_rate_minor,
        unitsOwned: input.units_owned,
      })
      .returning();

    log().info({ venueId, equipmentTypeId: row!.id }, 'venue.equipment_type.created');
    return presentEquipment(row!);
  }

  /**
   * Update one equipment type.
   *
   * `units_owned` may be lowered below what is currently reserved, and that is
   * allowed on purpose: a camera that broke this morning is genuinely gone, and
   * refusing to record it would leave the fleet size lying about the world.
   * What the lower number cannot do is retroactively un-admit bookings that
   * already hold units — those are committed. It applies to every admission
   * from the next hold onward, which is the only place the ceiling is ever
   * consulted.
   */
  async updateEquipmentType(
    equipmentTypeId: string,
    input: UpdateEquipmentTypeInput,
    principal: AuthPrincipal,
  ): Promise<unknown> {
    const venueId = this.scope(principal);

    const patch: Partial<typeof equipmentTypes.$inferInsert> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.hourly_rate_minor !== undefined) {
      patch.hourlyRateMinor = input.hourly_rate_minor;
    }
    if (input.units_owned !== undefined) patch.unitsOwned = input.units_owned;

    const [row] = await this.db
      .update(equipmentTypes)
      .set(patch)
      .where(
        and(eq(equipmentTypes.id, equipmentTypeId), eq(equipmentTypes.venueId, venueId)),
      )
      .returning();

    if (!row) throw new NotFoundException();

    log().info(
      { venueId, equipmentTypeId, fields: Object.keys(patch) },
      'venue.equipment_type.updated',
    );
    return presentEquipment(row);
  }

  /**
   * The venue on the token, or a refusal.
   *
   * A PLATFORM_ADMIN is refused rather than allowed to pick a venue, for the
   * same reason `/venues/reports/revenue` refuses one: accepting a `venue_id`
   * for them would put a tenant identifier back into the request as a source of
   * truth, and make this the one place hard rule 4 has an exception to
   * remember. Platform-wide administration is a different surface with its own
   * shape and is not in this phase.
   */
  private scope(principal: AuthPrincipal): string {
    if (!principal.venueId) {
      throw new ForbiddenException(
        'This endpoint writes to the venue on your token, and your token has no venue. A platform administrator cannot administer a venue through it.',
      );
    }
    return principal.venueId;
  }
}

/** Explicit projections — `hourly_rate_minor` is a bigint and JSON.stringify throws on those. */
function present(row: typeof venues.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    city: row.city,
    timezone: row.timezone,
    operating_hours: row.operatingHours,
    overbooking_buffer_pct: row.overbookingBufferPct,
    // Said on every read, because the asymmetry is the surprising part.
    overbooking_buffer_applies_to: 'equipment',
    created_at: row.createdAt.toISOString(),
  };
}

function presentRoom(row: typeof rooms.$inferSelect) {
  return {
    id: row.id,
    venue_id: row.venueId,
    name: row.name,
    capacity: row.capacity,
    amenities: row.amenities,
    hourly_rate_minor: row.hourlyRateMinor.toString(),
    min_duration_minutes: row.minDurationMinutes,
    max_duration_minutes: row.maxDurationMinutes,
    overbooking_buffer_pct: 0,
  };
}

function presentEquipment(row: typeof equipmentTypes.$inferSelect) {
  return {
    id: row.id,
    venue_id: row.venueId,
    name: row.name,
    units_owned: row.unitsOwned,
    hourly_rate_minor: row.hourlyRateMinor.toString(),
  };
}
