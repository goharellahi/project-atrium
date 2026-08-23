-- ---------------------------------------------------------------------------
-- 0001_constraints.sql — hand written, deliberately.
--
-- This file is where INV-1 and the append-only audit trail actually live. It is
-- kept as one hand-written migration rather than being spread across generated
-- output so that a reviewer can read the whole enforcement story in one place.
--
-- Do not regenerate this file. `drizzle-kit generate` diffs against
-- meta/0000_snapshot.json, which already records `bookings.slot`, so it will
-- not try to re-add or drop the column.
-- ---------------------------------------------------------------------------

-- btree_gist is required because the exclusion constraint below mixes an
-- equality operator on a scalar (room_id WITH =) with an overlap operator on a
-- range (slot WITH &&). Plain GiST has no equality operator class for uuid.
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint

-- The interval the constraint enforces is NOT [starts_at, ends_at).
--
-- It carries the 15-minute turnaround gap, so a 14:00-16:00 booking occupies
-- 14:00-16:15. This is the entire reason the turnaround rule needs no
-- application-level check: it is enforced by the same constraint, in the same
-- atomic operation, as the overlap rule. One rule, one place, no code path
-- around it.
--
-- '[)' — half open. A booking may start at exactly the instant the previous
-- one's turnaround ends.
--
-- The 15 minutes is a PLATFORM constant, not a per-venue setting. A generated
-- column cannot reference another table, so making it per-venue would mean
-- moving the buffer out of the constraint and back into application logic,
-- which is precisely the thing this design exists to avoid. Recorded as an
-- assumption in ARCHITECTURE.md.
ALTER TABLE bookings ADD COLUMN slot tstzrange
  GENERATED ALWAYS AS (
    tstzrange(starts_at, ends_at + interval '15 minutes', '[)')
  ) STORED;
--> statement-breakpoint

-- INV-1. Rooms never double book, under 5 or 200 concurrent requests.
--
-- The partial WHERE clause is what makes this usable: CANCELLED, EXPIRED,
-- FAILED and REFUNDED bookings must not block the slot they used to occupy.
--
-- Two concurrent transactions inserting overlapping slots for the same room do
-- not race in application code at all. The first to reach the constraint check
-- takes the index entry; the second blocks until the first commits, then fails
-- with SQLSTATE 23P01. The number of API replicas is irrelevant, because no API
-- replica is party to the decision.
ALTER TABLE bookings ADD CONSTRAINT no_room_overlap
  EXCLUDE USING gist (room_id WITH =, slot WITH &&)
  WHERE (status IN ('HELD','PENDING_PAYMENT','CONFIRMED'));
--> statement-breakpoint

-- Append-only audit trail, enforced by the database rather than by convention.
-- A hard rule in CLAUDE.md says every transition writes exactly one AuditEvent;
-- this makes tampering with one a hard error rather than a code-review question.
CREATE OR REPLACE FUNCTION audit_events_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'audit_events is append only'; END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER audit_events_no_mutate
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();
--> statement-breakpoint

-- A venue-scoped role is meaningless without a venue, and a platform-wide role
-- is contradicted by one. INV-6 depends on venue_id being trustworthy, so the
-- shape is enforced here rather than assumed by the guards.
ALTER TABLE users ADD CONSTRAINT users_venue_scope_ck CHECK (
  (role IN ('VENUE_STAFF','VENUE_ADMIN') AND venue_id IS NOT NULL)
  OR
  (role IN ('CUSTOMER','PLATFORM_ADMIN') AND venue_id IS NULL)
);
--> statement-breakpoint

-- Booking granularity and advance-window rules are validated in the application
-- (they need the venue's timezone and operating hours), but the degenerate
-- cases are cheap to enforce here and worth catching regardless of caller.
ALTER TABLE bookings ADD CONSTRAINT bookings_interval_ck
  CHECK (ends_at > starts_at);
--> statement-breakpoint

ALTER TABLE booking_line_items ADD CONSTRAINT booking_line_items_qty_ck
  CHECK (quantity > 0);
--> statement-breakpoint

ALTER TABLE equipment_types ADD CONSTRAINT equipment_types_units_ck
  CHECK (units_owned >= 0);
--> statement-breakpoint

-- The brief caps the overbooking buffer at 10%.
ALTER TABLE venues ADD CONSTRAINT venues_overbooking_buffer_ck
  CHECK (overbooking_buffer_pct BETWEEN 0 AND 10);
--> statement-breakpoint

-- Exactly one platform-default cancellation policy may be current at a time.
-- Policies are never updated in place; a change inserts a superseding row, so
-- "current" is the most recent by created_at. This index does not enforce that
-- ordering, it only keeps lookups of the default cheap.
CREATE INDEX cancellation_policies_default_idx
  ON cancellation_policies (created_at DESC)
  WHERE venue_id IS NULL;
