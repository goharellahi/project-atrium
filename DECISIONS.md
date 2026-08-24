# DECISIONS.md

Engineering decisions where a reasonable alternative existed, what was chosen,
what was rejected, and what the choice costs. A decision with no cost listed is
not a decision, it is a preference.

> **Written as decisions are made, not reconstructed at the end.** Entries 1–8
> are from P4 (payment integrity and tenant isolation); 9–11 are from P5 and 12
> from P6, and every one of those was forced by running the system rather than
> reasoning about it. The P0–P2 decisions —
> the exclusion constraint over query-then-insert, the sweep line over
> `SUM(quantity)`, advisory-lock election over an environment flag, minor units
> as `bigint` — currently live in `ARCHITECTURE.md` §3 and §7 and are folded in
> here during P8. The final file is 8–15 entries.

---

## 1. The charge idempotency key is derived from the booking id, not supplied by the client

**Chosen.** `POST /bookings/:id/pay` accepts no `Idempotency-Key` from the
caller. The key is `charge:<booking_id>`, minted server-side, written to
`payments` and committed *before* Paygate is called.

**Rejected: a client-supplied key.** It is the conventional design and it is
what Paygate's own interface invites. It was rejected because it makes INV-3 —
"a booking is charged at most once, regardless of client retries" — conditional
on the client getting it right. A client that retries with a fresh key presents
Paygate with a key it has never seen, and Paygate correctly creates a second
charge. The invariant would then be a property of the frontend, which the brief
treats as absent for authorisation and which is no more trustworthy here.

**Rejected: a key generated inside the provider client.** Same failure, one
layer down: a new key on every attempt is the same as having none.

**What it costs.** A booking whose charge is declined cannot be re-attempted.
`FAILED` is terminal, so the customer books again. This matches the brief's own
state machine, which gives `FAILED` no outgoing edge, so it is the specified
behaviour rather than a workaround for the key scheme — but the constraint is
real and worth naming.

**The obvious next step, deliberately not built.** A bounded re-attempt minting
`charge:<booking_id>:<n>`, where `n` is an attempt counter persisted on the
booking. That keeps the key derived (so retries of attempt *n* still collapse)
while allowing a decline to be retried. It needs a `FAILED → PENDING_PAYMENT`
edge, which contradicts the brief's state machine, so it is a change to make
deliberately and not in passing.

---

## 2. The refund key is derived from the charge id

**Chosen.** `refund:<charge_id>`, persisted on the payments row before the
provider is called, exactly as the charge key is.

**Rejected: a per-attempt refund key.** Two independent paths can decide a
refund is owed — the INV-4 automatic refund when a captured charge lands on an
unconfirmable hold, and a customer cancelling — and they can race. Per-attempt
keys refund twice, and INV-5 then reports money it cannot account for.

**What it costs.** A partial refund followed by a second partial refund against
the same charge is not expressible. Atrium never issues one: a cancellation
refund is computed once from the policy snapshot and issued in full.

---

## 3. Deduplicate on business effect, never on delivery id

**Chosen.** Applying a webhook is gated on inserting `payment_events`, which is
`UNIQUE (charge_id, event)`. If the insert loses, the effect has already been
applied and the delivery is marked as a duplicate.

**Rejected: deduplicating on `X-Paygate-Delivery`.** It is the obvious key and
it is useless for this: Paygate mints a fresh delivery id on every attempt, so
every redelivery of the same event looks new. `webhook_deliveries.delivery_id`
is still `UNIQUE`, but it catches a literal retransmission of one delivery, not
a redelivery of one event. Conflating the two is the standard way to ship a
webhook handler that double-applies under exactly the conditions it was written
to survive.

