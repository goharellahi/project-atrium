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

Written in P4, and every claim in it verified in P5 against the running stack.
Where P5 found the claim was false, that is recorded here rather than quietly
corrected — see Appendix C.

### Exactly-once effect from an at-least-once channel

Two idempotency keys, both **derived**, never generated per attempt:

| Key | Derivation | What it makes impossible |
| --- | --- | --- |
| Charge | `charge:<booking_id>` | Two charges for one booking, whatever the client retries |
| Refund | `refund:<charge_id>` | Two refunds for one charge, however many paths decide one is owed |

Both are written to `payments` and **committed before the provider is called**.
A crash between the write and the HTTP call leaves a PENDING row carrying the
key a retry will reuse — recoverable. The reverse order leaves a charge at the
provider that this system has no record of, which is money lost silently.

The client supplies no key at all. Accepting one would make INV-3 conditional on
the client getting it right, and the brief treats client-side guarantees as
absent.

### Why the inbound side deduplicates on effect, not on delivery

`payment_events` is `UNIQUE (charge_id, event)`, and applying an event is
conditional on winning that insert. `webhook_deliveries.delivery_id` is also
unique, but deduplicating on it would achieve nothing: Paygate mints a fresh
delivery id on **every attempt**, so each redelivery of the same event looks
new. The delivery id catches a retransmission of one delivery; the event ledger
catches a redelivery of one event. Only the second is what INV-3 is about.

Verified: three forced deliveries of one `charge.succeeded`, three distinct
delivery ids, one `payment_events` row, one confirmation, one charge at the
provider. Under the soak, 625 duplicate deliveries were absorbed this way in
three minutes.

### The handler does nothing heavy

Verify → record → return 200, in two round trips to Postgres. The work happens
afterwards, driven by `webhook_deliveries.processed_at IS NULL`.

That separation is load bearing rather than tidy. Paygate retries on timeout, so
a handler that confirmed a booking, resolved a policy and possibly issued a
refund before answering would sometimes be slow enough to be retried —
manufacturing exactly the duplicates the ledger exists to absorb, under load,
when the system can least afford it.

The queue is a **table** and not an in-memory array, because an in-memory queue
loses everything a replica was holding when it died. A captured charge would
then never reach its booking: money at the provider, nothing here, INV-5
violated with no trace of why.

### A webhook for a charge we have never heard of

Neither 500ed (Paygate would retry forever) nor dropped (that loses a captured
charge). The delivery is recorded with its `reference` — the booking id — and
left unprocessed, so the drainer keeps retrying it and the reconciler reports it
if it never resolves. When the cause is Paygate's 25% race-on-response branch,
where the webhook beats the 202 that names the charge, the retry finds the
`payments` row moments later and adopts the charge id onto it.

### INV-4: the hold expires while payment is in flight

The confirmation decision reads the booking under `FOR UPDATE` and confirms only
a live, unexpired hold. There is no branch that confirms an expired hold because
the customer paid — the slot may already belong to someone else, and a double
booking is a worse outcome than a refund.

Anything else is refunded automatically under the derived refund key, and the
sequence is audited:

```
hold.created                          DRAFT           -> HELD
payment.initiated                     HELD            -> PENDING_PAYMENT
hold.expired.payment_arrived_late     PENDING_PAYMENT -> EXPIRED
refund.initiated.unconfirmable_hold   EXPIRED         =  EXPIRED
refund.settled.terminal_booking       EXPIRED         =  EXPIRED
```

The booking stays EXPIRED. That state is terminal and money moving does not
resurrect it; the audit rows are where the settlement is recorded.

### The channel can lose a message permanently, so the system also pulls

Paygate corrupts 2% of delivery signatures and never retries a delivery. Those
are correctly rejected with 401 — and the business effect they carried is then
lost for good. The soak lost six refunds that way: money genuinely returned,
`refund_id` recorded from the synchronous 202, `payments.status` stuck on
SUCCEEDED forever.

So the drainer also **asks**. Any refund the provider accepted and has not
reported on within `REFUND_POLL_AFTER_SECONDS` is looked up directly, and the
answer applied through the same `payment_events` gate a webhook would use.

It does not mark a payment REFUNDED merely because a refund id exists. Accepted
is not settled, and assuming otherwise would model a provider that does not
exist — the same mistake `payment-provider.ts` was written in P2 to avoid.

The provider half is built (P3, `apps/paygate/`). Full detail —
env vars, the six chaos behaviours, how to force a scenario, a worked signature
verification — is in `apps/paygate/README.md`. The declared deviations from the
brief are mirrored here, because an addition that is declared reads as
engineering judgement and the same code undeclared reads as having misread the
spec.

### Extensions to the brief's §06 spec (Paygate)

Every item is **additive**: nothing the brief specifies behaves differently
because of it.

