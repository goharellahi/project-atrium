# ARCHITECTURE.md

> **Status: first draft, written before any hold endpoint exists in this
> repository.** Only "Concurrency Strategy" and "Assumptions" are written. The
> remaining sections are stubs and are filled in as the phases in `PLAN.md`
> complete.
>
> This document is intended as a set of constraints the code is built to
> satisfy, not a description written afterwards of whatever came out. If the
> final implementation contradicts this draft, both versions stay in the file
> and the change is recorded with the reasoning — discovering mid-build that
> the first approach was wrong is a result worth showing, not one worth hiding.

---

## 1. Entity Relationship Diagram

*Stub — P1. Mermaid ERD covering Venue, Room, EquipmentType, User, Booking,
BookingLineItem, Payment, AuditEvent.*

---

## 2. Booking State Machine

*Stub — P4. Mermaid state diagram including every failure edge, not only the
happy path.*

---

## 3. Concurrency Strategy

Two kinds of inventory, two different problems, two different mechanisms.
Neither of them lives in application memory.

### Rooms — a PostgreSQL exclusion constraint

A room is a single physical space, so this is an interval exclusion problem,
and PostgreSQL has a native primitive for exactly that:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE bookings ADD CONSTRAINT no_room_overlap
  EXCLUDE USING gist (room_id WITH =, slot WITH &&)
  WHERE (status IN ('HELD','PENDING_PAYMENT','CONFIRMED'));
```

`btree_gist` is required because the constraint mixes an equality operator on a
scalar (`room_id WITH =`) with an overlap operator on a range (`slot WITH &&`);
a plain GiST index does not support equality on a UUID.

`slot` is a `tstzrange` that **already includes the 15-minute turnaround
buffer** — a 14:00–16:00 booking stores a slot ending at 16:15. So the
turnaround rule is enforced by the same constraint as the overlap rule,
atomically, rather than by a second application check that could disagree with
it. One rule, one place, no code path around it.

The partial `WHERE` clause is what makes the constraint usable: cancelled,
expired and failed bookings must not block the slot they used to occupy, and
without the predicate they would forever.

**Why this holds across three replicas.** The rule lives in the database, so
two transactions inserting overlapping slots do not race in application code at
all. The first to reach the constraint check acquires the index entry; the
second blocks until it commits, then fails with `23P01`
(`exclusion_violation`), which is translated to a clean 409. The number of API
processes is irrelevant because no API process is party to the decision.

Three alternatives, named and rejected:

**(a) Query-then-insert.** `SELECT` for conflicts, `INSERT` if none. Under READ
COMMITTED both racers run their `SELECT` before either has inserted, both see
an empty conflict set, both insert. The window is small, which is worse rather
than better: the bug never reproduces by hand and appears only under the load
the graders will apply.

**(b) An in-process mutex or semaphore.** Correct on one instance, meaningless
on three — each replica has its own lock, guarding nothing the other two
respect. Passes against a single container and fails the moment requests are
distributed, which is exactly why the brief mandates three replicas.

**(c) SERIALIZABLE isolation.** Genuinely correct: SSI would detect the
read-write dependency cycle between two racing holds and abort one. Rejected on
cost, not correctness. SSI signals conflicts by aborting with `40001`, which
the application must retry; at 200 concurrent requests contending the same
row the abort rate approaches the contention rate and capacity goes into retry
storms. The exclusion constraint gets the same guarantee from a blocking index
insertion, so the loser waits briefly and receives a deterministic failure
instead of a retryable one.

### Equipment — a row lock plus a max-concurrent-usage check

Equipment is a quantity over an interval, and an exclusion constraint cannot
express `sum <= N`. The mechanism has two parts, and both are required.

**(i) A row lock on the equipment type.**

```sql
SELECT id, owned_units, overbooking_buffer
  FROM equipment_types
 WHERE id = $1
   FOR UPDATE;
