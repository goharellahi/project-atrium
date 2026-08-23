# DECISIONS.md

Engineering decisions where a reasonable alternative existed, what was chosen,
what was rejected, and what the choice costs. A decision with no cost listed is
not a decision, it is a preference.

> **Written as decisions are made, not reconstructed at the end.** Entries below
> are from P4 (payment integrity and tenant isolation). The P0–P2 decisions —
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