| # | Extension | Why |
| --- | --- | --- |
| 1 | Events `charge.failed` and `refund.succeeded` | The brief names only `charge.succeeded`. Without the other two the FAILED and REFUNDED states are unreachable, and INV-4 — hold expires, payment succeeds, money is automatically refunded — has no evidence the refund settled. |
| 2 | A `refund_id` field on `refund.succeeded` bodies | The correlation key for a refund. The signature still covers the whole body; a receiver ignoring unknown fields is unaffected. |
| 3 | `POST /paygate/_test/deliver` and `POST /paygate/_test/delay` | A chaos rate is a property of the population, not of any one run. An INV-3 test waiting for the 30% duplicate branch, or an INV-4 test hoping for the 5% late branch, is a coin flip rather than a test. These make both deterministic. |
| 4 | `PAYGATE_DECLINE_AMOUNT_MINOR` — a magic decline amount | `charge.failed` has to be reachable on demand, but the brief's chaos table asks for no random declines — and a random decline inside the 200-request proof would be indistinguishable from a real bug. A fixed trigger amount is how real test providers do this. |
| 5 | `PAYGATE_SEED` — replayable chaos | Unspecified in the brief. A chaotic test double whose branches cannot be reproduced is a coin flip; when a 200-request run turns up one bad booking, replaying the exact chaos is the only way to debug it. Seeded per decision from `(seed, Idempotency-Key)`, not from one global stream, so replay survives concurrency. |
| 6 | `GET /paygate/charges/:id` and `GET /paygate/refunds/:id` | Read-only. Lets a reviewer see every delivery attempt and the chaos branch each took. |
| 7 | `X-Request-Id` echoed on every webhook delivery | Not in §06's header list, but §09 Tier 2 requires a correlation id that survives into the webhook path. |
| 8 | `PAYGATE_WEBHOOK_URL` accepted as an alias for `PAYGATE_CALLBACK_URL` | `docker-compose.yml` uses the second name. Accepting both meant no shared file had to change; the brief's name wins if both are set. |
| 9 | `POST /paygate/_ledger/import` — signed bulk load of charges that already happened | The seed produces twenty thousand settled bookings, each implying a captured charge. Replaying them through `POST /paygate/charges` would fail 10% on purpose and dispatch a webhook per acceptance that would try to confirm already-confirmed bookings. These are history to agree on, not events to replay. See below for why this one authenticates. |

The `/paygate/_test/*` routes forge signed webhooks and take no authentication.
They live in their own module (`src/test-routes.ts`) so the boundary between the
specified provider and added scaffolding is a file boundary rather than a
comment, and they **refuse to register under `NODE_ENV=production`** regardless
of `PAYGATE_TEST_ENDPOINTS`. That is not a security control — Paygate holds no
real money — but a legibility one: nobody reading a production route table
should have to work out whether an unauthenticated webhook forger is scaffolding
or an oversight.

`/paygate/_ledger/import` is the one extension that is *not* unauthenticated,
and the difference decides where each can live. It verifies the same HMAC over
the same raw bytes with the same shared secret Paygate signs its webhooks with,
in the opposite direction — no new credential and no new mechanism — so it can
register under `NODE_ENV=production`, which it has to: the deployed instance is
exactly where the demo data that needs it lives. A caller who cannot sign cannot
import.

### Paygate's ledger is durable, and that reverses a P3 decision

**P3 kept Paygate's entire state in memory and argued for it explicitly:** a
test double is not a system of record, restarting it between runs *should* wipe
it, and a database would invite a reviewer to think the API's payment integrity
depends on the provider remembering things. That last point is true — and it is
true about **INV-3**, which is not the invariant the choice broke.

