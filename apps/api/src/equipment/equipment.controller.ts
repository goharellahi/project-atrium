import { Controller, Get, NotFoundException, Param, ParseUUIDPipe } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { Inject } from '@nestjs/common';
import type { Db } from '../db/client';
import { equipmentTypes } from '../db/schema';
import { DB } from '../app.tokens';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthPrincipal } from '../common/context/request-context';

/**
 * Equipment inventory, venue-scoped.
 *
 * Small, and here for a specific reason: the brief's required negative test
 * names a booking, a room and an **equipment type** as things a VENUE_ADMIN of
 * Venue A must not be able to reach at Venue B by direct valid UUID. Until this
 * phase there was no equipment endpoint at all, so that half of the requirement
 * had nothing to assert against — the isolation was untested rather than
 * proven, which for a hard-capped requirement is the same as absent.
 *
 * The scope comes from the token. A PLATFORM_ADMIN sees everything; nobody else
 * sees past their own venue; and the single-item read returns 404 rather than
 * 403 for another venue's row, so a valid UUID cannot be used to confirm the
 * row exists.
 */
@Controller('equipment-types')
export class EquipmentController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  @Roles('VENUE_ADMIN', 'VENUE_STAFF', 'PLATFORM_ADMIN')
  async list(@CurrentUser() principal: AuthPrincipal) {
    const rows = await this.db
      .select()
      .from(equipmentTypes)
      .where(this.scope(principal));

    return { data: rows.map(present) };
  }

  @Get(':id')
  @Roles('VENUE_ADMIN', 'VENUE_STAFF', 'PLATFORM_ADMIN')
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    const [row] = await this.db
      .select()
      .from(equipmentTypes)
      .where(and(eq(equipmentTypes.id, id), this.scope(principal)))
      .limit(1);

    if (!row) throw new NotFoundException();
    return present(row);
  }

  private scope(principal: AuthPrincipal) {
    if (principal.role === 'PLATFORM_ADMIN') return undefined;
    if (!principal.venueId) throw new NotFoundException();
    return eq(equipmentTypes.venueId, principal.venueId);
  }
}

/** Explicit projection — `hourly_rate_minor` is a bigint and JSON.stringify throws on those. */
function present(row: typeof equipmentTypes.$inferSelect) {
  return {
    id: row.id,
    venue_id: row.venueId,
    name: row.name,
    units_owned: row.unitsOwned,
    hourly_rate_minor: row.hourlyRateMinor.toString(),
  };
}
