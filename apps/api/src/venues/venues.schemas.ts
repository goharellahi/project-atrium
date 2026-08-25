import { z } from 'zod';
import { OperatingHoursSchema } from '../common/time/operating-hours';

/**
 * Wire schemas for venue administration.
 *
 * ## `venue_id` appears nowhere in this file, and that is the point
 *
 * Every route these schemas serve writes to the caller's own venue, taken from
 * the token. CLAUDE.md hard rule 4 is not "check the body's venue against the
 * token" — it is that there must be nothing in the request to check, because a
 * check is one forgotten line away from a cross-tenant write. A `venue_id` sent
 * anyway is not an error, it is simply not read; the INV-6 suite asserts that a
 * venue admin of A who names venue B in the body still writes to A.
 *
 * Reads are 422 on anything malformed, in line with the rest of the API.
 */

/**
 * The brief: "a venue admin may enable an overbooking buffer of up to 10% on
 * any inventory to absorb no shows."
 *
 * The cap is enforced in three places, deliberately, and none of them is
 * redundant:
 *
 *   1. here, so a client gets 422 with a message naming the range;
 *   2. `venues_overbooking_buffer_ck`, so a write that bypasses this schema —
 *      a migration, a psql session, a future endpoint — still cannot store 40;
 *   3. `admissionCeiling`, which floors the product, so a buffer can never
 *      admit a fractional unit.
 *
 * A CHECK constraint alone would surface as a 500 carrying a Postgres error
 * string, which is the wrong status and the wrong message.
 */
export const OverbookingBufferPct = z
  .number()
  .int('The overbooking buffer is a whole percentage')
  .min(0, 'The overbooking buffer cannot be negative')
  .max(10, 'The overbooking buffer is capped at 10%');

export const UpdateVenueSettingsSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    city: z.string().trim().min(1).max(120).optional(),
    /**
     * Validated against the platform's own tz database rather than by regex.
     * A venue stored with `Asia/Karachhi` does not fail here — it fails much
     * later, inside operating-hours arithmetic, as a RangeError on a request
     * that has nothing to do with the typo.
     */
    timezone: z
      .string()
      .trim()
      .min(1)
      .refine(isKnownTimezone, 'Not an IANA timezone this runtime recognises')
      .optional(),
    operating_hours: OperatingHoursSchema.optional(),
    overbooking_buffer_pct: OverbookingBufferPct.optional(),
  })
  // An empty body would be a successful request that changed nothing, and a
  // client cannot tell that from a successful request that changed something.
  .refine(
    (value) => Object.keys(value).length > 0,
    'Provide at least one field to update',
  );

export type UpdateVenueSettingsInput = z.infer<typeof UpdateVenueSettingsSchema>;

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

/**
 * Money in minor units, as a string on the wire.
 *
 * `hourly_rate_minor` is a 64-bit integer in the database and every read
 * endpoint already serialises it as a string, because `JSON.stringify` throws
 * on a BigInt. Accepting it as a string on the way in too keeps one spelling of
 * money across the API, and avoids the case where a rate above 2^53 round-trips
 * through a JS number and comes back changed.
 */
const RateMinor = z
  .union([z.string(), z.number()])
  .transform((value) => String(value).trim())
  .refine((value) => /^\d+$/.test(value), 'Rate must be a whole number of minor units')
  .refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n, 'Rate is out of range')
  .transform((value) => BigInt(value));

/**
 * A room's overbooking buffer, and the only value it may take.
 *
 * The field is accepted rather than ignored so that setting it says something
 * — `RoomsAdminService` answers a non-zero value with 422 and the reason. A
 * schema that dropped it silently would let a venue admin believe they had
 * enabled a buffer on a room, and the first they would hear otherwise is when
 * a double booking did not happen.
 */
const RoomOverbookingBufferPct = z.number().int().min(0).max(100);

const RoomFields = {
  name: z.string().trim().min(1).max(200),
  capacity: z.number().int().positive().max(10_000),
  hourly_rate_minor: RateMinor,
  amenities: z.array(z.string().trim().min(1).max(60)).max(50),
  min_duration_minutes: z.number().int().min(30).max(480),
  max_duration_minutes: z.number().int().min(30).max(480),
  overbooking_buffer_pct: RoomOverbookingBufferPct,
};

export const CreateRoomSchema = z
  .object({
    name: RoomFields.name,
    capacity: RoomFields.capacity,
    hourly_rate_minor: RoomFields.hourly_rate_minor,
    amenities: RoomFields.amenities.default([]),
    min_duration_minutes: RoomFields.min_duration_minutes.default(60),
    max_duration_minutes: RoomFields.max_duration_minutes.default(480),
    overbooking_buffer_pct: RoomFields.overbooking_buffer_pct.optional(),
  })
  .superRefine(durationsCoherent);

export const UpdateRoomSchema = z
  .object({
    name: RoomFields.name.optional(),
    capacity: RoomFields.capacity.optional(),
    hourly_rate_minor: RoomFields.hourly_rate_minor.optional(),
    amenities: RoomFields.amenities.optional(),
    min_duration_minutes: RoomFields.min_duration_minutes.optional(),
    max_duration_minutes: RoomFields.max_duration_minutes.optional(),
    overbooking_buffer_pct: RoomFields.overbooking_buffer_pct.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field to update')
  .superRefine(durationsCoherent);

export type CreateRoomInput = z.infer<typeof CreateRoomSchema>;
export type UpdateRoomInput = z.infer<typeof UpdateRoomSchema>;

/**
 * Only checked when both bounds are present in the same request.
 *
 * A PATCH that lowers `max_duration_minutes` alone could still cross the stored
 * minimum; that pairing is re-checked in the service against the row, which is
 * the only place both numbers are known.
 */
function durationsCoherent(
  value: { min_duration_minutes?: number | undefined; max_duration_minutes?: number | undefined },
  ctx: z.RefinementCtx,
): void {
  const { min_duration_minutes: min, max_duration_minutes: max } = value;
  if (min === undefined || max === undefined) return;
  if (min > max) {
    ctx.addIssue({
      code: 'custom',
      path: ['max_duration_minutes'],
      message: 'max_duration_minutes must be at least min_duration_minutes',
    });
  }
}

// ---------------------------------------------------------------------------
// Equipment types
// ---------------------------------------------------------------------------

export const CreateEquipmentTypeSchema = z.object({
  name: z.string().trim().min(1).max(200),
  hourly_rate_minor: RateMinor,
  units_owned: z.number().int().positive().max(100_000),
});

export const UpdateEquipmentTypeSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    hourly_rate_minor: RateMinor.optional(),
    units_owned: z.number().int().positive().max(100_000).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field to update');

export type CreateEquipmentTypeInput = z.infer<typeof CreateEquipmentTypeSchema>;
export type UpdateEquipmentTypeInput = z.infer<typeof UpdateEquipmentTypeSchema>;

function isKnownTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
