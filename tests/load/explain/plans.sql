-- ---------------------------------------------------------------------------
-- Atrium — query plans for the four benchmarked endpoints.
--
-- Run against the FULL profile (250,000 bookings / 800 rooms / 24 months):
--
--   docker exec -i atrium-postgres-1 psql -U atrium -d atrium -X -f - \
--     < tests/load/explain/plans.sql
--
-- The script picks its own parameters — the busiest room in the next seven
-- days, and the venue with the most bookings in the last thirty — so a reviewer
-- re-running it gets a comparable plan without having to find ids by hand. A
-- benchmark whose parameters are pasted in by whoever ran it last is a
-- benchmark nobody can reproduce.
--
-- Every statement below is the query the API actually issues, copied from the
-- service that issues it and annotated with where. If one of these drifts from
-- its source the plan stops meaning anything, so the reference is part of the
-- statement rather than a note beside it.
-- ---------------------------------------------------------------------------

\timing off
\pset pager off

-- --------------------------------------------------------------------------
-- Parameters
-- --------------------------------------------------------------------------

SELECT b.room_id AS room_id
  FROM bookings b
 WHERE b.starts_at >= now()
   AND b.starts_at <  now() + interval '7 days'
 GROUP BY b.room_id
 ORDER BY count(*) DESC, b.room_id
 LIMIT 1
\gset

SELECT venue_id AS venue_id
  FROM bookings
 WHERE starts_at >= now() - interval '30 days'
   AND starts_at <  now()
 GROUP BY venue_id
 ORDER BY count(*) DESC, venue_id
 LIMIT 1
\gset

SELECT v.timezone AS venue_tz, v.city AS venue_city
  FROM venues v WHERE v.id = :'venue_id'
\gset

-- The candidate room ids as a literal array. `freeRoomIds` receives an ARRAY of
-- ids from the search service and issues `room_id IN (...)` over literals, not a
-- subquery. The distinction changes the plan completely — with literals the
-- planner can drive the gist index per room, with a subquery it cannot — so the
-- ids are materialised here rather than left as a correlated SELECT.
SELECT '{' || string_agg(id::text, ',') || '}' AS candidate_rooms
  FROM (
    SELECT r.id
      FROM rooms r JOIN venues v ON v.id = r.venue_id
     WHERE lower(v.city) = lower(:'venue_city') AND r.capacity >= 8
     ORDER BY r.hourly_rate_minor, r.id
     LIMIT 2000
  ) t
\gset

SELECT li.equipment_type_id AS equipment_type_id
  FROM booking_line_items li
  JOIN bookings b ON b.id = li.booking_id
 WHERE b.starts_at >= now() AND b.starts_at < now() + interval '30 days'
 GROUP BY li.equipment_type_id
 ORDER BY count(*) DESC, li.equipment_type_id
 LIMIT 1
\gset

-- A window that actually contains bookings, anchored on a real future one.
--
-- Picking `now() + 2 days` and hoping produced a window every venue in the city
-- was closed for, and a plan that returned zero rows. A zero-row plan is not a
-- benchmark: it measures the cost of proving a range empty, which is the cheap
-- case and not the one the p95 is about.
SELECT to_char(b.starts_at, 'YYYY-MM-DD"T"HH24:MI:SSOF:00') AS window_from,
       to_char(b.starts_at + interval '2 hours', 'YYYY-MM-DD"T"HH24:MI:SSOF:00') AS window_to
  FROM bookings b
 WHERE b.starts_at > now() + interval '1 day'
   AND b.status IN ('HELD','PENDING_PAYMENT','CONFIRMED')
 ORDER BY b.starts_at, b.id
 LIMIT 1
\gset

\echo '==========================================================================='
\echo 'PARAMETERS'
\echo '==========================================================================='
SELECT :'room_id' AS room_id, :'venue_id' AS venue_id,
       :'venue_city' AS city, :'venue_tz' AS timezone,
       :'equipment_type_id' AS equipment_type_id;

SELECT :'window_from' AS window_from, :'window_to' AS window_to,
       array_length(:'candidate_rooms'::uuid[], 1) AS candidate_rooms;

SELECT count(*) AS bookings, count(DISTINCT room_id) AS rooms,
       min(starts_at)::date AS first_day, max(starts_at)::date AS last_day
  FROM bookings;

\echo ''
\echo '==========================================================================='
\echo 'Q1  room availability, 7 day range'
\echo '    apps/api/src/rooms/availability.service.ts :: busyIntervals'
\echo '==========================================================================='

