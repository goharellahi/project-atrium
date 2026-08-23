import {
  bigint,
  boolean,
  char,
  customType,
  index,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  integer,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * `tstzrange` has no first-class Drizzle column type. It is declared as a
 * custom type so that queries can reference `bookings.slot` in a typed way and
 * — importantly — so that drizzle-kit's snapshot knows the column exists.
 *
 * Without it in the snapshot, the next `drizzle-kit generate` would see a
 * column in the database that is absent from the schema and helpfully emit
 * `ALTER TABLE bookings DROP COLUMN slot`, taking INV-1 with it.
 */
const tstzrange = customType<{ data: string; driverData: string }>({
  dataType: () => 'tstzrange',
});

/**
 * Atrium schema.
 *
 * Two things in here are NOT expressible in Drizzle's DSL and live in the
 * hand-written migration `0001_constraints.sql` instead:
 *
 *   1. `bookings.slot` — a GENERATED ALWAYS ... STORED tstzrange carrying the
 *      15-minute turnaround buffer.
 *   2. `no_room_overlap` — the EXCLUDE USING gist constraint that is the whole
 *      of INV-1, and the audit_events immutability trigger.
 *
 * The `slot` column is declared here as a plain custom-typed column so queries
 * can reference it, but Drizzle must never be allowed to generate DDL for it.
 * See apps/api/src/db/migrations/README.md.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const userRole = pgEnum('user_role', [
  'CUSTOMER',
  'VENUE_STAFF',
  'VENUE_ADMIN',
  'PLATFORM_ADMIN',
]);

export const bookingStatus = pgEnum('booking_status', [
  'DRAFT',
  'HELD',
  'PENDING_PAYMENT',
  'CONFIRMED',
  'COMPLETED',
  'EXPIRED',
  'FAILED',
  'CANCELLED',
  'REFUNDED',
]);

export const paymentStatus = pgEnum('payment_status', [
  'PENDING',
  'SUCCEEDED',
  'FAILED',
  'REFUNDED',
]);

export const auditActorType = pgEnum('audit_actor_type', [
  'USER',
  'SYSTEM',
  'PAYGATE',
]);

// ---------------------------------------------------------------------------
// Tenancy
// ---------------------------------------------------------------------------

/**
 * `operating_hours` shape, validated in the application by zod, not by the
 * database:
 *   { "mon": { "open": "09:00", "close": "21:00" }, ..., "sun": null }
 * A null day means closed. Times are local to the venue's `timezone`.
 */
export const venues = pgTable('venues', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  city: text('city').notNull(),
  timezone: text('timezone').notNull(),
  operatingHours: jsonb('operating_hours').notNull(),
  // Equipment only. A room is a single physical space, so a buffer on it would
  // violate INV-1 directly — rooms reject any non-zero buffer with 422.
  // See ARCHITECTURE.md, Assumption 2.
  overbookingBufferPct: smallint('overbooking_buffer_pct').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (t) => [index('venues_city_idx').on(t.city)]);

export const rooms = pgTable('rooms', {
  id: uuid('id').primaryKey().defaultRandom(),
  venueId: uuid('venue_id')
    .notNull()
    .references(() => venues.id, { onDelete: 'restrict' }),
  name: text('name').notNull(),
  capacity: integer('capacity').notNull(),
  hourlyRateMinor: bigint('hourly_rate_minor', { mode: 'bigint' }).notNull(),
  amenities: text('amenities').array().notNull().default(sql`'{}'::text[]`),
  minDurationMinutes: integer('min_duration_minutes').notNull().default(60),
  maxDurationMinutes: integer('max_duration_minutes').notNull().default(480),
}, (t) => [index('rooms_venue_idx').on(t.venueId)]);

export const equipmentTypes = pgTable('equipment_types', {
  id: uuid('id').primaryKey().defaultRandom(),
  venueId: uuid('venue_id')
    .notNull()
    .references(() => venues.id, { onDelete: 'restrict' }),
  name: text('name').notNull(),
  hourlyRateMinor: bigint('hourly_rate_minor', { mode: 'bigint' }).notNull(),
  unitsOwned: integer('units_owned').notNull(),
}, (t) => [index('equipment_types_venue_idx').on(t.venueId)]);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: userRole('role').notNull(),
  // NULL for CUSTOMER and PLATFORM_ADMIN; required for VENUE_STAFF and
  // VENUE_ADMIN. Enforced by a CHECK constraint in 0001_constraints.sql.
  venueId: uuid('venue_id').references(() => venues.id, {
    onDelete: 'restrict',
  }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (t) => [index('users_venue_idx').on(t.venueId)]);

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/**
 * Cancellation policy is data, not code, and is **never updated in place**.
 * A venue admin changing their tiers inserts a new row that supersedes the
 * previous one, so a historical booking can always resolve the policy that was
 * live when it confirmed.
 *
 * `venue_id IS NULL` is the platform default.
 *
 * Note this is belt-and-braces with the policy snapshot on `bookings`: the
 * snapshot is what cancellation actually reads (Assumption 3). This table
 * being append-only means the snapshot can be audited against the policy that
 * was live at the time, rather than merely trusted.
 *
 * `tiers` shape:
 *   [{ "min_hours_before": 48, "room_refund_pct": 100, "equipment_refund_pct": 100 }, ...]
 * ordered descending by `min_hours_before`.
 */
export const cancellationPolicies = pgTable('cancellation_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  venueId: uuid('venue_id').references(() => venues.id, {
    onDelete: 'restrict',
  }),
  tiers: jsonb('tiers').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (t) => [index('cancellation_policies_venue_created_idx').on(t.venueId, t.createdAt)]);

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------