```

taken inside the hold transaction. A database row lock, not an application
lock, so it serialises admission decisions for that equipment type correctly
across all replicas: every transaction adding units of this type must hold this
row first, making the capacity check and the insert that follows it atomic with
respect to each other.

**(ii) A max-concurrent-usage check, not a naive SUM.**

This distinction is the substance of INV-2, and getting it wrong produces a
system that is *safe but wrong* — it never oversells, and it rejects bookings
it should have accepted.

The naive query is:

```sql
SELECT SUM(quantity) FROM booking_line_items bli
  JOIN bookings b ON b.id = bli.booking_id
 WHERE bli.equipment_type_id = $1 AND b.slot && $2;
```

It over-counts, because it adds together bookings that overlap the request but
do not overlap each other. Worked example:

- Capacity: **6** units.
- Booking A holds **3** units, 14:00–16:00.
- Booking B holds **3** units, 17:00–19:00.
- Request: **3** units, 15:00–18:00.

The request overlaps both A and B, so the naive sum is `3 + 3 = 6`, and
`6 + 3 = 9 > 6` rejects it. But A and B never overlap *each other*. At no
instant does concurrent usage exceed 3, so at every instant there are at least
3 free units and the request is perfectly valid. The naive query has answered a
question about totals; INV-2 asks a question about instants.

The correct computation is a sweep line over interval boundary events. Emit
`+qty` at each overlapping booking's start and `-qty` at its end, restricted to
the requested window; order the events by time; take a running
`SUM() OVER (ORDER BY event_time)`; the `MAX` of that running sum is the peak
concurrent usage inside the window. Admit the booking iff:

```
peak + requested_qty <= owned_units * (1 + overbooking_buffer)
```

On the worked example the events inside 15:00–18:00 are `+3` at the window
start (A already running), `-3` at 16:00, `+3` at 17:00. The running sum is
3, 0, 3, so peak is 3, and `3 + 3 <= 6` admits. Correct.

**Accepted cost.** Holds for a single equipment type serialise on that row: two
customers booking the same camera type at the same venue queue behind each
other even for non-overlapping windows. A real throughput limit, accepted
knowingly — the lock is held for one transaction containing one indexed
aggregate query, contention is scoped to a single equipment type at a single
venue rather than globally, and correctness here is worth more than
parallelism.

**Rejected alternative: model each physical unit as its own row.** Give every
camera its own identity and its own `tstzrange` bookings and the counting
problem collapses into the interval problem already solved for rooms — one
exclusion constraint per unit, no row lock, no sweep line, full parallelism
across units. This is the correct answer at scale. It is deferred for time,
because it requires a unit-selection strategy and a retry loop on constraint
violation: with 6 cameras free a request must pick one, and when it loses the
race for that unit it must try another rather than fail. That retry loop is the
part that needs care, and it is not free to write or to test.

### Three replicas

Both mechanisms are enforced by PostgreSQL, not by application memory — the
exclusion constraint is an index, the `FOR UPDATE` lock is a row lock. Neither
knows how many API processes exist, and neither can be defeated by a request
routed to a different one. That is precisely why this strategy survives the
load-balanced configuration, and why the concurrency proof runs through nginx
on :8080 rather than against a single replica.

### Hold expiry — the gap in the constraint

An exclusion constraint cannot carry a time-varying predicate. Its `WHERE`
clause tests `status`, a stored value; there is no way to write "...and the
hold has not yet expired" such that the index re-evaluates as the clock moves.
The consequence is a real bug: a hold that expired 30 seconds ago but has not
been swept still has `status = 'HELD'`, is still inside the predicate, and
still blocks a booking for a slot that is genuinely free.

Mitigation is twofold, and both halves are necessary:

1. **A background sweeper** flipping `HELD` to `EXPIRED` once the TTL elapses,
   running on a short interval.
2. **In-transaction expiry**: immediately before inserting a new hold, inside
   the same transaction, expire any stale holds for that room. The new hold is
   then checked against a predicate that is accurate as of this transaction.

**The sweeper alone is insufficient.** It runs on an interval, so there is
always a window between expiry and sweep in which the stale row still blocks.
That window is not theoretical under load — a burst of 200 requests against a
slot whose hold expired moments ago would be rejected wholesale by a design
that relied on the sweeper alone. The in-transaction expiry closes the window;
the sweeper exists so expired holds are released promptly for *availability
queries* and reporting, not only when someone happens to contend the slot.

### What survived contact with the implementation (P2)

The strategy above was committed in P0, before any hold code existed. Building
it in P2 changed none of the mechanism and two of the details:

1. **The equipment sweep line needs an explicit tie-break at equal instants.**
   Ends must sort before starts. Intervals are half open, so a booking ending
   at 14:00 has released its units before one starting at 14:00 takes them;
   ordering starts first reports a phantom peak at every back-to-back handover
   and refuses legal bookings. The draft said "order the events" without saying
   in which order equal events go, which is where the bug would have lived.

2. **The equipment check runs BEFORE the room INSERT, not after.** The draft
   left the order open. The room INSERT can block on the exclusion index behind
   another transaction, and holding equipment row locks while blocked there
   widens the equipment contention window to include room contention for no
   benefit. Deciding equipment first keeps each lock held for exactly the
   queries that need it.

Neither is a change of approach. Both are the kind of detail that only appears
when the code has to run, which is the argument for the proof in Appendix A
rather than for a longer design document.

### One correction to this draft, found while building it (P1)

The migration as originally specified did not run. Postgres rejected it:

```
ERROR:  generation expression is not immutable
```

`ends_at + interval '15 minutes'` calls `timestamptz_pl_interval`, which is
only **STABLE**, not IMMUTABLE — for day-or-larger intervals the result depends
on the session `TimeZone` across a DST boundary. Postgres will not allow a
merely-stable expression in a `STORED` generated column, even though 15 minutes
could never be affected by it.

The fix is to pin the arithmetic to a fixed zone, which makes every step
immutable while computing the identical value for a fixed-length interval:

```sql
tstzrange(
  starts_at,
  ((ends_at AT TIME ZONE 'UTC') + interval '15 minutes') AT TIME ZONE 'UTC',
  '[)'
)
```

Nothing about the strategy changes — the buffer is still inside the enforced
interval, still enforced by the same constraint as the overlap rule. Only the
spelling changed. Recorded here rather than silently corrected, per the brief's
instruction to leave both versions in and note what changed.

### Verification transcript (P1)

Run against `postgres:16-alpine` with `0000` and `0001` applied to an empty
database. Full script: `apps/api/src/db/migrations/` plus the fixtures shown.

```
=== TEST 1: two overlapping HELD bookings for the same room ===
INSERT 0 1
--- first insert above should succeed; second below must fail 23P01 ---
ERROR:  conflicting key value violates exclusion constraint "no_room_overlap"
DETAIL:  Key (room_id, slot)=(2222..., ["2026-09-01 09:30:00+00","2026-09-01 10:45:00+00"))
         conflicts with existing key (room_id, slot)=(2222..., ["2026-09-01 09:00:00+00","2026-09-01 10:15:00+00")).

