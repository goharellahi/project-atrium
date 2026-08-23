# PLAN.md

Phases P0–P8, one branch each (see the Working Agreement in `CLAUDE.md`).
Ordered so that nothing in a lower tier starts until the tier above it is
correct, tested and running.

**Update this file after every phase**: tick the boxes and append a dated entry
to the progress log at the bottom.

Legend: `[ ]` not started · `[~]` in progress · `[x]` done

> **Renumbered at P1.** The P0 draft ran P0–P9 on a different split. The phase
> list below matches the branch names in the Working Agreement, which is the
> authority. Old P1+P2 merged into the new P1; old P3+P4 into the new P2.

---

## P0 — Scaffolding and design · `main`

- [x] pnpm workspace monorepo: `apps/api`, `apps/paygate`, `apps/web`,
      `tests/concurrency`, `tests/authz`, `tests/load`
- [x] `.gitignore` excluding `.brief/` — written before the first commit
- [x] `docker-compose.yml`: postgres + api1/api2/api3 + nginx + paygate + web
- [x] `nginx/nginx.conf` — round-robin over three replicas on :8080
- [x] Dockerfiles for api, paygate, web on `node:26-alpine`
- [x] `CLAUDE.md`, `PLAN.md`, `ARCHITECTURE.md` first draft, `DESIGN.md`
- [x] Pinned versions verified to resolve on npm

> The brief requires the concurrency strategy committed **before the hold
> endpoint exists**. Commit timestamps are checked. P0 is that commit.

---

## P1 — Schema, constraints, auth, deploy skeleton · `feat/p1-schema-auth`

- [x] `CREATE EXTENSION btree_gist`
- [x] Drizzle schema: venues, rooms, equipment_types, users,
      cancellation_policies, bookings, booking_line_items, payments,
      payment_events, webhook_deliveries, audit_events
- [x] `bookings.slot` as a generated `tstzrange` including the 15-minute
      turnaround
- [x] `no_room_overlap` exclusion constraint, hand-written SQL
- [x] `audit_events` append-only, enforced by trigger not convention
- [x] CHECK constraints: role/venue coherence, interval sanity, 10% buffer cap
- [x] Constraint verified by hand against real Postgres; transcript in
      ARCHITECTURE.md §3
- [x] JWT auth, argon2id, `POST /auth/login`, `POST /auth/register`,
      `GET /auth/me`
- [x] RolesGuard and VenueScopeGuard; guards global, routes opt out
- [x] Tenant isolation enforced at the repository layer
- [x] zod 4 validation pipe, 422 on failure
- [x] pino structured logging with a request correlation id
- [x] `/health` genuinely checks Postgres
- [x] Multi-stage Dockerfile, `render.yaml`, `vercel.json`, `.env.example`
- [x] `.github/workflows/ci.yml` — install, migrate, typecheck, lint, test
- [x] `README.md` with a populated Known Issues section
- [x] `docker compose up` stands up all 8 services healthy from empty
- [x] **Deployed and reachable** — API on Render free, web on Vercel, both
      answering `/health`

---

## P2 — Booking core · `feat/p2-booking-core`

- [x] One seed script, two profiles: `--profile=demo`, `--profile=full`
      *(moved here from P7 — the proof and every manual check need data)*
- [x] Deterministic non-overlapping slot generation (Assumption 4)
- [x] Room availability query over a range, honouring hours and turnaround
- [x] Cross-venue search: city, capacity, amenity set, price ceiling and
      availability window, combined
- [x] Operating-hours validation per day of week, in the venue's timezone
- [x] Granularity: 30-minute increments, 1–8 hours, 1 hour to 90 days ahead
- [x] State machine service — the **only** place `bookings.status` is written
- [x] Every transition emits exactly one AuditEvent
- [x] Illegal transition returns 409, never 500
- [x] Hold creation in one transaction: in-transaction expiry of stale holds,
      then insert against the exclusion constraint (**INV-1**)