**INV-5 is.** "Money is never silently lost … provable via a reconciliation
endpoint returning zero discrepancies" cannot be demonstrated against a provider
with amnesia. Render's free tier sleeps after fifteen idle minutes, so a charge
captured before lunch does not exist after it and the refund that follows
answers `404 unknown_charge`: money gone from the provider's point of view,
owed from ours, no trace. It also made §4's pull path (`CHARGE_POLL_AFTER_
SECONDS`, below) inert — asking a provider for an outcome it structurally cannot
remember always answers "never heard of it", and the API was reading that as an
answer rather than as the absence of one.

Found in P8 by cancelling a seeded booking in a browser, not by reasoning about
it. The full reversal, including what it costs, is DECISIONS.md 13.

**The boundary is real, and one instance is a cost constraint rather than
coupling.** Paygate owns four tables — `paygate_charges`, `paygate_refunds`,
`paygate_idempotency`, `paygate_deliveries` — created by its own migration
runner against its own `paygate_migrations` history table. On every target this
project runs on, those tables live in the same Postgres instance as the API's,
because the free tier provides one instance and paying for two to make a point
would be the wrong trade. Everything that would make that *coupling* is absent,
deliberately and checkably:

- **No import crosses the boundary.** `apps/paygate` does not import from
  `apps/api/src/db`, and does not depend on Drizzle at all — which is why the
  migration runner is forty hand-written lines rather than a dependency. The
  separation is visible in the import graph, not only in this paragraph.
- **No foreign key crosses it, in either direction.**
  `paygate_charges.reference` holds the API's booking id as an **opaque
  string**, exactly as a real provider's `metadata.reference` does. Paygate
  never resolves it, never validates it, and answers identically if the API's
  schema is dropped. (`SELECT` over `pg_constraint` for foreign keys where one
  side is `paygate_*` and the other is not returns zero rows.)
- **No shared migration history**, so the two can be applied in either order by
  either service.
- **A separate connection variable.** `PAYGATE_DATABASE_URL`, not the API's
  `DATABASE_URL`. One shared variable would have made the separation invisible
  and, in time, untrue; pointing this one at a different Postgres is the whole
  of what splitting them takes.

**In-memory is still available and is no longer the default.**
`PAYGATE_STORE=memory` selects it and `/health` reports which store is live, so
it is never a guess. It exists for the 39 unit tests that assert the idempotency
contract and the chaos rates — durability buys those nothing and a database
would cost them the sub-second feedback that makes them worth running.
`PAYGATE_STORE=postgres` with no URL is a **boot failure, not a fallback**: a
silent fallback to memory is precisely how a deployment ends up running the
broken store with nobody having chosen it.

**Two races became safe on purpose rather than by accident.** `openCharge`
claims its Idempotency-Key with `INSERT … ON CONFLICT DO NOTHING RETURNING`, so
concurrent requests carrying one key produce one charge and one replay; in
memory that held only because Node does not interleave between a read and a
write. `openRefund` takes `FOR UPDATE` on the charge before checking
`refunded_minor + amount <= amount_minor` — a read-modify-write that two
concurrent partial refunds could each pass independently — with a CHECK
constraint as the backstop.

### Two implementation choices worth naming

**The idempotency record is written before the transient-failure branch is
evaluated.** The obvious order — decide the 500 first, record only on success —
cannot satisfy "a retry with the same Idempotency-Key must not produce a second
charge", because after a 500 the key is unknown and the retry mints a new
charge. Writing the key first means the charge id survives the 500; the charge
exists but is not *materialised* — no outcome, no webhook — until a retry adopts
it.

**Race-on-response (25%) and delayed delivery (5%) are drawn from a single
uniform, not two independent coins.** A delivery cannot both precede the 202 and
arrive 60 seconds late. Independent draws would have silently produced
25% × 95% = 23.75% races instead of the specified 25%.

---

## 5. Indexing and Query Strategy

Delivered in P6. Every plan referenced here was captured with
`EXPLAIN (ANALYZE, BUFFERS)` against the `full` profile — 250,000 bookings, 800
rooms, 24 months — three warm passes each, keeping the third. The full
transcripts, the numbers, and the reproduction commands are in `LOAD_TEST.md`
§6; the capture script is `tests/load/explain/plans.sql`. What follows is the
argument, one sentence of plan-change per object, not a repeat of the tables.

**Buffer counts decide, not milliseconds.** The first pass of any capture is
measuring the buffer cache; wall clock on a laptop under Docker Desktop moves
30% between identical runs. `shared hit` does not.

### The three that were added

**`bookings (venue_id, starts_at)`** — the revenue report's four queries all
filter both columns, and the single-column `venue_id` index fetched all 7,264 of
the venue's lifetime bookings and discarded 6,956 of them to the date predicate;
189 buffers became 29, and the cost now grows with the reporting window instead
of with the venue's history.

**`bookings USING gist (slot) WHERE status IN ('HELD','PENDING_PAYMENT','CONFIRMED')`**
— cross-venue search holds a *list* of candidate room ids, so the planner cannot
use `room_id` as a leading key on `no_room_overlap`'s `(room_id, slot)` gist and
instead descends that index by time across every room in the table, spending 202
buffers inside the index scan alone to return 45 rows; a gist on `slot` by
itself spends 3.

**`bookings (room_id, expires_at) WHERE status = 'HELD'`** — the hold path's
in-transaction expiry of stale holds was a `BitmapAnd` whose first leg scanned
every expired hold *on the platform* (10,000 index entries in the measured case),
inside the hold transaction under the per-room advisory lock; with the partial
index it is a two-column `Index Cond` costing 8 buffers.

### The two that were deleted

**`bookings_venue_idx`** — a strict prefix of the new composite, so it served
nothing the composite does not, while costing a second index to maintain on
every booking write including inside the hold transaction.

**`venues_city_idx`** — zero scans across the entire benchmark and structurally
incapable of more, because cross-venue search filters on `lower(city)` and a
btree on `city` cannot answer that.

### The two that were built, measured, and rejected

This is the half of an indexing pass that usually goes unrecorded, and it is
where the two findings worth reading are.

**`bookings (id) INCLUDE (starts_at, ends_at, status, expires_at)`**, for the
equipment sweep line. The planner adopted it — `Index Only Scan`, heap fetches
gone, 2,267 buffers down to 1,849 — and it bought no time at all: median 2.75 ms
without it against 3.75 ms with it over five runs each. The pages it avoided
were already resident in `shared_buffers`, so the saving was a pointer chase,
while the index-only scan added visibility-map checks. Against that, 16 MB of
index maintained on every booking insert, on the hold path, on the one endpoint
already missing its target. **A plan can improve on paper and lose on the
clock, and buffers are the right signal only until they stop being the
bottleneck.**

**`venues (lower(city))`**, for cross-venue search. This one moved the plan
hard — 253 buffers to 23, nested loop to hash join — with an `idx_scan` of
exactly **zero**. It was never used as an index. What it supplied was an
*estimate*: Postgres collects statistics on indexed expressions, and without one
the planner guessed that `lower(city) = 'karachi'` matched a single venue rather
than fourteen, then chose a plan built for one row and nest-looped into `rooms`
fourteen times. The 40-row `venues` table was always going to be sequentially
scanned either way.

So the correct object is not an index:

```sql
CREATE STATISTICS venues_city_lower_stats ON lower(city) FROM venues;
```

Identical plan, identical 23 buffers, nothing to maintain on writes. **Search
had a statistics problem wearing an index problem's clothes.** Had the
functional index simply been kept because "the plan improved", the repository
would carry a permanently unused 16 kB index and the actual cause would never
have been found — and at 4,000 venues, where the estimate matters *and* the
access path starts to, the wrong lesson would have been on file.

### The one that needed nothing

**Room availability over a 7-day range** — the endpoint with the tightest read
target — was already optimal and got no new index. `no_room_overlap`'s gist on
`(room_id, slot)` is exactly the right shape for it: equality on the leading key,
range on the second, 28 buffers to find 6 rows in 250,000. The constraint that
*is* INV-1 is also this query's index. One object, two jobs, and it is worth
saying out loud because it was not designed for: the exclusion constraint was
chosen in P0 for correctness under concurrency, and the read performance is a
dividend.

### Two ways the measurement itself was wrong first

Recorded because a benchmark that measures the wrong query is worse than none.

1. The capture script wrote `freeRoomIds` as a correlated subquery. The real
   code passes a literal array. The two produce entirely different plans — with
   literals the planner can at least consider driving the gist per room — so the
   first Q3 numbers described a query the application never issues.
2. It aimed the availability window at `now() + 2 days` and hit a period every
   venue in the city was closed for, producing a zero-row plan. Proving a range
   empty is the cheap case; the script now anchors its window on a real future
   booking.

### What is deliberately not indexed

`booking_line_items.equipment_type_id` already has an index and the sweep line
uses it; the sweep's remaining cost is the 563 primary-key lookups into
`bookings` that follow, and no index on `bookings` fixes that — the selective
predicate is on `bookings.starts_at`/`ends_at` while the entry point is a line
item. The fix is a schema change, not an index, and it is §8's first entry.

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

**8. Catalogue data is cross-venue; tenant data is not. INV-6 constrains the
second set only.** (P2, drawn explicitly in P4.) The system holds two kinds of
data and they have different boundaries. **Catalogue data** — rooms, equipment
types, rates, capacities, amenities and free/busy availability — is
intentionally readable across venues, because cross-venue search is a Tier 1
requirement and a customer is not a venue-scoped user: a marketplace whose
customers can only see one venue's calendar is not a marketplace. **Tenant
data** — bookings, customers, reports, revenue and cancellation policy — is
venue-scoped and returns 404 across the boundary. INV-6 is a statement about
the second set. The line between them is *who*, not *what*: an endpoint that
says a slot is taken is catalogue, and an endpoint that says who has it is
tenant data. `GET /search` and `GET /rooms/:id/availability` sit on the
catalogue side and are tested for that — the INV-6 suite probes them not for a
denial but for the absence of any booking id, user id or email in the response.

**9. An expired hold is never revived.** (P2.) Checkout refuses to re-arm a hold
whose `expires_at` has passed, and expires it properly on the way out rather
than reporting a stale row as live. Reviving it would hand back a slot another
customer may already legitimately hold. This is INV-4's shape appearing before
payments exist: expiry is a one-way door.

---

## 8. What Breaks at 100x

25 million bookings instead of 250,000.

Everything below is grounded in a plan captured at 250,000 rows, and where a
claim needed a bigger number than the fixture provides, the number was
*measured* — by widening the query's own scan until it saw what a 100× denser
platform would put in front of it — rather than multiplied on paper.

The useful property shared by all three is that each has a cost which grows with
something unbounded while its answer stays the same size. That is what makes
them cliffs rather than slopes, and it is why "buy a bigger box" is the wrong
answer to all three.

Ordered by which is hit first.

---

### 1. Cross-venue search's availability filter

**`AvailabilityService.freeRoomIds`, called by `SearchService.search`.**

The query asks "which of these ≤2,000 candidate rooms have nothing booked in
this window". It is answered by a gist scan over *time*, with room membership
applied afterwards as a filter, because search holds a list of room ids and no
gist index can use a list as a leading equality key (§5).

Its cost is therefore a function of how many bookings exist in that window
**across the entire platform**, while its answer is bounded by the candidate
list. Those two quantities have nothing to do with each other, and only one of
them grows.

Measured by widening the window on the real query until the scan sees what 100×
density would put in a two-hour one:

| window | active bookings scanned | rows returned | buffers | time |
| --- | --- | --- | --- | --- |
| 2 h 15 m (the benchmarked case) | 181 | 74 | 183 | 0.45 ms |
| 30 days | 3,150 | 250 (saturated) | 1,368 | 5.6 ms |
| 180 days | 18,501 | 250 (saturated) | 2,135 | 10.5 ms |

The answer stops changing at 250 — the candidate count — while the scan grows by
a factor of 102. **Today's 180-day plan is tomorrow's two-hour plan**: at 100×
density the same two-hour window holds roughly 18,000 active bookings, so the
bottom row is a measurement of the future, not a projection of it. A 23×
slowdown on a Tier 1 read path that currently has 71% headroom against its
500 ms target — which means it survives one order of magnitude and not two.

**What I would do.** Partition `bookings` by `starts_at`, monthly. Every query
that touches this table is already time-qualified — availability, search, the
revenue report, the sweeper — so pruning turns "scan the platform's bookings in
this window" into "scan one or two partitions", and each partition's index stays
small enough to be genuinely resident. Archiving old bookings also becomes a
`DETACH` rather than a delete of twenty million rows.

The cost is real and worth stating plainly: `no_room_overlap` is an EXCLUDE
constraint, and Postgres cannot enforce one *across* partitions unless the
partition key is part of it. Partitioning on `starts_at` alone would therefore
break INV-1 — overlap would be enforced within a month but not across a month
boundary, which is exactly where a booking spanning midnight on the 31st lives.
The workable version partitions by `RANGE (starts_at)`, enforces overlap per
partition, and adds a CHECK that no booking crosses a partition edge — safe
because bookings are at most 8 hours long. That is a real migration with a real
chance of getting INV-1 wrong, which is why it is written down here rather than
attempted in a performance phase.

The cheap intermediate, if that is too big a step: cap the availability window
in `SearchSchema`, which is currently unbounded where `AvailabilitySchema` caps
at 31 days. That bounds the damage without fixing the shape.

---

### 2. The equipment sweep line, inside the hold transaction

**`equipment-availability.ts :: peakConcurrentUsage`.** Yes — this is the one,
and the honest answer is worse than "it gets slow".

The sweep line is the correct algorithm for INV-2 and nothing here argues
otherwise; a `SUM(quantity)` would be fast and wrong. The problem is the join
that feeds it. The entry point is `booking_line_items.equipment_type_id` and the
selective predicate is a time range on `bookings`, so the two sit on opposite
sides of a join and **the planner has two plans available, both unbounded**:

```
1 equipment type   (663 line items)
  -> Nested Loop, 663 Index Scans on bookings_pkey       2,670 buffers   2.2 ms
     cost is proportional to the type's LIFETIME line-item count

