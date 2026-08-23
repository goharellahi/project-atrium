-- ---------------------------------------------------------------------------
-- 0007 — the indexes the plans justified, and the ones they did not.
--
-- Every statement here was chosen by capturing EXPLAIN (ANALYZE, BUFFERS)
-- against the FULL profile — 250,000 bookings, 800 rooms, 24 months — before
-- and after, three warm passes each. Buffer counts are the signal; wall-clock
-- milliseconds under Docker Desktop are too noisy to index on. The transcripts
-- are in LOAD_TEST.md and the script that produces them is
-- tests/load/explain/plans.sql, so this is re-derivable rather than asserted.
-- ---------------------------------------------------------------------------

-- (1) The revenue report: every one of its four queries filters
--     (venue_id, starts_at range).
--
--     Before: Bitmap Index Scan on bookings_venue_idx fetched all 7,264 rows
--     for the venue and threw away 6,956 of them to the date filter — 96%
--     waste, 189 buffers, and it grows with the venue's LIFETIME booking count
--     rather than with the reporting window.
--     After: a tight index range, 29 buffers, 308 rows in and 308 out.
CREATE INDEX IF NOT EXISTS bookings_venue_starts_idx
  ON bookings (venue_id, starts_at);

-- (2) Cross-venue search's availability filter (`freeRoomIds`).
--
--     The exclusion constraint's own gist index is (room_id, slot), and this
--     query has an equality list on room_id, not a single value — so the
--     planner cannot use room_id as a leading key and drives the index on
--     `slot &&` alone, then filters. Descending a (room_id, slot) gist for a
--     time range with no room key means touching subtrees for every room:
--     202 buffers inside the index scan alone, 247 total, to return 45 rows.
--
--     A gist on `slot` by itself, partial on the same active statuses, is the
--     index that query actually wants: 3 buffers in the index, 48 total.
--     It is 3.4 MB against the constraint index's 5.9 MB and does not duplicate
--     it — the constraint index still serves single-room availability (Q1),
--     where it is already optimal and this one is not used.
CREATE INDEX IF NOT EXISTS bookings_active_slot_idx
  ON bookings USING gist (slot)
  WHERE status IN ('HELD','PENDING_PAYMENT','CONFIRMED');

-- (3) The in-transaction expiry of stale holds, on the hold path.
--
--     This one needed a realistic HELD population to evaluate at all: with zero
--     holds in the table the partial index is empty and the planner ignores it,
--     which is not evidence that it is useless. Re-measured with 5,000 stale
--     holds present, the difference is the shape of the scan, not a constant:
--
--       without: BitmapAnd of bookings_status_expires_idx (10,000 index entries
--                — every expired hold ON THE PLATFORM) with
--                bookings_room_starts_idx. 62 buffers in the bitmaps, 64 on the
--                heap.
--       with:    Index Cond (room_id = $1 AND expires_at < now()), 8 buffers.
--
--     The cost of the first version grows with how many stale holds the whole
--     platform is carrying. This runs inside the hold transaction, holding the
--     per-room advisory lock, on every hold request — it is the last place a
--     platform-wide scan belongs.
CREATE INDEX IF NOT EXISTS bookings_room_held_expiry_idx
  ON bookings (room_id, expires_at)
  WHERE status = 'HELD';

-- ---------------------------------------------------------------------------
-- Deletions. Recording why an index went is worth as much as recording why one
-- arrived: both are the same evidence.
-- ---------------------------------------------------------------------------

-- (4) bookings_venue_idx is now a strict prefix of bookings_venue_starts_idx.
--     Postgres can use the composite for anything the single-column index
--     served, so keeping both buys nothing and costs a second index to maintain
--     on every booking write — including inside the hold transaction.
DROP INDEX IF EXISTS bookings_venue_idx;

-- (5) venues_city_idx had ZERO scans across the entire benchmark, and would
--     have had zero however long it ran: cross-venue search filters on
--     `lower(city)` for case-insensitive matching, and a btree on `city` cannot
--     answer that.
--
--     The obvious repair is a functional index on `lower(city)`, and building
--     one DID move the plan — from a nested loop into rooms at 253 buffers to a
--     hash join at 23. But its own scan count stayed at zero. It was never used
--     as an index at all.
--
--     What it changed was the ESTIMATE. Postgres collects statistics on indexed
--     expressions, so with the index present the planner knew `lower(city) =
--     'karachi'` matches fourteen venues; without it, it fell back to a default
--     guess of one and chose a plan built for one row. The index was carrying
--     statistics, and the 40-row table it sat on was always going to be
--     sequentially scanned either way.
--
--     Which means the correct object is not an index. `CREATE STATISTICS ... ON
--     lower(city)` produces exactly the same estimate and exactly the same
--     plan, and there is no index to keep current on every venue write.
--     Measured: 23 buffers, identical to the functional-index plan.
--
--     So cross-venue search had no index problem. It had a statistics problem,
--     and both city indexes go.
DROP INDEX IF EXISTS venues_city_idx;

-- (6) The statistic that the deleted index was accidentally providing.
--
--     Not expressible in Drizzle's DSL, so it lives here with the exclusion
--     constraint and the generated column — see migrations/README.md. `ANALYZE`
--     must run for it to be populated; the seed already ends with one, and
--     autovacuum handles it thereafter.
CREATE STATISTICS IF NOT EXISTS venues_city_lower_stats ON lower(city) FROM venues;
ANALYZE venues;