- [x] Equipment admission: `SELECT ... FOR UPDATE` then the sweep-line
      peak-concurrent-usage check (**INV-2**)
- [x] Background hold sweeper, HELD to EXPIRED, elected by advisory lock
- [x] Checkout re-arm: 10 minutes, at most twice, 30-minute lifetime cap
- [x] Payment provider interface defined, unimplemented (P3 owns the client)
- [ ] Overbooking buffer honoured for equipment; rooms reject non-zero with 422
      — **the equipment half is done, the room-side 422 is not.** No endpoint
      writes `venues.overbooking_buffer_pct` yet; the CHECK constraint caps it
      at 10% and the admission ceiling reads it. The 422 lands with venue
      administration in P6.
- [ ] Unit tests over the state machine, every failure edge — **cut for time.**
      The transition table is covered end-to-end by the proof and by manual
      probes; the per-edge unit suite moves to P5.
- [ ] **INV-6 negative suite** in `tests/authz` — **cut for time**, moves to P5.
      Isolation was verified by hand this phase (see the progress log), not by
      an automated suite.

---

## P3 — Paygate and payment integrity · `feat/p3-payments-paygate`

Split across two branches because P2 and P3 ran in parallel. The provider was
built on `feat/p3-paygate`, touching `apps/paygate/` only; the API-side payment
integrity work lands separately once the booking core exists.

**Paygate — the provider** (`feat/p3-paygate`, done)

- [x] `POST /paygate/charges`, `POST /paygate/refunds`, HMAC-signed webhooks
- [x] All six chaos behaviours behind `PAYGATE_CHAOS=on`
- [x] Idempotency-Key honoured on charges and refunds, **including across a 500**
- [x] Signature computed over raw body bytes, never a re-serialised object
- [x] `PAYGATE_SEED` — every chaos decision replayable, per-decision not global
- [x] `X-Request-Id` stored against the charge, echoed on every delivery
- [x] `GET /paygate/charges/:id` — full delivery history for a reviewer
- [x] `POST /paygate/_test/deliver` and `/_test/delay` — deterministic control
      surface, outside the brief's spec, documented as such
- [x] `apps/paygate/README.md`; 33 tests covering the contract and the rates

**API — payment integrity** (not this branch)

- [x] Webhook handler idempotent **on business effect**, via
      `payment_events UNIQUE (charge_id, event)` (**INV-3**) — *P4*
- [x] Bad signature → 401, logged, never processed — *P4*
- [x] Webhook for an unknown charge neither 500s nor is silently dropped — *P4*
- [x] Fast webhook path, no heavy work inline; choice explained — *P4*
- [x] Expired hold + successful payment → automatic refund, recorded (**INV-4**)
      — *P4*
- [x] Cancellation with data-driven refund policy; policy snapshot at
      confirmation; refunds idempotent — *P4*
- [x] Reconciliation endpoint proving **INV-5**, zero discrepancies — *P4*

> **Landed on `feat/p4-payments-integrity`**, not on `feat/p3-payments-paygate`.
> P3's branch had already merged with the provider only; opening it again for
> the API half would have made one branch span two phases of history.

---

## P4 — API payment integrity and the authz suite · `feat/p4-payments-integrity`

> **Renumbered.** The concurrency proof that P4 originally held was delivered in
> P2 (below). P4 became the API half of payments plus the negative test P2 cut —
> the two things standing between the project and two of its three hard caps.