5 equipment types  (2,971 line items)
  -> Hash Join
     -> Bitmap Index Scan on bookings_status_expires_idx
          actual rows=54,589   Rows Removed by Filter: 54,401
                                                         2,358 buffers  10.7 ms
     cost is proportional to the PLATFORM's total active bookings

20 equipment types (10,757 line items)
  -> same shape                                          2,523 buffers  14.0 ms
```

The answer, in all three cases, is between one and nine rows.

Read the middle plan again: to find 162 relevant bookings it scanned 54,589 and
discarded 54,401. And the planner *flips between* the two plans depending on how
many equipment types the booking names — so a customer adding a second camera to
their cart changes the query's asymptotic behaviour.

Neither plan is bounded by the answer. The nested loop grows with an equipment
type's history, which never shrinks: a camera fleet does not shed the bookings it
took last year. The hash join grows with platform size. At 100×, one of them is
scanning 5.5 million rows and the other is doing 66,000 index lookups.

**And it runs inside the hold transaction, holding `SELECT ... FOR UPDATE` on
the `equipment_types` row.** That is what makes this the most serious of the
three. Every millisecond here is a millisecond in which every other hold for that
equipment type is blocked, so the cost does not surface as latency — it surfaces
as a throughput ceiling. At today's 2.2 ms a type admits roughly 450 holds a
second; at 100× the nested-loop plan puts that near 4.5. A popular camera on a
busy Saturday becomes a queue.

**What I would do.** Denormalise `starts_at`, `ends_at` and `status` onto
`booking_line_items`, and index `(equipment_type_id, starts_at)` partial on the
active statuses. The sweep then reads one table with both the entry point and the
selective predicate on the same index, and its cost becomes proportional to line
items *in the window* — the only quantity here that is bounded.

The standard objection to denormalisation is drift, and here it is answerable
rather than waved away: `starts_at` and `ends_at` are immutable after creation —
nothing in the state machine ever writes them again — so those two cannot drift
by construction. `status` can, and it is the one that needs a trigger on
`bookings` to propagate. One trigger is a better thing to own than a query with
two unbounded plans on the write path.

Second, smaller, and independent: the expiry predicate is spelled
`NOT (status = 'HELD' AND expires_at IS NOT NULL AND expires_at <= now())`,
which is not sargable, and is part of why the planner reaches for
`bookings_status_expires_idx` and then throws away 99.7% of what it read.
Rewriting it as `(status <> 'HELD' OR expires_at > now())` lets a partial index
cover it.

---

### 3. The reconciliation endpoint — INV-5's only evidence

**`GET /admin/reconciliation`.** The endpoint whose entire purpose is to prove
that no money was lost. It runs a union of nine discrepancy subqueries across
`payments`, `payment_events`, `webhook_deliveries` and `bookings` — and runs it
**twice**, once to count every discrepancy by kind and once to return a page of
them. The second pass was added deliberately in P4, because the one-pass version
reported `LIMIT 500` as the total, and a report whose whole job is to be
trustworthy was silently truncating its own headline number.

Measured now, at 250,000 bookings and 207,519 payments, over an all-time window:

```
reconciliation total: 5.279s   http=200
reconciliation total: 5.434s   http=200
reconciliation total: 5.049s   http=200
```

Five seconds, already. `payments` is 96 MB, `payment_events` 58 MB, the whole
database 279 MB — all of it comfortably inside `shared_buffers`. At 100× that is
roughly 9.6 GB of payments and 5.8 GB of events against a 256 MB buffer pool,
scanned twice. This does not degrade to thirty seconds; it degrades to reading
fifteen gigabytes off disk twice per request, and it will hit nginx's 30-second
`proxy_read_timeout` long before it returns.

The failure is not that an admin page gets slow. It is that **the only mechanism
which demonstrates INV-5 stops being runnable**, and an invariant you cannot
check is an invariant you no longer know you have.

**What I would do.** Make reconciliation incremental instead of a full sweep.
Every discrepancy class is of the form "this row has been in state X for longer
than a grace period", which is a statement about a *window* rather than about all
of history — the endpoint already takes `from`/`to`, and the all-history call
above is the pathological use of it. Concretely: index `payments (updated_at)`
and `webhook_deliveries (received_at) WHERE processed_at IS NULL` so a windowed
query is a range scan; keep a materialised marker of "reconciled clean up to
timestamp T"; and have the live query cover only T to now. Anything before T was
already proved clean and does not need proving again every time someone opens the
page.

That also buys the property the current design lacks: a reconciliation run whose
cost is bounded by elapsed time since the last run, rather than by the platform's
entire lifetime.

---

### What is NOT on this list, and why

**The per-room advisory lock is not a scaling problem.** Worth saying explicitly,
because it looks like the obvious suspect — a lock on the write path, taken by
every single hold.

It is keyed on `hashtext(room_id)`, so contention on any one key is contention
between customers trying to book *the same room at the same moment*. That is
irreducible: it is the serialisation INV-1 requires, and every correct
implementation has it somewhere. The number of keys grows with the number of
rooms, so 100× the platform is 100× the locks, not 100× the contention per lock.
The concurrency proof already exercises the worst case — 200 requests on one key
— and it resolves in about 2.5 seconds with zero 5xx, at 250,000 rows as well as
at 25,000 (LOAD_TEST.md §7).

What *can* go wrong is lock **hold time**, and that is item 2 wearing the lock's
clothing: the advisory lock is held for the whole transaction, and the equipment
sweep line is inside it. Fixing the sweep line fixes the lock. Replacing the lock
would not fix the sweep line, and would reintroduce the deadlock storm it was
added to remove (§3, "The fix that worked").

**`no_room_overlap` itself is a slope rather than a cliff — but it is the next
one after these three.** It is 5.9 MB at 250,000 rows, so roughly 590 MB at 25
million, against `shared_buffers=256MB`. Today Q1 answers in 28 buffers, all
cache hits; past the point where the index stops fitting, every hold insert and
every availability read starts touching disk. It ranks fourth because the fix is
the same partitioning work as item 1 — per-partition indexes are small — and
because 256 MB is a compose-file default rather than a considered production
number.

**The hold sweeper's throughput is fifth.** It flips at most `BATCH_SIZE = 500`
holds per tick every 15 seconds: 2,000 a minute, platform-wide, from one elected
replica. At 100× the abandoned-hold rate that is not enough, and lapsed holds
would accumulate faster than they are cleared. The fix is genuinely easy — raise
the batch, shorten the tick, or shard the sweeper by room-id range — and it ranks
last because INV-1 does not depend on the sweeper being timely. The
in-transaction expiry in the hold path is what guarantees correctness; the
sweeper only bounds how long a lapsed row sits there (§3, "Hold expiry").

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

---

## Appendix B — The proof under repetition (P5)

Appendix A's run passed, and it was run **once**. P5 ran it eight times in a row,
and the difference is the whole point of this appendix.

### What repetition found

```
run 1   5xx responses 0
run 2   5xx responses 0
run 3   5xx responses 0
run 4   5xx responses 0
run 5   5xx responses 59        <- 500 x28, 504 x31
```

Postgres had logged **227 deadlocks** across those runs. The invariants never
broke — INV-1 still admitted exactly one booking, INV-2 still capped at three
units — but a caller got a 500 where a 409 belongs, which is its own fail
condition (CLAUDE.md hard rule 3). Appendix A had even named this as the thing
`5xx responses 0` existed to rule out. It simply never rolled the die enough
times.

### Mechanism

200 concurrent inserts of the same range into a gist exclusion index do not
queue politely. Each inserter finds a conflicting in-progress tuple and waits on
that transaction's xid; with enough of them the waits form cycles, and Postgres
breaks a cycle by aborting one side — **after `deadlock_timeout`, which defaults
to one full second**.

```
ERROR:  deadlock detected
DETAIL: Process 1279 waits for ShareLock on transaction 1402; blocked by process 1288.
        Process 1288 waits for ShareLock on transaction 1403; blocked by process 1279.
