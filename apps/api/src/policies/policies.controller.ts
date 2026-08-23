import { Body, Controller, Get, Put } from '@nestjs/common';
import { z } from 'zod';
import { PoliciesService } from './policies.service';
import { zodBody } from '../common/pipes/zod-validation.pipe';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthPrincipal } from '../common/context/request-context';
import { TiersSchema } from '../payments/refund-policy';

/**
 * `venue_id` is absent from this schema on purpose.
 *
 * The obvious API would take the venue in the body and check it against the
 * token. That check is one forgotten line away from a cross-tenant write, and
 * CLAUDE.md hard rule 4 exists to remove the class of bug rather than to
 * remember it: there is nothing here for a caller to tamper with, because the
 * venue is read from the token. A `venue_id` sent anyway is ignored, and the
 * INV-6 suite asserts exactly that.
 */
const UpdatePolicySchema = z.object({ tiers: TiersSchema });

@Controller('venues')
export class PoliciesController {
  constructor(private readonly policies: PoliciesService) {}

  /** The tiers that would apply to a booking confirmed right now. */
  @Get('cancellation-policy')
  @Roles('VENUE_ADMIN', 'VENUE_STAFF', 'PLATFORM_ADMIN')
  get(@CurrentUser() principal: AuthPrincipal) {
    return this.policies.current(principal);
  }

  /**
   * Override the platform tiers for the caller's venue. No deploy involved —
   * the brief requires the policy to be data, and this is the write half of it.
   *
   * It INSERTs rather than UPDATEs. `cancellation_policies` is append-only, so
   * a booking confirmed under last month's tiers can still be audited against
   * the exact row that was live then, even though the booking's own snapshot is
   * what a cancellation actually reads.
   */
  @Put('cancellation-policy')
  @Roles('VENUE_ADMIN')
  update(
    @Body(zodBody(UpdatePolicySchema)) body: z.infer<typeof UpdatePolicySchema>,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.policies.replace(body.tiers, principal);
  }
}