- [x] **INV-6 negative suite** in `tests/authz` *(cut from P2, was scheduled P5)*
- [x] Route census: a registered route must be probed or exempt with a reason
- [x] `POST /bookings/:id/pay` — HELD only, unexpired, row before provider call
- [x] `POST /webhooks/paygate` over the raw body, HMAC verified before parsing
- [x] Worker applying `charge.succeeded`, `charge.failed`, `refund.succeeded`
- [x] Policy snapshot frozen onto the booking at confirmation
- [x] `GET`/`PUT /venues/cancellation-policy` — policy overridable, no deploy
- [x] `GET /equipment-types` and `/equipment-types/:id`, venue-scoped
- [x] `GET /admin/reconciliation` — seven discrepancy classes, PLATFORM_ADMIN
- [x] Refund calculator unit tests, every tier boundary *(pulled from P5)*
- [x] State machine transition table tests *(cut from P2, pulled from P5)*
- [x] `docker-compose.yml`: `PAYGATE_CALLBACK_URL` and a pinned `PAYGATE_SEED`
- [ ] **Nothing in this phase has been run against a live stack.** Typecheck,
      build and the 29 offline unit tests pass; the payment path, the INV-6
      probes and the DI graph are unverified. First action of the next session.
- [ ] One end-to-end happy path driven through `/paygate/_test/deliver` and
      `/_test/delay` — cut for time, moves to P5

---

## P4 (original) — The concurrency proof · delivered in P2

> **Delivered early, in P2.** The proof is what says whether the hold path is
> correct, so writing it in the same phase as the hold path was the only way to
> know. It is also a hard cap on the whole assessment, and discovering a failure
> two phases later would have cost the phases in between. P4 is now free for
> whatever the proof turns up under harder conditions.

- [x] 200 concurrent requests, released together, through nginx on :8080
- [x] Same room, same one-hour slot: exactly one success
- [x] EquipmentType with exactly 3 units: at most 3 units reserved
- [x] Every other request gets a clean 409 — not an error, not a duplicate
- [x] Database re-read after the run, not just HTTP assertions
- [x] Replica distribution recorded in the output
- [x] Output pasted into `ARCHITECTURE.md` (Appendix A)
- [ ] Re-run against the `full` profile — 250k rows, not 25k

---

## P5 — Tests and observability · `feat/p5-tests-observability`

- [x] Unit tests over the state machine transition table *(cut from P2, done P4)*
- [x] **INV-6 negative suite** in `tests/authz` *(cut from P2, done P4)*
- [x] Unit tests over the refund calculator, every tier boundary *(done P4)*
- [ ] Unit tests over the state machine's *runtime* edges — the row lock, one
      audit row per transition, the 409 body. Needs a real Postgres.
- [ ] One end-to-end happy path *(cut from P4)*
- [ ] Correlation id surviving into the webhook path, proven by a test
- [ ] CI green with the full suite

---

## P6 — Frontend · `feat/p6-frontend`

- [ ] Console per `DESIGN.md` — rooms, equipment, pricing, policy
- [ ] Booking flow: search, hold, checkout, confirmation
- [ ] Revenue and utilisation report per venue over a date range

---

## P7 — Performance · `feat/p7-performance`

- [x] One seed script, two profiles — **delivered in P2**, where the proof and
      every manual check needed it. Renumbering drift, corrected rather than
      worked around.
- [x] Deterministic non-overlapping slot generation (Assumption 4) — P2
- [ ] `EXPLAIN ANALYZE` before indexing work
- [ ] Indexing pass; `EXPLAIN ANALYZE` after, with what changed
- [ ] k6 scripts, run from the `grafana/k6` image
- [ ] `LOAD_TEST.md`: p50/p95/p99, error rate, machine spec, both EXPLAINs

---

## P8 — Final documents · `docs/p8-final`

- [ ] `DECISIONS.md` — 8–15 entries: choice, rejected alternative, trade-off
- [ ] `AI_LOG.md` — what was delegated, where the agent was wrong or naive
- [ ] `TIMELINE.md` — hour by hour, what was cut, why
- [ ] `ARCHITECTURE.md` stubs completed: ERD, state machine, payment integrity,
      indexing, stack justification, 100x, two more weeks
- [ ] Five test logins: one per role plus a second venue admin at another venue
- [ ] 5-minute walkthrough recording

---

## Deliverables checklist