=== TEST 2: turnaround buffer. Existing booking ends 10:00. ===
--- 10:10 start must be REJECTED (inside the 15-minute gap) ---
ERROR:  conflicting key value violates exclusion constraint "no_room_overlap"
DETAIL:  Key (room_id, slot)=(2222..., ["2026-09-01 10:10:00+00","2026-09-01 11:15:00+00"))
         conflicts with existing key (room_id, slot)=(2222..., ["2026-09-01 09:00:00+00","2026-09-01 10:15:00+00")).
--- 10:15 start must be ACCEPTED (exactly at the gap boundary) ---
INSERT 0 1

=== TEST 3: a CANCELLED booking must not block its old slot ===
UPDATE 1
INSERT 0 1

=== TEST 4: audit_events is append only ===
INSERT 0 1
--- UPDATE must be rejected by the trigger ---
ERROR:  audit_events is append only
CONTEXT:  PL/pgSQL function audit_events_immutable() line 2 at RAISE
--- DELETE must be rejected by the trigger ---
ERROR:  audit_events is append only
CONTEXT:  PL/pgSQL function audit_events_immutable() line 2 at RAISE

=== TEST 5: role/venue coherence CHECK ===
--- VENUE_ADMIN with NULL venue_id must be rejected ---
ERROR:  new row for relation "users" violates check constraint "users_venue_scope_ck"
--- CUSTOMER with a venue_id must be rejected ---
ERROR:  new row for relation "users" violates check constraint "users_venue_scope_ck"