WHERE:  while checking exclusion constraint on tuple (582,5) in relation "bookings"
```

A second of lock wait per deadlock, spread across a 20-connection pool, is what
produced `timeout exceeded when trying to connect` (the 500s) and nginx's
30-second `proxy_read_timeout` (the 504s).

### The fix that made it worse first

The obvious response — retry the transaction on a class-40 abort — was tried
first, with a 10–30 ms exponential backoff. Measured:

| Configuration | 5xx across 5 consecutive runs |
| --- | --- |
| No retry | 0, 0, 0, 0, 59 |
| Retry x4, 10–30 ms backoff | 170, 54, 64, 20, 0 |

Retrying made it dramatically worse, and the reason is worth keeping: a retrying
request holds its pool connection through *another* contended transaction, so a
4-attempt budget multiplies queue depth on a 20-connection pool. **The retry has
to be shorter than the transaction it is retrying, or it becomes the load.**

### The fix that worked

A transaction-scoped advisory lock on the room, taken before the insert:

```sql
SELECT pg_advisory_xact_lock(4771, hashtext($room_id))
```

This is **not** a correctness mechanism and must not be read as one.
`no_room_overlap` still decides every admission; removing this line changes
throughput, not outcomes. It replaces a free-for-all with a total order, so no
cycle can form — and a contender arriving after the winner commits hits a
*committed* conflicting row and gets its 23P01 immediately instead of a second
later. Different rooms hash to different keys and never queue behind each other.
The two-argument advisory lock space does not collide with the single-argument
locks the hold sweeper uses.

The bounded retry stays as a safety net, with a 2–6 ms backoff and a budget in
`TRANSIENT_RETRY_ATTEMPTS`, because a deadlock is not a rejection: `23P01` means
"taken" and is a final answer, `40P01` means "ask me again" and says nothing at
all about the slot. Exhausting the budget is a 409 — sustained deadlocking on
one slot *is* contention.

### After

Eight consecutive runs, 3,200 requests:

```
run 1..8   5xx responses 0   (all 5 assertions passing in every run)
deadlocks logged by postgres over the whole sequence: 0
```

The canonical run, at the default configuration:

```
-- INV-1: same room, same one-hour slot --------------------------------
  responses        201 x1, 409 x199
  replica spread   api1=67 api2=66 api3=67

