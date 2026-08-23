import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { AvailabilityService } from './availability.service';
import { AvailabilitySchema, type AvailabilityQuery } from '../bookings/bookings.schemas';
import { zodBody } from '../common/pipes/zod-validation.pipe';

@Controller('rooms')
export class RoomsController {
  constructor(private readonly availability: AvailabilityService) {}

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
}