=== FINAL STATE: surviving bookings and their enforced slots ===
    id    |       starts_at        |        ends_at         |                        slot                         |  status
----------+------------------------+------------------------+-----------------------------------------------------+-----------
 aaaaaaaa | 2026-09-01 09:00:00+00 | 2026-09-01 10:00:00+00 | ["2026-09-01 09:00:00+00","2026-09-01 10:15:00+00") | CANCELLED
 aaaaaaaa | 2026-09-01 09:00:00+00 | 2026-09-01 10:00:00+00 | ["2026-09-01 09:00:00+00","2026-09-01 10:15:00+00") | HELD
 aaaaaaaa | 2026-09-01 10:15:00+00 | 2026-09-01 11:00:00+00 | ["2026-09-01 10:15:00+00","2026-09-01 11:15:00+00") | HELD
```

Note the `slot` values in the final row set: a booking that *ends* at 10:00
occupies the enforced interval up to 10:15. That is the turnaround buffer being
carried by the constraint rather than by application code.

This is single-connection evidence that the rule is correct. It is **not** the
concurrency proof — that requires 200 simultaneous requests across three
replicas and lands in P4.

---

## 4. Payment Integrity Model

*Stub — P5. How exactly-once effect is achieved over Paygate's at-least-once,
out-of-order channel; why the webhook handler is idempotent on business effect
rather than deduplicated on delivery id; what happens to a webhook for an
unknown charge; and the INV-4 sequence where a hold expires while payment is in
flight.*

---

## 5. Indexing and Query Strategy

*Stub — P8. With `EXPLAIN ANALYZE` evidence before and after the indexing work.*

---

## 6. Stack Choice and Rejected Alternatives

*Stub — P9. The brief requires the stack to be justified here against at least
one rejected alternative, with an honest account of what the choice costs.
Short entries live in `DECISIONS.md`; this section carries the argument.*

---

## 7. Assumptions

Every ambiguity resolved unilaterally, and what was decided.

**0. The clarifying-questions window was not used.** The brief allowed one
batch of clarifying questions within the first three hours. I did not use that
window. Every ambiguity below was therefore resolved unilaterally and is
documented here rather than asked.

**1. Hold TTL versus the checkout guarantee.** The brief sets a hold TTL of 8
minutes, and separately guarantees the customer at least 10 minutes from
reaching the checkout screen. These cannot both hold for a hold created 8
minutes before checkout is reached. Resolution: reaching checkout **re-arms**
the hold to `now + 10 minutes`. To close the obvious loophole — a client that
re-enters checkout repeatedly to hold a slot indefinitely — re-arming is
permitted at most **twice per booking** and never beyond **30 minutes total
hold life**, whichever binds first. A re-arm is rejected if it would conflict
with another booking, so re-arming can never take a slot from someone who
legitimately acquired it in the meantime.

**2. The overbooking buffer applies to equipment only.** The brief says a venue
admin may enable an overbooking buffer of up to 10% "on any inventory". Applied
to a room this directly contradicts INV-1, which says a room may never be
double booked under any circumstances — a 10% buffer on a single physical space
is a second booking for that space. Where the operating rules and the
invariants disagree, the invariants win, since the brief calls them
non-negotiable and tests them directly. Resolution: rooms accept a buffer of
`0` and reject any other value with **422**. Equipment accepts a buffer up to
10%, which is meaningful there because a fleet of 6 cameras genuinely can be
oversold by a fraction of a unit's worth of no-show risk.

**3. A policy change must not retroactively alter a CONFIRMED booking.** Policy
is data and a venue admin can change their tiers through the API with immediate
effect, so a cancellation processed after a policy change would otherwise be
priced under terms the customer never agreed to. Guaranteed by **snapshotting
the resolved policy onto the booking row at the moment of confirmation**.
Cancellation reads that snapshot and never live policy. The snapshot is the
resolved tier set, not a foreign key to a policy version, so a policy row being
edited or deleted later cannot change what an existing booking is worth.

**4. Seeding is deterministic, not random.** Seeding 250,000 bookings against a
live exclusion constraint requires deterministic non-overlapping slot
generation per room. Random time generation would collide continuously —
every collision is a constraint violation and a wasted round trip — and at
250,000 rows against progressively denser rooms it would never complete. The
seed therefore walks each room's calendar forward deterministically, emitting
slots that cannot overlap by construction, and varies density per room instead
of varying times randomly.

**5. The 15-minute turnaround is a platform constant, not per-venue.** The
brief lists it under a venue's operating rules, which could be read as
per-venue. It is implemented as a platform constant because it is baked into
the `bookings.slot` generated column, and a generated column cannot reference
another table. Making it per-venue would mean moving the buffer out of the
constraint and back into application logic — reintroducing exactly the
query-then-check race the design exists to eliminate. If a venue genuinely
needed a different gap, the correct change is a second generated column per
buffer size or a per-venue partial constraint, not an application check.

**6. A cross-venue read returns 404, not 403.** The brief accepts "a 403 or
404, and never data". 404 is chosen because 403 confirms the row exists: a
VENUE_ADMIN of Venue A probing UUIDs could distinguish "exists but not yours"
from "no such booking" and enumerate another venue's identifiers. The cost is
worse ergonomics for legitimate users, who cannot tell a typo from a
permissions problem. Accepted.

**7. The 15-minute turnaround applies to rooms, not to equipment.** (P2.)
`bookings.slot` carries the buffer because a physical room needs cleaning
between occupants, and the exclusion constraint compares `slot` against `slot`.
The equipment sweep line deliberately uses raw `starts_at`/`ends_at` instead. A
tripod handed back at 14:00 is available at 14:00; applying the room buffer
there would silently reserve a quarter hour on every equipment booking that
nothing in the brief asks for, cutting effective fleet capacity for no stated
reason. The asymmetry is deliberate and is the reason the two mechanisms read
different columns.

**8. Cross-venue search is not an INV-6 exception.** (P2.) `GET /search` returns
rooms from every venue and is not tenant-scoped. Tenant isolation protects a
venue's bookings, customers and revenue — not the existence of its rooms, which
is precisely the catalogue a marketplace exists to publish. Nothing operational
crosses a venue boundary on that endpoint: no booking, no customer, no
occupancy. The isolation tests target the endpoints that do carry that data.

**9. An expired hold is never revived.** (P2.) Checkout refuses to re-arm a hold
whose `expires_at` has passed, and expires it properly on the way out rather
than reporting a stale row as live. Reviving it would hand back a slot another
customer may already legitimately hold. This is INV-4's shape appearing before
payments exist: expiry is a one-way door.

---

## 8. What Breaks at 100x

*Stub — P9. The first three things that fall over at 25 million bookings, and
what to do about each.*

---

## 9. What I'd Do With Two More Weeks

*Stub — P9. In priority order.*

---

## Appendix A — Concurrency proof output

Run against `docker compose up` — Postgres, three API replicas, nginx
round-robin on :8080 — with:

```bash
pnpm proof
```

Source: `tests/concurrency/src/hold.proof.test.ts`. The fixtures are owned by
the test, not read from the seed.

Pasted verbatim, 2026-08-23:

```text
==============================================================================
ATRIUM CONCURRENCY PROOF
==============================================================================
target            http://localhost:8080  (nginx -> api1, api2, api3)
concurrency       200 requests, released together
contended room    5607c198-832b-461b-89b5-3d1e59772e72
contended slot    2026-08-26T05:00:00.000Z .. 2026-08-26T06:00:00.000Z
equipment type    abe253aa-f8ff-498f-96f2-50145e5413fd  (units_owned = 3)