-- INV-1 re-read from Postgres ----------------------------------------
  active bookings overlapping the slot: 1

-- INV-2: 200 distinct rooms, 1 unit each, 3 units owned ----------
  responses        201 x3, 409 x197
  admitted         3 (ceiling 3)

-- INV-2 re-read from Postgres ----------------------------------------
  units_owned                    3
  peak concurrent usage          3

-- run summary --------------------------------------------------------
  total requests   400
  5xx responses    0
  replicas seen    api1, api2, api3
  per replica      api1=133 api2=135 api3=132
```

---

## Appendix C — Payment integrity, verified (P5)

P4 shipped the payment path unrun. P5 ran it, and the first thing it found was
that **none of it worked**.

### The bug that made the whole payment path inert

```
{"level":"error","replica":"api1","deliveryRowId":"2121aedf-...",
 "err":"\"[object Object]\" is not valid JSON","msg":"webhook.drain.item_failed"}
```

`webhook_deliveries.raw_body` was declared `jsonb` and the handler wrote the raw
body string into it. Drizzle hands a string to the driver as a jsonb literal and
parses jsonb back on read, so the column returned an object; `JSON.parse` of
`String(object)` threw on **every** delivery. Nothing was ever confirmed, no
refund was ever issued, and all three replicas retried the same six rows every
ten seconds indefinitely.

The type was wrong on principle as well. The column holds the exact bytes an
HMAC covers, and jsonb normalises key order, whitespace and number formatting —
precisely what a signature is computed over. The P4 comment above the column
said exactly that, and then chose jsonb anyway. It is `text` now (migration
0004).

### The bug only an ordering assertion could find

`audit_events.occurred_at` defaulted to `now()`, which is the **transaction
start time** and identical for every row that transaction writes. INV-4's expiry
and its refund come from one worker transaction, so ordering by
`(occurred_at, id)` fell through to a random UUID and reported the refund before
the expiry about half the time — describing a sequence that never happened.
`clock_timestamp()` now (migration 0005). A test asserting only that both rows
exist would still pass today.

### Deterministic scenarios

Chaos stays **on**. Every scenario forces its own case through Paygate's
`_test/deliver` and `_test/delay`, because a duplicate fires 30% of the time and
a late delivery 5%, and a test that waits for either is a coin flip wearing an
assertion. Natural duplicates and delays land in the middle of these tests
anyway — absorbing them is the point.

```
happy path: hold -> pay -> webhook -> CONFIRMED -> cancel -> refund
    total_minor 15000  =  room 10000 + equipment 5000
    cancelled at >48h  -> tier 48, room 10000, equipment 5000, total 15000
    double-clicked cancel -> 409, and Paygate shows exactly 1 refund