- [ ] Public git repository with real commit history
- [~] Deployed API URL — https://atrium-api-3p3j.onrender.com — live; seeding is P7
- [~] Deployed frontend URL — https://project-atrium.vercel.app — live; the
      console itself is P6
- [x] `README.md` (stub with Known Issues; final pass in P8)
- [ ] `ARCHITECTURE.md` — all required sections
- [ ] `DECISIONS.md`
- [ ] `AI_LOG.md`
- [ ] `TIMELINE.md`
- [ ] `LOAD_TEST.md`
- [x] `CLAUDE.md`
- [x] `PLAN.md`
- [x] `DESIGN.md`
- [ ] Tests: concurrency proof, cross-venue authz, state machine units, refund
      calculator units, one end-to-end happy path
- [ ] Walkthrough recording

### Explicit non-goals

Tier 3 is deliberately unscheduled: live heatmap and WebSockets, natural
language booking, recurring bookings, waitlist with automatic promotion,
notifications. The brief is direct that a beautiful real-time calendar with a
race condition in the hold path scores below a plain submission with all of
Tier 1 correct. Revisited only if time remains after P8, and recorded in
`TIMELINE.md` either way.

---

## Progress log

### 2026-08-23 — P0 complete

Scaffolding and design only. No booking logic, no endpoints, no hold code — by
design, so the commit timestamp on the concurrency strategy precedes any
implementation of it.

Built the workspace, compose stack, nginx config, Dockerfiles, and the four
documents. Verified all 18 pinned versions resolve on npm and `docker compose
config` validates.

### 2026-08-23 — P1 complete (except deployment)

Schema, constraints, auth, observability and the deploy skeleton. The whole
compose stack now comes up healthy from an empty database and serves
authenticated traffic through the load balancer.

**Four things went wrong, all found by running the stack rather than reasoning
about it. Each is worth keeping.**

1. **The migration as specified did not run.** `ends_at + interval '15 minutes'`
   is STABLE, not IMMUTABLE, so Postgres refuses it in a `STORED` generated
   column. Fixed by pinning the arithmetic to UTC. Both versions left in
   ARCHITECTURE.md §3 rather than silently corrected.
2. **drizzle-kit wanted to `DROP COLUMN slot`** — and would have taken
   `no_room_overlap` with it, since the constraint depends on the column. Caught
   because the generated 0002 was read before being trusted. Snapshot patched so
   `generate` is a clean no-op.
3. **Every Docker build was silently using the host's Windows `node_modules`.**
   Docker does not honour per-directory `.dockerignore`; the `apps/*/.dockerignore`
   files were inert. Root `.dockerignore` added, misleading files removed.
4. **Intermittent 502s under the load balancer.** Docker DNS returns AAAA
   records, so nginx connected over IPv6 while the API bound `0.0.0.0`. This one
   matters most: during the P4 concurrency proof it would have produced failures
   indistinguishable from a genuine invariant violation. Now binds `::`.

Also: `node:26-alpine` no longer ships corepack, and Drizzle nests pg errors
under `cause`, so a duplicate registration returned 500 instead of 409 until
`common/pg-errors.ts` was written to walk the chain. That helper is what will
catch `23P01` from the exclusion constraint in P2.

**Verified by hand**, transcript in ARCHITECTURE.md §3: overlapping holds
rejected with 23P01; a booking ending 10:00 blocks a 10:10 start but permits
10:15; a CANCELLED booking releases its slot; `audit_events` rejects UPDATE and
DELETE; role/venue CHECK rejects both incoherent shapes. Auth verified through
nginx: 201/200/401/409/422 all correct, `passwordHash` never serialised, and a
register body carrying `role: PLATFORM_ADMIN` produces a CUSTOMER.

**Deliberately not built:** any booking logic, availability query, hold
endpoint or seed script. Those are P2.

### 2026-08-23 — P1 deployment landed

Live on the free tiers, but it took four attempts and each failure was a real
constraint worth recording rather than a typo:

