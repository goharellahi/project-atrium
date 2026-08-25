import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { AvailabilityService } from './availability.service';
import { RoomsService } from './rooms.service';
import { AvailabilitySchema, type AvailabilityQuery } from '../bookings/bookings.schemas';
import { zodBody } from '../common/pipes/zod-validation.pipe';

@Controller('rooms')
export class RoomsController {
  constructor(
    private readonly availability: AvailabilityService,
    private readonly rooms: RoomsService,
  ) {}

  /**
   * One room from the cross-venue catalogue.
   *
   * Readable by any signed-in user, for the reason `RoomsService` states at
   * length: `/search` already publishes every venue's rooms, so the same room
   * addressed by its own id is not a tenant secret. Nothing venue-operational
   * is on this response.
   *
   * `:id` is not an authorisation input here — there is no venue scope to
   * derive — so hard rule 4 is not in play. It is the resource being read.
   */
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.rooms.findOne(id);
  }

  /**
   * Free slots for one room over a range.
   *
   * Advisory, and documented as such in the service: it reports what was free
   * when it ran. The hold path does not consult it. A design in which this
   * read gated the write would have a race in it by construction.
   */
  @Get(':id/availability')
  availabilityForRoom(
    @Param('id', ParseUUIDPipe) id: string,
    @Query(zodBody(AvailabilitySchema)) query: AvailabilityQuery,
  ) {
    return this.availability.forRoom(id, query);
  }

  /**
   * The equipment catalogue a booker can act on, scoped to this room's venue.
   *
   * The customer-readable half of the inventory. `GET /equipment-types` remains
   * staff-only and unchanged; this exposes name, hourly rate and units owned,
   * and nothing that says how the venue is doing.
   */
  @Get(':id/equipment-types')
  equipmentForRoom(@Param('id', ParseUUIDPipe) id: string) {
    return this.rooms.equipmentForRoom(id);
  }
}