INV-3: 3 forced deliveries, 3 delivery ids, 1 payment_events row, 1 charge,
       re-pay returns outcome=replayed with the same charge id
INV-4: delivery parked, hold expired, capture arrives -> EXPIRED not CONFIRMED,
       refund key refund:<charge_id>, exactly 1 refund at the provider,
       audit order expiry-before-refund asserted explicitly
bad signature -> 401, recorded signature_valid=false, effect never applied,
                 charge_id NOT recorded because the body was never parsed
raw-byte verification: same object, one extra space -> 401
unknown charge -> 200, reference persisted, left unprocessed for the drainer
INV-5 -> 0 discrepancies, then exactly 1 unmatched_delivery once an orphan
         webhook is posted

Tests  20 passed (20)
```

The last pair matters most: the report returns zero, and then returns exactly one
when something real is wrong. A reconciler that cannot go non-zero is not
evidence of anything.

### The chaos soak — the honest INV-5 test

Three minutes of real traffic, chaos on, **no** `_test` endpoints touched, hold
TTL shortened to 45 s so abandoned holds actually lapse while a payment is in
flight.

```
-- soak traffic ------------------------------------------------------
  hold TTL observed   45s
  holds created       2157
  holds rejected 4xx  5756
  paid                1547
  pay failed (5xx)    180      <- Paygate's 10% transient branch, surfaced as 502
  cancelled           477
  abandoned at hold   430
  unexpected 5xx      0