export const bookings = pgTable('bookings', {
  id: uuid('id').primaryKey().defaultRandom(),

  // Denormalised deliberately. Every tenant-isolation check is then a column
  // comparison on this table rather than a join through rooms -> venues, which
  // matters both for correctness (harder to forget) and for the p95 targets on
  // 250k rows. Recorded in DECISIONS.md.
  venueId: uuid('venue_id')
    .notNull()
    .references(() => venues.id, { onDelete: 'restrict' }),

  roomId: uuid('room_id')
    .notNull()
    .references(() => rooms.id, { onDelete: 'restrict' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'restrict' }),

  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),

  /**
   * The interval the `no_room_overlap` exclusion constraint actually enforces.
   *
   * It is NOT [starts_at, ends_at). It carries the 15-minute turnaround gap,
   * so a 14:00-16:00 booking occupies 14:00-16:15 as far as the constraint is
   * concerned. That is why the turnaround rule needs no application check: it
   * is the same constraint as the overlap rule.
   *
   * Created by `0001_constraints.sql`, not by Drizzle — see that file. Declared
   * here so the snapshot knows it exists and queries can reference it. Never
   * write to it; Postgres rejects writes to a generated column.
   */
  slot: tstzrange('slot').generatedAlwaysAs(
    sql`tstzrange(starts_at, ((ends_at AT TIME ZONE 'UTC') + interval '15 minutes') AT TIME ZONE 'UTC', '[)')`,
  ),

  status: bookingStatus('status').notNull().default('DRAFT'),

  // Hold TTL. NULL once the booking leaves the holding states.
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  // Checkout re-arms: at most 2, never beyond 30 minutes total hold life.
  // See ARCHITECTURE.md, Assumption 1.
  rearmCount: smallint('rearm_count').notNull().default(0),

  // Resolved cancellation tiers, frozen at confirmation. Cancellation reads
  // this and never live policy, so a later policy change cannot retroactively
  // alter an already CONFIRMED booking (Assumption 3).
  policySnapshot: jsonb('policy_snapshot'),

  totalMinor: bigint('total_minor', { mode: 'bigint' })
    .notNull()
    .default(sql`0`),
  currency: char('currency', { length: 3 }).notNull().default('PKR'),

  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (t) => [
  index('bookings_venue_idx').on(t.venueId),
  index('bookings_user_idx').on(t.userId),
  index('bookings_room_starts_idx').on(t.roomId, t.startsAt),
  index('bookings_status_expires_idx').on(t.status, t.expiresAt),
]);

export const bookingLineItems = pgTable('booking_line_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  bookingId: uuid('booking_id')
    .notNull()
    .references(() => bookings.id, { onDelete: 'cascade' }),
  equipmentTypeId: uuid('equipment_type_id')
    .notNull()
    .references(() => equipmentTypes.id, { onDelete: 'restrict' }),
  quantity: integer('quantity').notNull(),
  rateMinor: bigint('rate_minor', { mode: 'bigint' }).notNull(),
}, (t) => [
  index('booking_line_items_booking_idx').on(t.bookingId),
  // The sweep-line peak-concurrent-usage query (INV-2) drives off this.
  index('booking_line_items_equipment_idx').on(t.equipmentTypeId),
]);

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

