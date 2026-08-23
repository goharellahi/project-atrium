import { ForbiddenException, Injectable } from '@nestjs/common';
import type { Db } from '../db/client';
import { cancellationPolicies } from '../db/schema';
import { log } from '../common/logger';
import type { AuthPrincipal } from '../common/context/request-context';
import { PaymentsService } from '../payments/payments.service';
import type { Tier } from '../payments/refund-policy';

@Injectable()
export class PoliciesService {
  constructor(
    private readonly db: Db,
    private readonly payments: PaymentsService,
  ) {}

  async current(principal: AuthPrincipal): Promise<unknown> {
    const resolved = await this.payments.resolveTiers(this.db, principal.venueId);
    return {
      venue_id: principal.venueId,
      policy_id: resolved.policyId,
      resolved_from: resolved.from,
      tiers: resolved.tiers,
    };
  }

  /**
   * Write a new policy for the caller's venue.
   *
   * The venue comes from `principal.venueId` and from nowhere else. A
   * PLATFORM_ADMIN has no venue and is refused rather than silently writing the
   * platform default — changing every venue's terms at once is not something to
   * do by accident through the same endpoint a venue admin uses.
   */
  async replace(tiers: Tier[], principal: AuthPrincipal): Promise<unknown> {
    if (!principal.venueId) {
      throw new ForbiddenException(
        'Only a venue administrator may set a venue cancellation policy',
      );
    }

    const [row] = await this.db
      .insert(cancellationPolicies)
      .values({ venueId: principal.venueId, tiers })
      .returning();

    log().info(
      { venueId: principal.venueId, policyId: row!.id, tierCount: tiers.length },
      'cancellation_policy.replaced',
    );

    return {
      venue_id: principal.venueId,
      policy_id: row!.id,
      resolved_from: 'venue',
      tiers,
      // Said plainly, because it is the surprising half of the design and the
      // half that makes it correct: this changes nothing already confirmed.
      note: 'Applies to bookings confirmed from now on. Bookings already CONFIRMED keep the policy snapshot frozen at their confirmation.',
    };
  }
}