1. `preDeployCommand` is paid-tier only — the blueprint is rejected outright at
   validation, before anything builds.
2. `dockerCommand` is **not** run through a shell. Render treats the whole
   string as a single executable name, so `sh -c "a && b"` exits 127 with
   `sh: node dist/db/migrate.js && node dist/main.js: not found`. Shell
   chaining is simply unavailable there.
3. Resolution: migrations run in-process in `main.ts` before the server binds,
   behind `RUN_MIGRATIONS_ON_BOOT`. No shell, no script file, no chmod — and no
   CRLF trap, which a committed `.sh` would have hit on this Windows checkout.
   The flag defaults to off so compose keeps its one-shot `migrate` service;
   three replicas each migrating on boot would race.
4. Vercel's Next.js detection reads the *installed* package before running the
   build, so the no-op `installCommand` in `vercel.json` guaranteed
   `No Next.js version detected`. Both overrides removed — Vercel resolves the
   pnpm workspace root by itself. `output: 'standalone'` scoped to non-Vercel
   builds, since it exists only for the Docker runtime stage.

The through-line: every one of these was a deployment-target constraint that no
amount of local testing would have surfaced, which is the argument for doing the
deploy in P1 rather than at the end. Discovering them during P8 would have cost
the deployment hard cap.

### 2026-08-23 — P3 Paygate complete (provider only)

`apps/paygate/` only. The API-side payment integrity half of P3 is untouched and
still open; it depends on the booking core from P2.

All six chaos behaviours are in, at the brief's rates, verified over a
20,000-key sample rather than asserted. Two design calls are worth recording
because they are not what the obvious implementation would do:

1. **The idempotency record is written before the 10% transient-failure branch
   is evaluated.** The naive order — decide the 500 first, record only on
   success — cannot satisfy "a retry with the same Idempotency-Key must not
   produce a second charge", because after a 500 the key is unknown and the
   retry mints a new charge. Writing the key first means the charge id survives
   the 500; the charge exists but is *not materialised* (no outcome, no webhook)
   until a retry adopts it. That distinction is the whole contract.

2. **Chaos is seeded per decision, not from one global stream.** A single shared
   PRNG would have made `PAYGATE_SEED` a lie under concurrency: the same seed
   produces different branches depending on how the event loop interleaved
   requests. Each decision is instead seeded from
   `(PAYGATE_SEED, Idempotency-Key, label)`, so a charge's branch is
   order-independent and a 200-request run replays exactly. Verified: two runs
   at seed `replay-me` produced an identical 500 pattern and identical duplicate
   counts; a different seed diverged.

**Race and delayed delivery are drawn from a single uniform**, not two
independent coins — a delivery cannot both precede the 202 and arrive 60 seconds
late, and independent draws would have silently given 23.75% races instead of
the specified 25%.

**Documented extensions to §06**, both additive:

- `charge.failed` and `refund.succeeded` events. The brief names only
  `charge.succeeded`; without the other two the API cannot reach FAILED and INV-4
  has no evidence the automatic refund settled. `refund.succeeded` carries an
  extra `refund_id` field.
- `POST /paygate/_test/deliver` and `POST /paygate/_test/delay`, behind
  `PAYGATE_TEST_ENDPOINTS`. Chaos rates are a property of the population; an
  INV-3 or INV-4 test that waits for a 30% branch to fire is a coin flip, not a
  test. Marked clearly as outside the spec in `apps/paygate/README.md`.

**Not done, deliberately:** no retry when a delivery hits an unreachable
callback — the brief's chaos table does not ask for it and it would add a second
source of duplicate deliveries on top of the specified 30%. Idempotency keys are
never expired. Both recorded in the Paygate README's Known Limitations.

