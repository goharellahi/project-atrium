-- ---------------------------------------------------------------------------
-- 0003_default_cancellation_policy.sql — hand written.
--
-- The platform default cancellation tiers, as data.
--
-- The brief states the tiers as policy, not as behaviour, and requires that a
-- venue can override them "through the API, no deploy". So they live in a row.
-- The alternative — a constant in TypeScript with a database override layered
-- on top — gives two sources of truth for the same number, and the one that
-- answers a given cancellation depends on whether a row happens to exist. This
-- way the resolution rule is a single ORDER BY: the venue's newest policy if it
-- has one, otherwise the platform's newest.
--
-- `venue_id IS NULL` marks the platform default. `cancellation_policies` is
-- append-only by convention (never UPDATEd), so a historical booking can always
-- be audited against the tiers that were live when it confirmed — which is
-- belt-and-braces with the snapshot frozen onto `bookings.policy_snapshot` at
-- confirmation, the thing cancellation actually reads.
--
-- Tiers are ordered descending by `min_hours_before` and the FIRST match wins.
-- The last tier must be `min_hours_before: 0` so the ladder is total: a lookup
-- can never fall off the end and leave a cancellation with no policy.
--
-- The last two tiers encode the brief's asymmetry inside 24 hours — the room is
-- lost, the equipment is not, until 2 hours out. That is why equipment carries
-- its own percentage per tier rather than sharing the room's.
-- ---------------------------------------------------------------------------

INSERT INTO cancellation_policies (venue_id, tiers)
SELECT NULL, '[
  { "min_hours_before": 48, "room_refund_pct": 100, "equipment_refund_pct": 100 },
  { "min_hours_before": 24, "room_refund_pct": 50,  "equipment_refund_pct": 100 },
  { "min_hours_before": 2,  "room_refund_pct": 0,   "equipment_refund_pct": 100 },
  { "min_hours_before": 0,  "room_refund_pct": 0,   "equipment_refund_pct": 0 }
]'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM cancellation_policies WHERE venue_id IS NULL
);