-- INV-1: same room, same one-hour slot --------------------------------
  responses        201 x1, 409 x199
  replica spread   api1=68 api2=67 api3=65
  distinct booking f88ec188-a7dc-4428-8e11-08be9e6dc9d2

-- INV-1 re-read from Postgres ----------------------------------------
  active bookings overlapping the slot: 1
  ids: ["f88ec188-a7dc-4428-8e11-08be9e6dc9d2"]

-- INV-2: 200 distinct rooms, 1 unit each, 3 units owned ----------
  responses        201 x3, 409 x197
  replica spread   api1=65 api2=68 api3=67
  admitted         3 (ceiling 3)

-- INV-2 re-read from Postgres ----------------------------------------
  units_owned                    3
  peak concurrent usage          3
  total units reserved (rows)    3

-- run summary --------------------------------------------------------
  total requests   400
  5xx responses    0
  replicas seen    api1, api2, api3
  per replica      api1=133 api2=135 api3=132
==============================================================================

 Test Files  1 passed (1)
      Tests  5 passed (5)
   Duration  3.23s
```

### What each line is there to rule out

**`201 x1, 409 x199`** — INV-1. One winner, and every loser got a clean 409.
A single 500 in that column would mean the exclusion violation escaped as a
server error: the data would still be intact, but it would be a correctness
failure by the brief's own terms, and it is exactly what happens if the
SQLSTATE check does not walk Drizzle's `cause` chain.

**`replica spread api1=68 api2=67 api3=65`** — without this the run proves
nothing. An in-process mutex passes a 200-request test served entirely by one
replica. The header comes from the API itself (`x-replica-id`), not from
nginx's `$upstream_addr`, so the assertion reads as replica names rather than
as container IPs that change on every `compose up`.

**`200 distinct rooms`** on the equipment run — the detail most easily got
wrong. Pointed at a single room, `no_room_overlap` rejects 199 requests before
the equipment check ever executes, and the test passes green while proving
nothing whatsoever about INV-2. Distinct rooms remove the room constraint from
the picture so the only thing that can bound the successes is the equipment
admission check.

**`peak concurrent usage 3`, re-read from Postgres** — the HTTP responses can
be right while the rows are wrong. This is a second, independently written
sweep-line query run directly against the database after the burst. Asking the
API would only establish that the application agrees with itself.

**`5xx responses 0`** across all 400 requests. Under 200-way contention on one
row, a deadlock (40P01), a lock timeout, or an unhandled constraint violation
would all show up here.

### One bug this found

The first run of the equipment case returned **500 on all 200 requests**:
`malformed array literal`. Drizzle expands a JS array inside a `sql` template
into one placeholder per element, so `ANY($1::uuid[])` received a bare UUID
rather than an array. The fix builds the Postgres array literal explicitly and
binds it as a single parameter (`equipment-availability.ts`, `uuidArray`).

Worth recording because of how it would have read without the transcript: every
equipment hold failing looks, from the outside, like the admission check
rejecting everything — a plausible INV-2 story — when the actual fault was in
how one parameter was bound. The `5xx responses` assertion is what separated
the two.