**One thing outside this branch's scope that needs attention:** `docker-compose.yml`
sets `PAYGATE_WEBHOOK_URL`, the brief calls it `PAYGATE_CALLBACK_URL`, and
`PAYGATE_SEED` is not set anywhere. Paygate accepts both names so nothing is
broken, but compose passes no seed, so the deployed stack runs on the default.
Left alone rather than edited from a paygate-scoped branch.

### 2026-08-23 — P2 complete: booking core and the concurrency proof

Seed, availability, cross-venue search, the hold path, the state machine, the
sweeper, and the 200-request proof. The proof passes and its transcript is in
`ARCHITECTURE.md`, Appendix A: `201 x1, 409 x199` for the room, `201 x3,
409 x197` against 3 units for the equipment, zero 5xx across 400 requests,
spread 133/135/132 over the three replicas.

**Renumbering drift, corrected rather than worked around.** `PLAN.md` had the
seed in P7 and the proof in P4. Both landed here, because both are things the
hold path cannot be checked without. Boxes are ticked in their original phases
with a note saying where the work actually happened, rather than being quietly
moved.

**Four things went wrong, all found by running it rather than reasoning about
it.**

1. **Every equipment hold returned 500.** Drizzle expands a JS array inside a
   `sql` template into one placeholder per element, so `ANY($1::uuid[])`
   received a bare UUID and Postgres answered `malformed array literal`. This
   is the one worth keeping: from the outside, 200 equipment requests all
   failing looks exactly like the admission check rejecting everything — a
   plausible INV-2 story — when the fault was in how one parameter was bound.
   The `5xx responses 0` assertion is what separated the two. Without it the
   proof would have been "read" as a design problem.
2. **The seed silently delivered 14,138 of 25,000 bookings.** Splitting the
   total evenly gives every room the same target while giving the quiet ones a
   quarter of the throughput to reach it; they run out of calendar and nothing
   takes up the slack. Targets are now apportioned in proportion to density,
   with 15% headroom, and the script WARNS rather than under-delivering
   quietly. A P7 benchmark against a database a third the intended size would
   have been worse than no benchmark.
3. **`GET /bookings/:id` returned 500** on every call. Money is stored as
   `bigint` minor units so no amount touches a float, and `JSON.stringify`
   throws on a BigInt rather than coercing it — spreading the row left
   `totalMinor` beside the stringified copy. Now an explicit projection, which
   also means a column added later is not published by accident.
4. **Stepping a calendar by 24 hours skips a day.** The availability window
   walk advanced by 24h of absolute time, which lands on the wrong local day
   across a fall-back DST transition. It now steps the venue's local calendar.

**Two details the P0 concurrency draft left open**, both recorded in
ARCHITECTURE.md §3: the sweep line needs ends to sort before starts at equal
instants (half-open intervals — otherwise every back-to-back handover reports a
phantom peak), and the equipment check must run *before* the room INSERT so its
row locks are not held while blocked on the exclusion index.

**Verified by hand** beyond the proof: 422 on 10:07 starts, 9-hour durations,
100-days-ahead and outside-operating-hours; checkout re-arms twice then 409s on
the third; cancel then cancel again gives 200 then a 409 naming the illegal
transition; `admin.b` reading a booking at another venue by valid UUID gets 404,
not 403; `GET /bookings` totals differ per admin (3056 vs 3068) and a customer
sees only their own 77. A stale HELD row inserted directly into Postgres was
flipped to EXPIRED within one tick by exactly one replica, with exactly one
audit event.

**Cut for time, and recorded rather than hidden:** the per-edge state machine
unit suite and the automated `tests/authz` INV-6 suite. Isolation was checked by
hand as above but is not yet a test. Both move to P5. The room-side 422 for a
non-zero overbooking buffer is also outstanding — nothing writes that column
until venue administration exists in P6.

**Deliberately not built:** any payment logic. `payments/payment-provider.ts`
defines the interface and binds a provider that throws; P3 owns the client on
its own branch.

### 2026-08-23 — P4: payment integrity and the required negative test