**What it costs.** An event genuinely intended twice for one charge (there is
no such event in Paygate's contract) would be swallowed.

---

## 4. The webhook queue is a Postgres table, not an in-process queue

**Chosen.** `webhook_deliveries.processed_at IS NULL` is the queue. The handler
verifies, records, returns 200, and the work is drained by an immediate kick
plus an advisory-lock-elected periodic sweep.

**Rejected: doing the work inline.** Paygate retries on timeout. A handler that
confirmed a booking, resolved a policy and possibly issued a refund before
answering would sometimes be slow enough to be retried — manufacturing exactly
the duplicate deliveries the ledger exists to absorb, under load, when the
system can least afford it.

**Rejected: an in-memory queue.** It loses everything a replica was holding when
it dies. A captured charge would then never reach its booking: money at the
provider, nothing here, INV-5 violated with no trace of why.

**What it costs.** A round trip to Postgres on the webhook path, and a drain
interval of latency in the worst case. It also buys the fix for the
race-on-response branch for free: a delivery that arrives before its own
`payments` row stays unprocessed and is retried, rather than being 500ed (which
makes Paygate retry forever) or dropped (which loses the money).

---

## 5. Cancellation policy is a row, not a constant

**Chosen.** Tiers live in `cancellation_policies`; the platform default is the
row with `venue_id IS NULL`, seeded by migration `0003`. Resolution is one
`ORDER BY`: the venue's newest row if it has one, otherwise the platform's.

**Rejected: a percentage table in TypeScript with a database override.** The
brief requires a venue to override the tiers through the API with no deploy. The
moment an override exists, there are two sources of truth for one number and
which one answers a given cancellation depends on whether a row happens to
exist.

**What it costs.** A missing platform default row is a broken deployment rather
than a graceful fallback — the resolver throws instead of guessing. That is
intentional: the alternatives at that point (refund nothing, refund everything)
are both defensible and both wrong to pick silently.

Related: the tier schema refuses a ladder that does not bottom out at
`min_hours_before: 0`, so the cancellation path has no unreachable branch.

---

## 6. A cross-venue read returns 404, not 403

**Chosen.** 404, everywhere, for a resource belonging to another venue.

**Rejected: 403.** The brief accepts either. 403 confirms the row exists, so a
VENUE_ADMIN probing UUIDs could distinguish "exists but not yours" from "no such
booking" and enumerate another venue's identifiers.

**What it costs.** Legitimate users cannot tell a typo from a permissions
problem. Accepted. Also recorded as ARCHITECTURE.md Assumption 6.

---

## 7. The INV-6 suite reads the API's route table and fails on anything it does not cover

**Chosen.** `tests/authz` enumerates every route from the controllers' decorators
and fails if one is neither probed nor listed as exempt with a written reason.
That half runs in CI with no stack.

**Rejected: a hand-maintained list of endpoints to probe.** It proves something
about the endpoints that existed the day it was written. Cross-venue leakage is
a hard cap, and the realistic way to breach it is not a broken endpoint written
today — it is a correct-looking one added in P6 that nobody remembers to cover.

**Rejected: exposing the Nest router table over HTTP.** Nest can be asked for it,
but only from inside the process, so this would mean adding a production route
whose sole purpose is to be read by a test.

**What it costs.** A route registered dynamically rather than by decorator would
be missed. None are, and the limitation is written into the suite's README
rather than left implicit.

---

## 8. Catalogue data crosses venue boundaries; tenant data does not

**Chosen.** Rooms, equipment types, rates and free/busy availability are readable
across venues. Bookings, customers, reports, revenue and policy are not, and
return 404 across the boundary. INV-6 constrains the second set.

**Rejected: scoping availability and search to the caller's venue.** It is the
conservative reading of "a room belonging to Venue B", and it would break the
Tier 1 cross-venue search outright — a customer is not a venue-scoped user, and
a marketplace whose customers see one venue's calendar is not a marketplace.

**What it costs.** A competitor can read another venue's occupancy at the
free/busy level. That is the same information any public booking calendar
publishes. The line drawn is *who*, not *what*: an endpoint that says a slot is
taken is catalogue; one that says who has it is tenant data. The INV-6 suite
probes both catalogue endpoints for the absence of booking ids, user ids and
emails, so the line is asserted rather than asserted-to.

---

## 9. Holds queue on a per-room advisory lock before touching the exclusion index

**Chosen.** `pg_advisory_xact_lock(4771, hashtext(room_id))` as the first
statement of the hold transaction, plus a bounded retry on class-40 aborts with
a 2–6 ms backoff.

**Rejected: nothing at all**, which is what P2 shipped. It is correct and it
passes the proof — once. Run the proof five times and Postgres logs 227
deadlocks: concurrent inserts of the same range into a gist exclusion index wait
on each other's xids and form cycles, and a cycle is only broken after
`deadlock_timeout`, a full second. A second of lock wait per deadlock across a
20-connection pool produced 59 5xx on the fifth run.

**Rejected: retrying harder.** Tried first, with a 10–30 ms exponential backoff,
and it took a run from 1 stray 500 to 170. A retrying request holds its pool
connection through another contended transaction, so the budget multiplies queue
depth. A retry must be shorter than the transaction it retries or it becomes the
load.

**Rejected: a bigger pool.** Buys queueing inside Postgres rather than
throughput, and does nothing about the one-second detection latency that is the
actual cost.

**What it costs.** Holds for one room now serialise on a lock as well as on the
constraint — but they had to serialise anyway, so the cost is a hash computation
per hold. Two rooms whose ids collide in `hashtext` would queue behind each
other; that costs throughput on those two rooms and never correctness.

**The thing to keep straight.** This is a queueing discipline, not a correctness
mechanism. `no_room_overlap` still decides every admission and deleting this
line changes throughput, not outcomes. It is emphatically not the in-process
mutex CLAUDE.md rejects — the lock lives in Postgres and holds across all three
replicas. Numbers in ARCHITECTURE.md Appendix B.

---

## 10. The payment channel pulls as well as pushes

**Chosen.** The webhook drainer polls the provider for any refund it accepted
and has not reported on within `REFUND_POLL_AFTER_SECONDS`, and applies the
answer through the same `payment_events` gate a webhook would.

**Rejected: trusting the webhook channel alone.** Which is what P4 did. Paygate
corrupts 2% of delivery signatures and never retries a delivery, so those
messages are gone permanently — the API correctly answers 401 and the business
effect they carried is lost. The soak lost six refunds that way: money genuinely
returned, `refund_id` recorded, `payments.status` stuck on SUCCEEDED forever. An
at-least-once channel that is at-most-once for 2% of messages cannot be the only
source of truth about money.

**Rejected: marking a payment REFUNDED as soon as a refund id comes back.** It
would have closed the same gap in one line, and it would be a lie. The
synchronous response is `202 processing`; accepted is not settled. Recording
settlement we have not observed is modelling a provider that does not exist,
which is the exact failure `payment-provider.ts` was written in P2 to avoid.

**Rejected: making the reconciliation endpoint repair as a side effect of being
read.** A report that mutates what it reports on cannot be trusted as a report,
and it would only ever run when someone happened to look.

**What it costs.** One extra provider call per stale refund, on a drain tick,
and a new failure surface in the drainer. The poll deliberately waits 45 seconds
first, so it never races a webhook that is merely in flight.

---

## 11. Signed webhook bodies are stored as `text`, never `jsonb`

**Chosen.** `webhook_deliveries.raw_body text NOT NULL` — the exact bytes
received.

**Rejected: `jsonb`.** Which is what P4 shipped, and it broke the payment path
outright: Drizzle hands a string to the driver as a jsonb literal and parses it
back on read, so every delivery failed with
`"[object Object]" is not valid JSON` and nothing was ever confirmed.

But the type would have been wrong even if it had worked. jsonb normalises key
order, whitespace and number formatting — precisely the things an HMAC is
computed over. A column that reformats signed bytes destroys the only evidence
that can settle a signature dispute.

**What it costs.** No indexing or querying into the body, and no validation at
write time. Both are fine: the fields worth querying (`charge_id`, `reference`,
`event`) are extracted into their own columns at ingest, and validating a body
before its signature is checked would be trusting exactly the bytes under
suspicion.

---

## 12. Create-hold's missed p95 is accepted and published, not optimised away

**Chosen.** Create-hold measures 536 ms p95 against the brief's 250 ms target.
The number is published as a miss, with the diagnosis, and no work was done to
move it in P6. P7 remains the console.

The diagnosis is what makes accepting it defensible rather than lazy. The same
endpoint answers in **47 ms p95** in isolation, so it is starved, not slow. Two
candidate causes were tested and both were wrong: it is not the database
(Postgres used 178% of eight vCPUs while all three Node replicas sat pinned at
92–98%, which is one core each and Node's ceiling), and it is not the connection
pool (doubling `PG_POOL_MAX` made throughput *worse*, 342 → 265 req/s). Turning
read concurrency down located the knee — throughput flat at ~340 req/s from two
read VUs onward while every latency climbs linearly, the signature of a
saturated box. Hold meets its target at five read VUs and misses at ten. Full
working in `LOAD_TEST.md` §5.

**Rejected: moving the availability enumeration off the request path now.** This
is the cheapest real win available and it is measured, not guessed —
`enumerate()` walks a 7-day calendar on a 30-minute grid per request, and one
response is 9.7 KB, which at 7,538 requests is **73 MB of the run's 86 MB**.
Returning busy intervals and letting the client enumerate would shrink that by
an order of magnitude and free the CPU that create-hold is queueing behind. It
touches no invariant: availability is explicitly advisory and the hold path
never consults it.

It was rejected for P6 anyway, on scope. It is a change to the *console's* data
contract — the client becomes responsible for enumerating slots — and making
that change before the console exists means designing an API shape for a
consumer that has not been written yet. Doing it in P7, with the page that
consumes it, is the order in which the shape can actually be validated.

**Rejected: re-running the hold scenario alone and reporting 47 ms.** It passes.
It is also a number about an idle machine, and the brief is explicit that a
missed target explained is worth more than a hit target unexplained. The
isolated run stays in `LOAD_TEST.md` as a diagnostic and the mixed run stays the
headline.

**What it costs.** The repository ships with a published, reproducible failure
against one of the four stated targets. A reviewer re-running the benchmark on
similar hardware will see it fail, and the threshold in `atrium.js` is written
to *fail the run* rather than warn — so this is not a soft miss that can be
overlooked, it is a red build by design.

The second cost is that the ceiling is asserted rather than proven. The claim
that more cores fixes it follows from three single-threaded processes each
saturating one core, and it is consistent with every measurement taken — but I
have one laptop, so "I would expect" is as far as it goes, and `LOAD_TEST.md`
says exactly that rather than implying a measurement that was never made.

**What would change this decision.** A run on a machine where the three replicas
are not CPU-bound. If hold still missed there, the diagnosis is wrong and the
endpoint itself needs work — most likely folding the advisory lock and the
stale-hold expiry into one statement to shorten the critical section
(`LOAD_TEST.md` §5, step 3).
