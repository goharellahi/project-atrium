import { z } from 'zod';

/**
 * Wire schemas for the booking endpoints.
 *
 * Everything expressible without a database round trip is checked here and
 * fails 422. The rules that need the venue — operating hours, the room's own
 * min/max duration — cannot be, and are enforced in `BookingsService` with the
 * same 422. 422 throughout for "this request could never be valid"; 409 is
 * reserved for "this request is well formed but the world says no", so a client
 * can tell a bug in its own code from a lost race.
 */

/**
 * Bookings are on a 30-minute grid.
 *
 * Checked on the absolute instant rather than on local wall-clock minutes. Every
 * IANA zone in current use has an offset that is a whole number of 15-minute
 * steps, and all of the ones this platform serves (Karachi +05:00, Dubai
 * +04:00, London +00:00/+01:00) are whole hours or half hours — so a UTC
 * instant on the half hour is on the half hour locally too.
 */
const THIRTY_MINUTES_MS = 30 * 60 * 1000;

const IsoInstant = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value))
  .refine((d) => Number.isFinite(d.getTime()), 'Not a valid instant');

const OnTheHalfHour = IsoInstant.refine(
  (d) => d.getTime() % THIRTY_MINUTES_MS === 0,
  'Bookings must start and end on a 30-minute boundary',
);

export const LineItemSchema = z.object({
  equipment_type_id: z.string().uuid(),
  quantity: z.number().int().positive().max(1000),
});

export const MIN_DURATION_MINUTES = 60;
export const MAX_DURATION_MINUTES = 480;
export const MIN_LEAD_MINUTES = 60;
export const MAX_LEAD_DAYS = 90;

export const HoldSchema = z
  .object({
    room_id: z.string().uuid(),
    starts_at: OnTheHalfHour,
    ends_at: OnTheHalfHour,
    /**
     * Absent and `[]` mean the same thing: a room-only booking. The equipment
     * branch of the hold transaction is skipped entirely rather than run with an
     * empty set, so a room-only hold never touches `equipment_types` and never
     * takes a lock it does not need.
     */
    line_items: z.array(LineItemSchema).max(50).default([]),
  })
  .superRefine((value, ctx) => {
    const durationMinutes = (value.ends_at.getTime() - value.starts_at.getTime()) / 60_000;

    if (durationMinutes <= 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['ends_at'],
        message: 'ends_at must be after starts_at',
      });
      return;
    }

    if (durationMinutes < MIN_DURATION_MINUTES || durationMinutes > MAX_DURATION_MINUTES) {
      ctx.addIssue({
        code: 'custom',
        path: ['ends_at'],
        message: `Duration must be between ${MIN_DURATION_MINUTES / 60} and ${MAX_DURATION_MINUTES / 60} hours (got ${durationMinutes / 60})`,
      });
    }

    // Duplicate equipment types would each pass the admission check
    // independently and then both be inserted, so the booking would reserve
    // more than the check ever approved. Rejected rather than summed, because
    // summing silently accepts a request the client did not mean to make.
    const seen = new Set<string>();
    for (const [index, item] of value.line_items.entries()) {
      if (seen.has(item.equipment_type_id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['line_items', index, 'equipment_type_id'],
          message: 'Duplicate equipment_type_id — combine into one line item',
        });
      }
      seen.add(item.equipment_type_id);
    }
  });

export type HoldInput = z.infer<typeof HoldSchema>;

export const CancelSchema = z.object({
  reason: z.string().min(1).max(500).default('customer.cancelled'),
});
export type CancelInput = z.infer<typeof CancelSchema>;

export const ListBookingsSchema = z.object({
  status: z
    .enum([
      'DRAFT',
      'HELD',
      'PENDING_PAYMENT',
      'CONFIRMED',
      'COMPLETED',
      'EXPIRED',
      'FAILED',
      'CANCELLED',
      'REFUNDED',
    ])
    .optional(),
  from: IsoInstant.optional(),
  to: IsoInstant.optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(25),
});
export type ListBookingsQuery = z.infer<typeof ListBookingsSchema>;

export const AvailabilitySchema = z
  .object({
    from: IsoInstant,
    to: IsoInstant,
    /** Slot length to enumerate, in minutes. Defaults to the room's minimum. */
    duration_minutes: z.coerce
      .number()
      .int()
      .min(MIN_DURATION_MINUTES)
      .max(MAX_DURATION_MINUTES)
      .optional(),
  })
  .refine((v) => v.to > v.from, { path: ['to'], message: 'to must be after from' })
  .refine(
    // A 31-day cap, not because the query is expensive but because the response
    // is: enumerating half-hour slots over a year is megabytes of JSON nobody
    // reads. Pagination is the wrong shape here — callers want a calendar month.
    (v) => v.to.getTime() - v.from.getTime() <= 31 * 24 * 60 * 60 * 1000,
    { path: ['to'], message: 'Availability range may not exceed 31 days' },
  );
export type AvailabilityQuery = z.infer<typeof AvailabilitySchema>;

export const SearchSchema = z
  .object({
    city: z.string().min(1).max(120).optional(),
    min_capacity: z.coerce.number().int().min(1).max(10_000).optional(),
    /** Repeatable (`?amenity=wifi&amenity=piano`) or comma separated. */
    amenity: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .transform((v) => {
        if (v === undefined) return [] as string[];
        const raw = Array.isArray(v) ? v : [v];
        return raw
          .flatMap((entry) => entry.split(','))
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0);
      }),
    max_hourly_rate_minor: z.coerce.number().int().nonnegative().optional(),
    from: IsoInstant.optional(),
    to: IsoInstant.optional(),
    page: z.coerce.number().int().min(1).default(1),
    page_size: z.coerce.number().int().min(1).max(100).default(20),
  })
  .refine((v) => (v.from === undefined) === (v.to === undefined), {
    path: ['to'],
    message: 'from and to must be supplied together',
  })
  .refine((v) => v.from === undefined || v.to === undefined || v.to > v.from, {
    path: ['to'],
    message: 'to must be after from',
  });
export type SearchQuery = z.infer<typeof SearchSchema>;