EXPLAIN (ANALYZE, BUFFERS, VERBOSE OFF)
SELECT lower(slot) AS lower, upper(slot) AS upper
  FROM bookings
 WHERE room_id = :'room_id'::uuid
   AND status IN ('HELD','PENDING_PAYMENT','CONFIRMED')
   AND NOT (status = 'HELD' AND expires_at IS NOT NULL AND expires_at <= now())
   AND slot && tstzrange(now(), now() + interval '7 days', '[)')
 ORDER BY lower(slot);

\echo ''
\echo '==========================================================================='
\echo 'Q2  cross-venue search, combined filters — candidate page'
\echo '    apps/api/src/search/search.service.ts :: page'
\echo '==========================================================================='

EXPLAIN (ANALYZE, BUFFERS, VERBOSE OFF)
SELECT r.id, r.name, r.capacity, r.amenities, r.hourly_rate_minor,
       r.min_duration_minutes, r.max_duration_minutes,
       v.id AS venue_id, v.name AS venue_name, v.city, v.timezone
  FROM rooms r
  JOIN venues v ON v.id = r.venue_id
 WHERE lower(v.city) = lower(:'venue_city')
   AND r.capacity >= 8
   AND r.hourly_rate_minor <= 900000
   AND r.amenities @> ARRAY['wifi']::text[]
 ORDER BY r.hourly_rate_minor ASC, r.id ASC
 LIMIT 2000 OFFSET 0;

\echo ''
\echo '==========================================================================='
\echo 'Q3  cross-venue search — which candidates are free in the window'
\echo '    apps/api/src/rooms/availability.service.ts :: freeRoomIds'
\echo '==========================================================================='

EXPLAIN (ANALYZE, BUFFERS, VERBOSE OFF)
SELECT DISTINCT b.room_id
  FROM bookings b
 WHERE b.room_id = ANY(:'candidate_rooms'::uuid[])
   AND b.status IN ('HELD','PENDING_PAYMENT','CONFIRMED')
   AND NOT (b.status = 'HELD' AND b.expires_at IS NOT NULL AND b.expires_at <= now())
   AND b.slot && tstzrange(:'window_from'::timestamptz,
                           :'window_to'::timestamptz + interval '15 minutes', '[)');

\echo ''
\echo '==========================================================================='
\echo 'Q4  create hold — in-transaction expiry of stale holds for this room'
\echo '    apps/api/src/bookings/booking-state-machine.service.ts'
\echo '    :: expireStaleHoldsForRoom  (EXPLAIN only; the UPDATE is not executed)'
\echo '==========================================================================='

EXPLAIN (VERBOSE OFF)
UPDATE bookings SET status = 'EXPIRED', updated_at = now()
 WHERE room_id = :'room_id'::uuid
   AND status = 'HELD'
   AND expires_at < now();

\echo ''
\echo '==========================================================================='
\echo 'Q5  create hold — equipment sweep line, peak concurrent usage'
\echo '    apps/api/src/bookings/equipment-availability.ts :: peakConcurrentUsage'
\echo '==========================================================================='

