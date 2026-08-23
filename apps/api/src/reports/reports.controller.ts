import { Controller, Get, Query } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { RevenueReportSchema, type RevenueReportQuery } from './reports.schemas';
import { zodBody } from '../common/pipes/zod-validation.pipe';
import { Roles } from '../common/decorators/roles.decorator';

/**
 * Venue reporting.
 *
 * ## PLATFORM_ADMIN is deliberately not on this route
 *
 * This is the exact mirror of `/admin/reconciliation`, which refuses a
 * VENUE_ADMIN rather than handing them a venue-scoped slice of it. The reason
 * is the same in both directions: the report is *of a venue*, the venue comes
 * from the token, and a PLATFORM_ADMIN has no venue in their token. The two
 * ways to serve one anyway are both worse than a 403 —
 *
 *   - accept a `?venue_id=` for platform admins, which puts a tenant identifier
 *     back in the request where CLAUDE.md hard rule 4 says it may never be a
 *     source of truth, and makes this the one endpoint where that rule has an
 *     exception to remember; or
 *   - return the platform-wide aggregate, which is a different report wearing
 *     this one's name and would quietly answer "which venue?" with "all of
 *     them".
 *
 * A platform-wide revenue view is a real thing to want. It is a separate
 * endpoint with its own shape, and it is not in this phase.
 */
@Controller('venues')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  /**
   * Revenue and utilisation for the caller's venue over a date range.
   *
   * Bookings are attributed to the range by `starts_at` — when the room was
   * used — not by `created_at`. A booking made in March for a date in June is
   * June's revenue, which is what a venue admin means by "what did we make last
   * month" and is also the only reading under which utilisation has a
   * denominator that matches the numerator.
   */
  @Get('reports/revenue')
  @Roles('VENUE_ADMIN', 'VENUE_STAFF')
  revenue(@Query(zodBody(RevenueReportSchema)) query: RevenueReportQuery) {
    return this.reports.revenue(query);
  }
}
