import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { VenuesAdminService } from './venues-admin.service';
import {
  CreateEquipmentTypeSchema,
  CreateRoomSchema,
  UpdateEquipmentTypeSchema,
  UpdateRoomSchema,
  UpdateVenueSettingsSchema,
  type CreateEquipmentTypeInput,
  type CreateRoomInput,
  type UpdateEquipmentTypeInput,
  type UpdateRoomInput,
  type UpdateVenueSettingsInput,
} from './venues.schemas';
import { zodBody } from '../common/pipes/zod-validation.pipe';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthPrincipal } from '../common/context/request-context';

/**
 * Venue administration.
 *
 * Every route is VENUE_ADMIN only and every route writes to the venue on the
 * token. There is no `:venueId` anywhere in this file and there never may be —
 * see `VenuesAdminService` for the whole argument, and `tests/authz` for the
 * proof that a venue admin of A cannot reach B's rooms, equipment or settings
 * even by naming B's id in the body.
 *
 * VENUE_STAFF gets the reads and not the writes. Staff run the desk; changing
 * what the venue charges, when it opens, or how much inventory it claims to own
 * is an owner's decision.
 */
@Controller('venues')
export class VenuesAdminController {
  constructor(private readonly venues: VenuesAdminService) {}

  @Get('settings')
  @Roles('VENUE_ADMIN', 'VENUE_STAFF')
  settings(@CurrentUser() principal: AuthPrincipal) {
    return this.venues.settings(principal);
  }

  /**
   * The endpoint the overbooking buffer needed.
   *
   * `PATCH` and not `PUT`: a venue admin changing the buffer should not have to
   * resend operating hours, and a `PUT` that accepts a partial body is a `PATCH`
   * wearing the wrong verb. `/venues/cancellation-policy` stays a `PUT` because
   * a tier ladder genuinely is replaced whole — a partial update of an ordered
   * ladder has no meaning.
   */
  @Patch('settings')
  @Roles('VENUE_ADMIN')
  updateSettings(
    @Body(zodBody(UpdateVenueSettingsSchema)) body: UpdateVenueSettingsInput,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.venues.updateSettings(body, principal);
  }

  @Get('rooms')
  @Roles('VENUE_ADMIN', 'VENUE_STAFF')
  listRooms(@CurrentUser() principal: AuthPrincipal) {
    return this.venues.listRooms(principal);
  }

  @Post('rooms')
  @Roles('VENUE_ADMIN')
  createRoom(
    @Body(zodBody(CreateRoomSchema)) body: CreateRoomInput,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.venues.createRoom(body, principal);
  }

  @Patch('rooms/:id')
  @Roles('VENUE_ADMIN')
  updateRoom(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(UpdateRoomSchema)) body: UpdateRoomInput,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.venues.updateRoom(id, body, principal);
  }

  @Post('equipment-types')
  @Roles('VENUE_ADMIN')
  createEquipmentType(
    @Body(zodBody(CreateEquipmentTypeSchema)) body: CreateEquipmentTypeInput,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.venues.createEquipmentType(body, principal);
  }

  @Patch('equipment-types/:id')
  @Roles('VENUE_ADMIN')
  updateEquipmentType(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(UpdateEquipmentTypeSchema)) body: UpdateEquipmentTypeInput,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.venues.updateEquipmentType(id, body, principal);
  }
}
