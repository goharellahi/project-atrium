import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { ReconciliationService } from './reconciliation.service';
import { zodBody } from '../common/pipes/zod-validation.pipe';
import { Roles } from '../common/decorators/roles.decorator';

/**
 * `grace_seconds` exists because most "discrepancies" at t=0 are simply work in
 * flight: a charge accepted a second ago whose webhook has not arrived is not
 * lost money. The default of 60 seconds is comfortably longer than Paygate's
 * duplicate window and shorter than its 60–90 s delayed-delivery branch, so a
 * genuinely late delivery still shows up as one — which is correct, because
 * from the reconciler's point of view it IS unaccounted for until it lands.
 *
 * Setting it to 0 shows everything including work in flight, which is what a
 * test wants immediately after driving a scenario.
 */
const ReconciliationQuerySchema = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
  grace_seconds: z.coerce.number().int().min(0).max(86_400).default(60),
});

@Controller('admin')
export class ReconciliationController {
  constructor(private readonly reconciliation: ReconciliationService) {}

  /**
   * PLATFORM_ADMIN only.
   *
   * A venue admin is refused rather than given a venue-scoped view. This report
   * exists to answer whether the PLATFORM has lost money, and the discrepancies
   * that matter most — a delivery that matched no payment at all — have no
   * venue to be scoped to. A per-venue revenue report is a different thing and
   * belongs with the console in P6.
   */
  @Get('reconciliation')
  @Roles('PLATFORM_ADMIN')
  run(
    @Query(zodBody(ReconciliationQuerySchema))
    query: z.infer<typeof ReconciliationQuerySchema>,
  ) {
    return this.reconciliation.run(query.from, query.to, query.grace_seconds);
  }
}
