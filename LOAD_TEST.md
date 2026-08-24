# LOAD_TEST.md

Benchmark of the four endpoints the brief names, against the `full` seed
profile, through the load balancer, on the machine specified below.

**Headline: three of four targets met. Create-hold missed its 250 ms p95 by
2.1×, and the cause is measured rather than guessed — the box is CPU-saturated
at the offered load, and the same endpoint answers in 47 ms p95 when it is not.
[The whole diagnosis is below](#why-create-hold-misses), including the two
experiments that ruled out the database and the connection pool.**

Everything here is reproducible from this repository. Commands are given in
full, the scripts pick their own parameters, and the raw output of every run is
committed under `tests/load/artifacts/`.

---

## 1. How to reproduce

```bash
docker compose up --build -d
```

Seed the full profile — 250,000 bookings, 800 rooms, 40 venues, 24 months.
Takes about five minutes:

```bash
docker exec atrium-api1 node dist/db/seed.js --profile=full
```

Capture the query plans:

```bash
sh tests/load/explain/ab.sh tests/load/artifacts/explain-after.txt
```

Run the benchmark:

```bash
docker run --rm -i --network=atrium_atrium -e ATRIUM_BASE_URL=http://nginx:8080 -v "$PWD/tests/load/scripts:/scripts" grafana/k6 run /scripts/atrium.js
```

On Windows under Git Bash, prefix that with `MSYS_NO_PATHCONV=1` and give the
volume an absolute drive path — Git Bash rewrites `/scripts` into a Windows path
before Docker sees it, and k6 then reports the script as missing.

Two variants, used in section 5 and not part of the headline:

```bash
docker run --rm -i --network=atrium_atrium -e ATRIUM_BASE_URL=http://nginx:8080 -e ATRIUM_ONLY=hold -v "$PWD/tests/load/scripts:/scripts" grafana/k6 run /scripts/atrium.js
```

```bash
docker run --rm -i --network=atrium_atrium -e ATRIUM_BASE_URL=http://nginx:8080 -e ATRIUM_READ_VUS=5 -v "$PWD/tests/load/scripts:/scripts" grafana/k6 run /scripts/atrium.js
```

### Two things about re-running

**Each run leaves 301 real holds behind**, alive for `HOLD_TTL_SECONDS` (480).
The setup window is deliberately three weeks wide across sixty rooms so
consecutive runs do not collide; at seven days and forty rooms the fourth
consecutive run found 50 free slots and refused to start. If you do see the hold
scenario reporting 409s, that is the previous run's bookings, and it is correct
behaviour — wait eight minutes or re-seed.

**k6 runs on the same machine as the stack.** It took 47% of a core during the
headline run. On a box this size that is not negligible, and it is part of why
the numbers are what they are. Running k6 from another machine would improve
them; it would also stop the run being reproducible from one `docker compose
up`, so it is not what is reported here.

---

## 2. Machine and configuration

| | |
| --- | --- |
| CPU | Intel Core i5-8365U @ 1.60 GHz — 4 cores, 8 threads |
| RAM | 16 GB |
| OS | Windows 10 Pro 19045 |
| Container runtime | Docker Desktop, server 29.1.3, WSL2 backend, overlayfs |
| Available to Docker | 8 vCPUs, 7.66 GiB |
| Postgres | 16.13 (postgres:16-alpine), `shared_buffers=256MB`, `max_connections=200` |
| Node | 26 (node:26-alpine) |
| Topology | nginx :8080 round-robin over api1/api2/api3, one Postgres, paygate, web |
| Pool | `PG_POOL_MAX=20` per replica (60 connections total) |

This is a four-core 1.6 GHz laptop CPU running Postgres, **three** Node
replicas, nginx, the payment provider, the web container and the load generator
at once. That matters for reading section 5 and it is stated here rather than
left to be inferred from a disappointing number.

## 3. Fixture

`--profile=full`, verified by counting the tables rather than trusting the
seed's own summary — P5 caught the demo profile advertising 25,000 bookings and
delivering 14,138, so the seed now counts from Postgres and prints a SHORTFALL
block if the two disagree.

| table | rows |
| --- | --- |
| bookings | 250,000 |
| rooms | 800 |
| venues | 40 |
| users | 5,000 |
| booking_line_items | 87,349 |
| payments | 207,519 |

Span 2025-02-24 to 2027-02-24 — 24 months, evenly distributed at roughly 10,400
bookings a month. **The distribution is the part worth checking**, and it was
wrong until this phase: the seed walked each room's calendar from the start of
the range and stopped at its target, which packed every room's whole allocation
into the oldest months. It delivered a correct 250,000 rows spread 21,000 in the
first month and 52 in the last.

Availability, cross-venue search and create-hold all query the *future*, and the
future was the empty end. Every p95 below would have been measured against a
region of the table with almost nothing in it — fast, reproducible and
meaningless. Fixed in `fix(seed): spread bookings across the whole calendar`.

---

## 4. Results

Headline run: all four scenarios concurrently for 60 s — 10 VUs on availability,
10 on search, 5 on the revenue report, and holds at a constant 5/s. 20,485
requests, 332.7 req/s, **0 errors**, 301 of 301 holds created and zero 409s.

Raw output: [`tests/load/artifacts/k6-mixed.txt`](tests/load/artifacts/k6-mixed.txt)

| endpoint | p50 | p95 | p99 | max | target (p95) | verdict |
| --- | --- | --- | --- | --- | --- | --- |
| Room availability, 7-day range | 60.6 ms | **198.2 ms** | 298.8 ms | 1.12 s | < 300 ms | **PASS** — 34% headroom |
| Cross-venue search, combined filters | 44.4 ms | **147.3 ms** | 223.3 ms | 1.10 s | < 500 ms | **PASS** — 71% headroom |
| Create hold | 161.5 ms | **536.4 ms** | 676.9 ms | 1.32 s | < 250 ms | **FAIL** — over by 286 ms (2.1×) |
| Venue revenue report, 30 days | 72.1 ms | **219.9 ms** | 342.5 ms | 1.00 s | < 800 ms | **PASS** — 73% headroom |

Error rate 0.00% across all four (0 of 20,485). Every 409 in the hold scenario
is counted separately from the error rate: a 409 is the correct answer to a
contended slot, and a benchmark that scores it as a failure is measuring the
wrong thing. This run recorded none.

"Search, combined filters" means all of them at once — city, minimum capacity,
an amenity containment, a price ceiling and an availability window — with the
page number varying so paging is exercised rather than the first page cached.

---

## 5. Why create-hold misses

The number is 536 ms against a 250 ms target. What follows is what was measured,
in the order it was measured, because the first two hypotheses were wrong and
the elimination is the argument.

### The endpoint is not slow

Same script, same fixture, same 5 holds/s — with the three read scenarios
switched off:

| | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- |
| hold, in isolation | 31.2 ms | **47.4 ms** | 66.2 ms | 108.3 ms |
| hold, under the headline load | 161.5 ms | **536.4 ms** | 676.9 ms | 1.32 s |

Raw: [`k6-hold-isolated.txt`](tests/load/artifacts/k6-hold-isolated.txt)

47 ms p95, comfortably inside the target, with 301 of 301 created and no errors.
The hold transaction — advisory lock, in-transaction expiry of stale holds,
insert against the gist exclusion constraint, one audit row — costs about 30 ms
at 250,000 rows. It is **starved, not slow**, and that is a different fix.

### It is not the database

The query plans in section 6 are all sub-5 ms at this volume, and Postgres never
became the constraint:

```
NAME                CPU %     MEM USAGE / LIMIT
atrium-postgres-1   178.02%   524.3MiB / 7.66GiB
atrium-api3          98.39%    93.9MiB / 7.66GiB
atrium-api2          97.83%    76.0MiB / 7.66GiB
atrium-api1          92.62%    95.2MiB / 7.66GiB
atrium-lb            18.21%    22.6MiB / 7.66GiB
k6                   46.59%    96.6MiB / 7.66GiB
```

Sampled mid-run. Postgres at 178% is using under two of eight vCPUs. **Each of
the three Node replicas is pinned at ~95–98%, which is the ceiling for one
replica** — Node runs one JavaScript thread, so 100% of a core is the whole
budget. Requests queue in the event loop, and the heaviest request — the hold,
with the most round trips inside one transaction — waits behind the cheapest.

### It is not the connection pool

The obvious next guess. `PG_POOL_MAX` raised from 20 to 40 per replica, 60
connections to 120, same run:

| | throughput | hold p95 |
| --- | --- | --- |
| pool 20 (default) | 342 req/s | 540 ms |
| pool 40 | **265 req/s** | **634 ms** |

Both got *worse*. More connections against an already CPU-saturated box adds
Postgres backend scheduling and takes CPU away from the replicas. The pool was
never the constraint; this experiment exists so that is a measurement rather
than an assumption, and the setting was reverted.

### What it actually is: the box is saturated well below the offered load

Turning read concurrency down, everything else identical:

| read VUs | throughput | hold p50 | hold p95 | availability p95 | search p95 | revenue p95 |
| --- | --- | --- | --- | --- | --- | --- |
| 0 (holds only) | 5.8 req/s | 31.2 ms | **47.4 ms** ✅ | — | — | — |
| 2 | 322.9 req/s | 38.4 ms | **76.4 ms** ✅ | 30.0 ms | 20.9 ms | 39.8 ms |
| 5 | 345.2 req/s | 90.9 ms | **200.1 ms** ✅ | 78.4 ms | 58.0 ms | 94.0 ms |
| 10 (headline) | 332.7 req/s | 161.5 ms | **536.4 ms** ❌ | 198.2 ms | 147.3 ms | 219.9 ms |

Raw: [`k6-readvus-2.txt`](tests/load/artifacts/k6-readvus-2.txt),
[`k6-readvus-5.txt`](tests/load/artifacts/k6-readvus-5.txt)

Read that column pair together. **Throughput is flat from 2 read VUs onward** —
323, 345, 333 req/s while concurrency rises fivefold — and every latency grows
roughly linearly with offered load. That is the textbook signature of a
saturated server: past the knee, additional concurrency buys queueing and
nothing else. The knee is at about **340 req/s**, and it is the machine's, not
the code's.

Create-hold meets its target at 5 read VUs (200 ms) and misses at 10 (536 ms).
Every other endpoint stays inside its target throughout, which is why hold is
the only one that fails — not because it is the badly written one, but because
its target is the tightest and it is the heaviest request.

### What I would do next, in order

1. **Give it more cores.** This is the honest first answer and the cheapest to
   verify. Three Node processes cannot use more than three of eight vCPUs, and
   two of those are already going to Postgres and k6. The correctness strategy
   is deliberately in the database precisely so replicas scale horizontally
   (`CLAUDE.md`, "Both mechanisms are enforced by PostgreSQL"); this is the
   workload that wants that. I would expect a 4-core box per replica to put hold
   under 250 ms at this load, and I would rather say "expect" than pretend I
   measured it — I have one laptop.

2. **Take the availability enumeration off the request path.** It is the
   largest single load on the Node processes, and this part is measured rather
   than assumed: one availability response for a 7-day range is **9.7 KB** and
   119 enumerated slots, and at 7,538 requests that is **73 MB of the run's
   86 MB** — 85% of everything the stack serialised. The query behind it is
   1.2 ms; the rest is `enumerate()` walking a 7-day calendar on a 30-minute
   grid in JavaScript and then serialising the result.

   Cheapest real win available, and it touches no invariant: availability is
   explicitly advisory and the hold path never consults it, so caching it,
   paginating it, or returning busy intervals and letting the client enumerate
   are all open. I would take the last one — it moves the loop to where there is
   idle CPU and shrinks the response by an order of magnitude.

3. **Cut round trips inside the hold transaction.** It currently issues the
   advisory lock, the stale-hold expiry, the insert and the audit row as separate
   statements. Folding the lock and the expiry into one statement removes two
   round trips from the critical section, which is where every millisecond is
   also a millisecond of held advisory lock. Worth about 10–15 ms of the 30 ms
   isolated cost — small in absolute terms, but it shortens the lock hold, which
   matters more than the latency under contention.

4. **Only then look at the sweep line.** It is 3.8 ms today and not implicated
   in this failure — but see ARCHITECTURE.md §8, because it is the thing that
   breaks first at 100×, and it breaks inside this same transaction.

What I deliberately did **not** do is re-run the hold scenario alone and report
47 ms as the result. It is in section 5 as a diagnostic, and the mixed run stays
the headline.

### The decision taken

**The miss is accepted and published rather than optimised away**, and step 2
above is scheduled for P7 alongside the console rather than done here. The
reasoning, including what it costs and what would reverse it, is
`DECISIONS.md` entry 12.

The short version: step 2 is a change to the console's data contract — the
client becomes responsible for enumerating slots — and choosing that shape
before the console exists means designing for a consumer nobody has written.
Step 1 needs hardware I do not have. So the honest deliverable from this phase
is the measurement and the elimination, not a better number.

One consequence worth stating plainly: the k6 thresholds are written to **fail
the run** on a missed target rather than warn. Re-running this benchmark on
comparable hardware produces a red build, on purpose. A target that does not
fail is not a target, and a benchmark tuned until it goes green is not evidence.

---

## 6. Query plans, before and after indexing

Captured with `EXPLAIN (ANALYZE, BUFFERS)` against the full profile, three warm
passes each, keeping the third. Buffer counts are the primary signal — wall
clock on a laptop under Docker Desktop is too noisy to decide on, and the first
pass of any capture measures the buffer cache rather than the index.

Full transcripts:
[`explain-before.txt`](tests/load/artifacts/explain-before.txt) ·
[`explain-after.txt`](tests/load/artifacts/explain-after.txt) ·
[`explain-candidates.txt`](tests/load/artifacts/explain-candidates.txt) (all
candidates present, including the two that were rejected).

The capture script is [`tests/load/explain/plans.sql`](tests/load/explain/plans.sql).
It picks its own parameters — the busiest room in the next seven days, the venue
with the most bookings in the last thirty, a window anchored on a real future
booking — so a reviewer gets a comparable plan without hunting for ids. Two
things it got wrong first, both fixed and both worth knowing:

- The first version wrote `freeRoomIds` as a correlated subquery. The real code
  passes a literal array, and the two produce completely different plans. A
  benchmark whose query is not the query is not a benchmark.
- The first version aimed at `now() + 2 days` and hit a window every venue in
  the city was closed for, producing a zero-row plan. Measuring the cost of
  proving a range empty is the cheap case, not the one a p95 is about.

### Summary

| | query | before | after | change |
| --- | --- | --- | --- | --- |
| Q1 | availability, 7-day range | 28 buf / 1.47 ms | 28 buf / 1.23 ms | **no change — no index added** |
| Q2 | search, combined filters | 250 buf / 1.69 ms | 23 buf / 1.19 ms | statistics, not an index |
| Q3 | search, free-room filter | 247 buf / 3.95 ms | 48 buf / 0.69 ms | `bookings_active_slot_idx` |
| Q4 | hold: expire stale holds | `bookings_status_expires_idx` | `bookings_room_held_expiry_idx` | 62 buf → 8 buf |
| Q5 | hold: equipment sweep line | 2267 buf / 3.81 ms | 2272 buf / 3.07 ms | **no change — candidate rejected** |
| Q6 | revenue: totals | 189 buf / 3.37 ms | 29 buf / 0.66 ms | `bookings_venue_starts_idx` |
| Q7 | revenue: refunds | 1371 buf / 17.20 ms | 1211 buf / 4.28 ms | `bookings_venue_starts_idx` |
| Q8 | revenue: per room | 209 buf / 5.01 ms | 49 buf / 1.65 ms | `bookings_venue_starts_idx` |
| Q9 | revenue: per day | 189 buf / 4.36 ms | 29 buf / 1.46 ms | `bookings_venue_starts_idx` |

### Q1 — room availability, 7-day range

`apps/api/src/rooms/availability.service.ts :: busyIntervals`

```
BEFORE                                                    AFTER — identical
Sort                              (actual time=1.402 rows=6)
  Buffers: shared hit=28                                  Buffers: shared hit=28
  -> Index Scan using no_room_overlap on bookings         -> Index Scan using no_room_overlap
       (actual time=1.371..1.375 rows=6)
Execution Time: 1.468 ms                                  Execution Time: 1.232 ms
```

**No index was added for this query, because none was justified.** The exclusion
constraint's own gist index on `(room_id, slot)` is exactly the right shape for
a single-room time-range lookup: `room_id =` on the leading key and `slot &&` on
the second. 28 buffers to return 6 rows out of 250,000. The 0.24 ms difference
is noise between two warm passes.

Worth stating plainly, because it is the pleasant case: INV-1's correctness
mechanism is also the availability endpoint's index. One object, two jobs.

### Q2 — cross-venue search, combined filters

`apps/api/src/search/search.service.ts :: page`

```
BEFORE                                                    AFTER
Limit  (actual time=1.443 rows=52)                        Limit  (actual time=1.012 rows=52)
  Buffers: shared hit=250                                   Buffers: shared hit=23
  -> Nested Loop  (rows=4 est / 52 actual)                  -> Hash Join  (rows=62 est / 52 actual)
     -> Seq Scan on venues v  (rows=1 est / 14 actual)         -> Seq Scan on rooms r  (rows=178/180)
     -> Bitmap Heap Scan on rooms r  (loops=14)               -> Seq Scan on venues v  (rows=14/14)
        Heap Blocks: exact=233
        Buffers: shared hit=247
Execution Time: 1.687 ms                                  Execution Time: 1.186 ms
```

**This is the finding I did not expect, and it is the one worth reading.**

The obvious repair was a functional index on `lower(city)` — the query filters
case-insensitively and the existing `venues_city_idx` on plain `city` cannot
answer that, which is why it recorded **zero scans** across the entire
benchmark. Building the functional index moved the plan hard: 253 buffers to 23,
nested loop to hash join.

Its own `idx_scan` stayed at **zero**. It was never used as an index.

What it changed was the *estimate*. Postgres collects statistics on indexed
expressions, so with the index present the planner knew `lower(city) =
'karachi'` matches fourteen venues; without it, it fell back to a default guess
of one row and chose a plan built for one row — nest-looping into `rooms`
fourteen times, 233 heap blocks. The index was carrying statistics, and the
40-row table it sat on was always going to be sequentially scanned either way.

So the right object is not an index at all:

```sql
CREATE STATISTICS venues_city_lower_stats ON lower(city) FROM venues;
```

Identical plan, identical 23 buffers, nothing to maintain on every venue write.
Cross-venue search had a **statistics problem, not an index problem**. Both city
indexes are dropped in migration `0007`; the statistic ships in their place.

### Q3 — search: which candidates are free in the window

`apps/api/src/rooms/availability.service.ts :: freeRoomIds`

```
BEFORE                                                    AFTER
Unique  (actual time=3.773 rows=29)                       Unique  (actual time=0.499 rows=29)
  Buffers: shared hit=247                                   Buffers: shared hit=48
  -> Bitmap Heap Scan on bookings b                         -> Bitmap Heap Scan on bookings b
       Heap Blocks: exact=45                                     Heap Blocks: exact=45
     -> Bitmap Index Scan on no_room_overlap                   -> Bitmap Index Scan on bookings_active_slot_idx
          Index Cond: (slot && tstzrange(...))                      Index Cond: (slot && tstzrange(...))
          Buffers: shared hit=202     <-- 202 buffers            Buffers: shared hit=3     <-- 3 buffers
Execution Time: 3.954 ms                                  Execution Time: 0.687 ms
```

Search holds a **list** of candidate room ids, not one. The planner therefore
cannot use `room_id` as a leading key on the `(room_id, slot)` gist index, so it
drives that index on `slot &&` alone and applies room membership as a filter.
Descending a `(room_id, slot)` gist for a time range with no room key means
touching subtrees for every room in the table: **202 buffers inside the index
scan** to produce 45 rows.

A gist on `slot` by itself, partial on the same three active statuses, is the
index this query actually wants — 3 buffers. It is 3.4 MB against the constraint
index's 5.9 MB and it does not duplicate it: Q1 still uses `no_room_overlap`,
where the composite is already optimal and this one is not chosen.

The 202 → 3 collapse is the change that matters more than the milliseconds,
because 202 was a function of the platform's total booking count and 3 is not.

### Q4 — create hold: expire stale holds in-transaction

`apps/api/src/bookings/booking-state-machine.service.ts :: expireStaleHoldsForRoom`

```
BEFORE                                        AFTER
Update on bookings                            Update on bookings
  -> Index Scan using                           -> Index Scan using
     bookings_status_expires_idx                   bookings_room_held_expiry_idx
     Index Cond: (status='HELD'                    Index Cond: (room_id = $1
                  AND expires_at < now())                       AND expires_at < now())
     Filter: (room_id = $1)                        Filter: (status = 'HELD')
```

**This one could not be evaluated at all on the seeded data**, and that is the
point worth recording. The seed writes no HELD rows on purpose — a seeded hold
would expire the instant the seed finished — so the partial index is empty, the
planner ignores it, and the first capture showed no change. An empty index being
unused is not evidence that the index is useless.

Re-measured with 5,000 stale holds synthesised in a rolled-back transaction, the
difference is the *shape* of the scan rather than a constant factor:

```
without:  Bitmap Heap Scan (rows=4)                       Buffers: shared hit=64
            BitmapAnd
              Bitmap Index Scan on bookings_status_expires_idx
                (actual rows=10000)   <-- every expired hold ON THE PLATFORM
              Bitmap Index Scan on bookings_room_starts_idx  (rows=214)

with:     Index Scan using bookings_room_held_expiry_idx    Buffers: shared hit=8
            Index Cond: (room_id = $1 AND expires_at < now())   (actual rows=4)
```

62 buffers of bitmap work becomes 8. More importantly, the cost of the first
version grows with how many stale holds the **whole platform** is carrying,
while the second grows with this one room's. This statement runs inside the hold
transaction, holding the per-room advisory lock, on every single hold request. It
is the last place in the system a platform-wide scan belongs.

### Q5 — create hold: equipment sweep line

`apps/api/src/bookings/equipment-availability.ts :: peakConcurrentUsage`

```
BEFORE                                                    AFTER — unchanged
GroupAggregate                    (actual time=3.411)     GroupAggregate  (actual time=2.714)
  Buffers: shared hit=2267                                  Buffers: shared hit=2272
  -> Nested Loop                                            -> Nested Loop
     -> Bitmap Heap Scan on booking_line_items li              (same)
          rows=563   Buffers: shared hit=12
     -> Index Scan using bookings_pkey on bookings b
          loops=563                                           loops=563
          Rows Removed by Filter: 1
          Buffers: shared hit=2252
Execution Time: 3.814 ms                                  Execution Time: 3.070 ms
```

**A candidate was built for this, measured, and deleted.** Recording that is
worth as much as recording the three that stayed.

The plan's problem is visible: 563 primary-key lookups into `bookings`, 2,252
buffers, to find the **one** row that overlaps the requested window. The entry
point is `booking_line_items.equipment_type_id`, so every line item that type
has ever had is fetched and then filtered on time in the loop. A covering index
should fix exactly that:

```sql
CREATE INDEX bookings_id_window_idx ON bookings (id)
  INCLUDE (starts_at, ends_at, status, expires_at);
```

It worked, in the sense that the planner adopted it — `Index Only Scan using
bookings_id_window_idx`, heap fetches eliminated, 2,267 buffers down to 1,849.

And it bought no time whatsoever. Five runs each, median **2.75 ms without** the
index against **3.75 ms with** it. The 18% of buffers it saved were pages
already resident in `shared_buffers`, so avoiding them saved a pointer chase and
nothing more, while the index-only scan added its own visibility-map checks.

Against that: 16 MB of index, maintained on **every booking insert** — which
includes every hold, inside the hold transaction, on the endpoint that is
already the one missing its target. Deleted. The right fix for this query is not
an index (see ARCHITECTURE.md §8).

### Q6–Q9 — venue revenue report, 30 days

`apps/api/src/reports/reports.service.ts`

All four queries filter `(venue_id, starts_at range)`. Q6 is representative:

```
BEFORE                                                    AFTER
Aggregate  (actual time=3.155 rows=1)                     Aggregate  (actual time=0.503 rows=1)
  Buffers: shared hit=189                                   Buffers: shared hit=29
  -> Bitmap Heap Scan on bookings b  (rows=308)             -> Bitmap Heap Scan on bookings b (rows=308)
       Rows Removed by Filter: 6956    <-- 96% waste             Heap Blocks: exact=25
       Heap Blocks: exact=182                                    (no filter — the index answers it)
     -> Bitmap Index Scan on bookings_venue_idx                -> Bitmap Index Scan on bookings_venue_starts_idx
          (actual rows=7264)                                        (actual rows=308)
Execution Time: 3.373 ms                                  Execution Time: 0.664 ms
```

The single-column `venue_id` index fetched **all 7,264 bookings this venue has
ever had** and discarded 6,956 of them to the date predicate. The composite
turns that into a tight range: 308 rows in, 308 out, 189 buffers to 29.

The important property is not the 5× — it is that the old cost grew with the
venue's *lifetime* booking count while the new one grows with the *reporting
window*. A venue with five years of history and a 30-day report paid for the
five years.

`bookings_venue_idx` is dropped: the composite is a strict superset of what it
served, so keeping both means a second index to maintain on every booking write
for no read benefit.

Q7 (refunds) improves less — 1371 to 1211 buffers, 17.2 ms to 4.3 ms — because
its cost is dominated by 308 index lookups into `payments`, not by the scan of
`bookings`. It also stopped going parallel, which is the larger part of the
17 ms → 4 ms: the before plan launched two workers to scan 7,264 rows and paid
more in coordination than it saved.

---

## 7. Concurrency proof at this volume

The brief's 200-request proof was previously only run against the demo profile.
250,000 rows is a different contention profile from 25,000 and that is exactly
the claim, so it was re-run here. Three consecutive runs, all clean:

```
=== 3 consecutive proof runs against the full profile (250,000 bookings) ===
run 1:  Tests 5 passed | 201 x1, 409 x199 | admitted 3 (ceiling 3) | 5xx 0 | api1=135 api2=132 api3=133
run 2:  Tests 5 passed | 201 x1, 409 x199 | admitted 3 (ceiling 3) | 5xx 0 | api1=132 api2=135 api3=133
run 3:  Tests 5 passed | 201 x1, 409 x199 | admitted 3 (ceiling 3) | 5xx 0 | api1=135 api2=132 api3=133
```

INV-1 admits exactly one of 200 concurrent holds for the same room and slot;
INV-2 admits exactly 3 of 200 against an equipment type owning 3 units; no 5xx
anywhere; requests spread evenly across all three replicas. Re-read from
Postgres afterwards, not asserted from HTTP responses alone.

Raw: [`proof-full-profile.txt`](tests/load/artifacts/proof-full-profile.txt) ·
[`proof-full-profile-repeat.txt`](tests/load/artifacts/proof-full-profile-repeat.txt)

---

## 8. What this benchmark does not cover

- **One machine.** Every number is from a single 4-core laptop with the load
  generator co-resident. The saturation analysis in section 5 is sound on this
  box and untested on any other.
- **60-second runs.** Long enough for 20,000 requests and a stable p95, too
  short to show anything about connection churn, autovacuum under sustained
  write load, or index bloat.
- **No sustained write load.** 5 holds/s for a minute is 300 rows against a
  250,000-row table. Nothing here says what the exclusion constraint's gist
  index costs to maintain at a realistic booking rate over days.
- **The deployed instance is not benchmarked.** Render's free tier sleeps after
  fifteen idle minutes and shares a CPU; numbers from it would measure the tier,
  not the system. The deployment is verified for correctness (README) and
  measured here locally, and the two are not conflated.
- **`GET /bookings` and the reconciliation endpoint are not benchmarked.** The
  brief names four endpoints and these are not among them. Reconciliation scans
  the whole payments table twice by design and would be the slowest endpoint in
  the system; it is admin-only and correctness there is worth more than latency.