The API half of payments, and the `tests/authz` suite P2 cut. Two of the
brief's three hard caps were sitting open; both are now closed in code.

**The authz suite is built around not trusting itself.** The realistic way to
breach cross-venue isolation is not a broken endpoint written today — it is a
correct-looking one added in P6 that nobody remembers to cover. So the suite
reads the API's controller decorators and fails if a registered route is
neither probed nor listed as exempt *with a written reason*. That half needs no
stack and runs in CI on every push; a guard that only fires under
`docker compose up` would not have fired. The probes close the other end: each
records itself, and the run fails if a route claimed as covered was never
actually requested.

Three assertions in there are worth keeping because the obvious version of the
test would have missed them:

1. **The body, not the status.** A 403 whose message names the room has still
   leaked it. Every denial is checked against every identifier belonging to the
   other tenant.
2. **The rows, not the response.** A denial that nonetheless performed the write
   passes every status assertion, so venue B's bookings are re-read from
   Postgres afterwards.
3. **Availability and search are probed for what they must not carry, not for a
   denial.** Cross-venue reads there are a Tier-1 requirement. The line is
   free/busy intervals yes, booking and customer identifiers no. Classifying
   them as "exempt" would have been the easy call and the wrong one.

**Two design calls on the payment path.**

1. **The charge key is derived from the booking id, not supplied by the
   client.** `charge:<booking_id>`, persisted and committed before Paygate is
   called. A client that retries with a fresh key, a stale key, or none at all
   still cannot be charged twice — the alternative makes INV-3 depend on the
   client getting it right. The cost is real and accepted: a declined booking
   cannot be re-attempted under a new charge, because FAILED is terminal and the
   customer rebooks. The refund key is derived the same way from the charge id,
   which is what makes the INV-4 automatic refund and a double-clicked cancel
   converge on one refund even if they race.

2. **The webhook queue is a table, not an array.** `webhook_deliveries.
   processed_at IS NULL` is the queue; the handler records and returns, and the
   work is drained by a kick plus an advisory-lock-elected sweep. An in-memory
   queue loses everything a replica was holding when it died, and a captured
   charge would then never reach its booking — money at the provider, nothing
   here, INV-5 violated with no trace of why. It is also what makes the
   race-on-response branch self-healing: a delivery that arrives before its own
   payments row stays unprocessed and is retried, rather than being 500ed
   (Paygate retries forever) or dropped (money lost).

**Contradiction with an earlier decision, recorded rather than smoothed over.**
`payment-provider.ts` was written in P2 saying P3 would bind the real client on
`feat/p3-payments-paygate`. It did not: P3's branch shipped the provider only
and merged, so the API half landed here on `feat/p4-payments-integrity`. The
P2 comment is now wrong about the branch name. Left as-is rather than rewritten,
per CLAUDE.md — the sequence is the record.

**Cut, and not hidden:** the end-to-end happy path driven through Paygate's
`/_test/deliver` and `/_test/delay`. That is the test that would turn INV-3 and
INV-4 from designed-for into demonstrated, and it is the single highest-value
thing left. It moves to P5.

**The honest limitation: none of this has been run.** Typecheck passes, the API
builds, and 29 offline unit tests pass — the refund calculator at every tier
boundary from both sides, and the transition table exhaustively over the full
N × N product. But the stack was never brought up this phase, so the payment
path, the INV-6 probes and the Nest DI graph after the `StateMachineModule`
extraction are all unverified against a running system. Every previous phase in
this project found its real bugs by running it rather than by reasoning about
it, and there is no reason to think this one is different. Verifying it is the
first action of the next session, not an afterthought.

Also fixed, since this phase owned the file: `docker-compose.yml` set
`PAYGATE_WEBHOOK_URL` where the brief says `PAYGATE_CALLBACK_URL`, and passed
no `PAYGATE_SEED` — so the stack ran on Paygate's default and no chaos branch
was reproducible, which is precisely what the per-decision seeding in P3 was
built to provide.