/**
 * One row per charge attempt.
 *
 * `idempotency_key` is UNIQUE and is generated by us before calling Paygate,
 * so a client retry or an API-side retry reuses the same key and cannot create
 * a second charge (INV-3). `charge_id` is UNIQUE and nullable because Paygate
 * may deliver the webhook before its own 202 response reaches us — the 25%
 * "race on response" chaos behaviour — so the row exists before we know the id.
 */
export const payments = pgTable('payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  bookingId: uuid('booking_id')
    .notNull()
    .references(() => bookings.id, { onDelete: 'restrict' }),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  chargeId: text('charge_id').unique(),
  amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
  status: paymentStatus('status').notNull().default('PENDING'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (t) => [index('payments_booking_idx').on(t.bookingId)]);

/**
 * The idempotency ledger for business effect, as distinct from delivery
 * de-duplication.
 *
 * UNIQUE (charge_id, event) is the mechanism behind INV-3: applying an event is
 * conditional on inserting this row, so `charge.succeeded` for a given charge
 * can take effect exactly once no matter how many deliveries carry it, in what
 * order they arrive, or how many replicas process them concurrently.
 *
 * `occurred_at` is Paygate's timestamp (unreliable, out of order).
 * `applied_at` is ours (when the effect actually landed).
 */
export const paymentEvents = pgTable('payment_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  chargeId: text('charge_id').notNull(),
  event: text('event').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  appliedAt: timestamp('applied_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (t) => [uniqueIndex('payment_events_charge_event_uq').on(t.chargeId, t.event)]);

/**
 * Every inbound webhook delivery, valid or not, recorded before processing.
 *
 * This is the audit surface for the chaos behaviours: bad signatures (rejected
 * 401, never processed), deliveries for charges we have never heard of, and
 * duplicates. `delivery_id` is UNIQUE, but note that de-duplicating on it is
 * NOT how INV-3 is achieved — Paygate sends a new delivery id on every attempt,
 * so this table catches retries of the same delivery, not redeliveries of the
 * same event. Business idempotency lives in `payment_events`.
 */
export const webhookDeliveries = pgTable('webhook_deliveries', {
  id: uuid('id').primaryKey().defaultRandom(),
  deliveryId: text('delivery_id').notNull().unique(),
  chargeId: text('charge_id'),
  signatureValid: boolean('signature_valid').notNull(),
  rawBody: jsonb('raw_body').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  error: text('error'),
}, (t) => [
  index('webhook_deliveries_charge_idx').on(t.chargeId),
  index('webhook_deliveries_unprocessed_idx').on(t.processedAt),
]);

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/**
 * Append only. Never updated, never deleted — enforced by the
 * `audit_events_no_mutate` trigger in 0001_constraints.sql, not by convention.
 *
 * Every booking state transition writes exactly one row here.
 */
export const auditEvents = pgTable('audit_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  bookingId: uuid('booking_id').references(() => bookings.id, {
    onDelete: 'restrict',
  }),
  actorType: auditActorType('actor_type').notNull(),
  actorId: uuid('actor_id'),
  fromState: bookingStatus('from_state'),
  toState: bookingStatus('to_state'),
  reason: text('reason').notNull(),
  metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
  occurredAt: timestamp('occurred_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (t) => [
  index('audit_events_booking_idx').on(t.bookingId),
  index('audit_events_occurred_idx').on(t.occurredAt),
]);

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type Venue = typeof venues.$inferSelect;
export type Room = typeof rooms.$inferSelect;
export type EquipmentType = typeof equipmentTypes.$inferSelect;
export type User = typeof users.$inferSelect;
export type CancellationPolicy = typeof cancellationPolicies.$inferSelect;
export type Booking = typeof bookings.$inferSelect;
export type BookingLineItem = typeof bookingLineItems.$inferSelect;
export type Payment = typeof payments.$inferSelect;
export type PaymentEvent = typeof paymentEvents.$inferSelect;
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;

export type UserRole = (typeof userRole.enumValues)[number];
export type BookingStatus = (typeof bookingStatus.enumValues)[number];
export type PaymentStatusValue = (typeof paymentStatus.enumValues)[number];
export type AuditActorType = (typeof auditActorType.enumValues)[number];

/** The statuses the `no_room_overlap` exclusion constraint applies to. */
export const ACTIVE_BOOKING_STATUSES = [
  'HELD',
  'PENDING_PAYMENT',
  'CONFIRMED',
] as const satisfies readonly BookingStatus[];