EXPLAIN (ANALYZE, BUFFERS, VERBOSE OFF)
WITH req AS (
  SELECT :'window_from'::timestamptz AS s,
         :'window_to'::timestamptz   AS e
),
overlapping AS (
  SELECT li.equipment_type_id,
         GREATEST(b.starts_at, req.s) AS window_start,
         LEAST(b.ends_at, req.e)      AS window_end,
         li.quantity
    FROM booking_line_items li
    JOIN bookings b ON b.id = li.booking_id
    CROSS JOIN req
   WHERE li.equipment_type_id = ANY(ARRAY[:'equipment_type_id']::uuid[])
     AND b.status IN ('HELD','PENDING_PAYMENT','CONFIRMED')
     AND NOT (b.status = 'HELD' AND b.expires_at IS NOT NULL AND b.expires_at <= now())
     AND b.starts_at < req.e
     AND b.ends_at   > req.s
),
events AS (
  SELECT equipment_type_id, window_start AS at,  quantity AS delta, 1 AS tie_break FROM overlapping
  UNION ALL
  SELECT equipment_type_id, window_end   AS at, -quantity AS delta, 0 AS tie_break FROM overlapping
),
running AS (
  SELECT equipment_type_id,
         SUM(delta) OVER (PARTITION BY equipment_type_id ORDER BY at, tie_break
                          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS in_use
    FROM events
)
SELECT equipment_type_id, COALESCE(MAX(in_use), 0)::int AS peak
  FROM running GROUP BY equipment_type_id;

\echo ''
\echo '==========================================================================='
\echo 'Q6  venue revenue report, 30 days — totals'
\echo '    apps/api/src/reports/reports.service.ts :: totals'
\echo '==========================================================================='

EXPLAIN (ANALYZE, BUFFERS, VERBOSE OFF)
SELECT
  count(*)::int AS bookings,
  count(*) FILTER (WHERE b.status = 'CONFIRMED')::int AS confirmed,
  count(*) FILTER (WHERE b.status = 'COMPLETED')::int AS completed,
  count(*) FILTER (WHERE b.status = 'CANCELLED')::int AS cancelled,
  count(*) FILTER (WHERE b.status = 'REFUNDED')::int  AS refunded,
  count(*) FILTER (WHERE b.status = 'EXPIRED')::int   AS expired,
  count(*) FILTER (WHERE b.status = 'FAILED')::int    AS failed,
  coalesce(sum(b.total_minor) FILTER (WHERE b.status IN ('CONFIRMED','COMPLETED')), 0)::text AS gross_minor,
  coalesce(sum(EXTRACT(epoch FROM (b.ends_at - b.starts_at)) / 60)
           FILTER (WHERE b.status IN ('CONFIRMED','COMPLETED')), 0)::int AS booked_minutes,
  min(b.currency)::text AS currency
  FROM bookings b
 WHERE b.venue_id = :'venue_id'::uuid
   AND b.starts_at >= now() - interval '30 days'
   AND b.starts_at <  now();

\echo ''
\echo '==========================================================================='
\echo 'Q7  venue revenue report, 30 days — refunds'
\echo '    apps/api/src/reports/reports.service.ts :: refunded'
\echo '==========================================================================='

EXPLAIN (ANALYZE, BUFFERS, VERBOSE OFF)
SELECT coalesce(sum(p.refunded_minor), 0)::text AS refunded_minor
  FROM payments p
  JOIN bookings b ON b.id = p.booking_id
 WHERE b.venue_id = :'venue_id'::uuid
   AND b.starts_at >= now() - interval '30 days'
   AND b.starts_at <  now();

\echo ''
\echo '==========================================================================='
\echo 'Q8  venue revenue report, 30 days — per room'
\echo '    apps/api/src/reports/reports.service.ts :: byRoom'
\echo '==========================================================================='

EXPLAIN (ANALYZE, BUFFERS, VERBOSE OFF)
SELECT b.room_id, r.name AS room_name, count(*)::int AS bookings,
       coalesce(sum(EXTRACT(epoch FROM (b.ends_at - b.starts_at)) / 60)
                FILTER (WHERE b.status IN ('CONFIRMED','COMPLETED')), 0)::int AS booked_minutes,
       coalesce(sum(b.total_minor) FILTER (WHERE b.status IN ('CONFIRMED','COMPLETED')), 0)::text AS gross_minor
  FROM bookings b
  JOIN rooms r ON r.id = b.room_id
 WHERE b.venue_id = :'venue_id'::uuid
   AND b.starts_at >= now() - interval '30 days'
   AND b.starts_at <  now()
 GROUP BY b.room_id, r.name
 ORDER BY 5 DESC, b.room_id;

\echo ''
\echo '==========================================================================='
\echo 'Q9  venue revenue report, 30 days — per venue-local day'
\echo '    apps/api/src/reports/reports.service.ts :: byDay'
\echo '==========================================================================='

EXPLAIN (ANALYZE, BUFFERS, VERBOSE OFF)
SELECT to_char(date_trunc('day', b.starts_at AT TIME ZONE :'venue_tz'), 'YYYY-MM-DD') AS day,
       count(*)::int AS bookings,
       coalesce(sum(b.total_minor) FILTER (WHERE b.status IN ('CONFIRMED','COMPLETED')), 0)::text AS gross_minor
  FROM bookings b
 WHERE b.venue_id = :'venue_id'::uuid
   AND b.starts_at >= now() - interval '30 days'
   AND b.starts_at <  now()
 GROUP BY 1
 ORDER BY 1;

\echo ''
\echo '==========================================================================='
\echo 'INDEXES PRESENT AT CAPTURE TIME'
\echo '==========================================================================='

SELECT indexrelname AS index,
       pg_size_pretty(pg_relation_size(indexrelid)) AS size,
       idx_scan AS scans
  FROM pg_stat_user_indexes
 WHERE relname IN ('bookings','rooms','venues','payments','booking_line_items')
 ORDER BY relname, indexrelname;
