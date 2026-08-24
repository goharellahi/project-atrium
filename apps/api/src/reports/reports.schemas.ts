import { z } from 'zod';

/**
 * The revenue report's query string.
 *
 * There is no `venue_id` here, and there is not going to be one. The venue
 * comes from the token (CLAUDE.md hard rule 4); a caller who could name the
 * venue could name someone else's. The report is therefore *the caller's*
 * venue, always, and the INV-6 suite probes it on that basis.
 */

const IsoInstant = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value))
  .refine((d) => Number.isFinite(d.getTime()), 'Not a valid instant');

/**
 * 366 days, not 30.
 *
 * The benchmarked case is 30 days, but a year-over-year comparison is the
 * obvious next question a venue admin asks and refusing it would be arbitrary.
 * The cap exists so the response cannot become unbounded — `by_day` is one row
 * per day and `by_room` one per room, so the payload is bounded by the range,
 * not by booking volume.
 */
const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1000;

export const RevenueReportSchema = z
  .object({
    from: IsoInstant,
    to: IsoInstant,
  })
  .refine((v) => v.to > v.from, { path: ['to'], message: 'to must be after from' })
  .refine((v) => v.to.getTime() - v.from.getTime() <= MAX_RANGE_MS, {
    path: ['to'],
    message: 'Report range may not exceed 366 days',
  });

export type RevenueReportQuery = z.infer<typeof RevenueReportSchema>;