-- deliveries --------------------------------------------------------
  applied              2012
  duplicate_effect     625
  invalid_signature    62

-- reconciliation ----------------------------------------------------
  discrepancies  0
  by kind        {}
  totals         {"captured_minor":"20235000","refunded_minor":"7330000",
                  "confirmed_bookings":"968","settled_payments":"1523"}
```

### What the soak found on its first run

Twelve discrepancies — six refunds, each reported twice:

```
  by kind {"capture_without_confirmation":6,"refund_initiated_not_settled":6}
```

The money had gone back. Paygate had issued every one of those refunds and
returned a refund id synchronously. What never arrived was the
`refund.succeeded` webhook, because 2% of deliveries have their signature
corrupted and Paygate never retries a delivery — so the API correctly answered
401, and the settlement was lost for good.

Two changes came out of it. The drainer now polls the provider for refunds it
accepted and never reported on, applying the answer through the same
`payment_events` gate (see section 4). And the report splits
`refund_initiated_not_settled` — no refund id, no evidence the provider was ever
reached — from `refund_accepted_not_settled`, where the provider has the money
and simply never said so. Reporting both under one name is what made the first
soak result unreadable.

This is the case for running the thing. No amount of reading would have produced
those six rows.

---

## Appendix D — Tenant isolation, verified (P5)

The INV-6 suite, against three replicas behind nginx. 24 assertions, and two of
them were passing for the wrong reason until P5 ran them.

**The fixture promoted nobody.** Users were registered with mixed-case labels
(`adminA`), and `POST /auth/register` lowercases the address before storing it,
so `UPDATE users ... WHERE email = $3` matched zero rows — a perfectly
successful UPDATE as far as Postgres is concerned. Every principal stayed a
CUSTOMER, and every cross-venue probe was denied because the caller had no venue
at all, not because tenant isolation works. The role assertion at the end of
`makePrincipal` caught it; a `rowCount` check now names the cause at the point
it happens.

**The policy probe never reached the code it was probing.** It sent a single
72-hour tier and got a 422, correctly, because `TiersSchema` refuses a ladder a
cancellation could fall off the end of. The request was rejected before the
`venue_id` in its body could do anything, so the test was exercising its own
validation and proving nothing about scoping.

```
✓ VENUE_ADMIN / VENUE_STAFF of A denied on B: GET /bookings/:id,
  POST /bookings/:id/{checkout,cancel,pay}, GET /equipment-types/:id   (10)
✓ the write probes did not mutate venue B          (rows re-read from Postgres)
✓ GET /bookings and GET /equipment-types for A contain no venue B row
✓ PUT /venues/cancellation-policy carrying B's venue_id changes only A
✓ GET /admin/reconciliation: 403 for VENUE_ADMIN, 200 for PLATFORM_ADMIN
✓ availability and search for B carry no booking id, user id or email
✓ hold with A's room and B's equipment -> 422, and creates nothing
✓ a CUSTOMER cannot read another customer's booking
✓ a PLATFORM_ADMIN reads both venues        (the positive control)
✓ unauthenticated -> 401
✓ every route listed as probed was actually requested

Tests  24 passed (24)
```

The route census — the half that runs in CI with no stack — enumerates every
route the controllers register and fails if one is neither probed nor exempt
with a written reason. 13 routes registered, 8 probed, 5 exempt.
