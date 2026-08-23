# PLAN.md

Phases P0–P9. Ordered so that nothing in a lower tier starts until the tier
above it is correct, tested and running.

**Update this file after every phase**: tick the boxes and append a dated entry
to the progress log at the bottom.

Legend: `[ ]` not started · `[~]` in progress · `[x]` done

---

## P0 — Scaffolding and design

- [x] pnpm workspace monorepo: `apps/api`, `apps/paygate`, `apps/web`,
      `tests/concurrency`, `tests/authz`, `tests/load`
- [x] `.gitignore` excluding `.brief/` — written before the first commit
- [x] `docker-compose.yml`: postgres + api1/api2/api3 + nginx + paygate + web,
      healthcheck on every service, api `depends_on` postgres `service_healthy`
- [x] `nginx/nginx.conf` — round-robin over three replicas on :8080
- [x] Dockerfiles for api, paygate, web on `node:26-alpine`
- [x] `CLAUDE.md` — invariants, mechanisms, hard rules, pinned versions
- [x] `ARCHITECTURE.md` first draft — Concurrency Strategy and Assumptions
      filled, remaining sections stubbed
- [x] `DESIGN.md` — visual direction fixed before any UI exists
- [x] Pinned versions verified to resolve on npm

> The brief requires the concurrency strategy to be committed and pushed within
> the first 4 hours, **before the hold endpoint exists in the repository**.
> Commit timestamps are checked. This phase is that commit.

---

## P1 — Schema, extensions and constraints

- [ ] `CREATE EXTENSION IF NOT EXISTS btree_gist` as the first migration
- [ ] Drizzle schema in `apps/api/src/db`: venues, rooms, equipment_types,
      users, bookings, booking_line_items, payments, audit_events
- [ ] `bookings.slot` as `tstzrange`, generated to include the 15-minute
      turnaround buffer
- [ ] `no_room_overlap` exclusion constraint (hand-written SQL migration —
      Drizzle does not model `EXCLUDE USING gist`)
- [ ] Booking status enum and the `CHECK` constraints that go with it
- [ ] `audit_events` append-only: revoke UPDATE and DELETE at the role level,
      not merely by convention
- [ ] Connection pool wired; `/health` upgraded to actually check the database
- [ ] Test: the exclusion constraint rejects an overlapping insert
- [ ] Test: the exclusion constraint permits a booking that starts exactly at
      the end of the previous turnaround gap

---

## P2 — Auth and venue-scoped authorisation

- [ ] Password hashing, login, JWT issue and verify
- [ ] Four roles: CUSTOMER, VENUE_STAFF, VENUE_ADMIN, PLATFORM_ADMIN
- [ ] Guard deriving `venue_id` from the token, never from path or body
- [ ] Repository layer that cannot express a venue-unscoped query by accident
- [ ] **INV-6 negative test suite** in `tests/authz`: VENUE_ADMIN of Venue A
      gets 403/404 and never data for a booking, room and report of Venue B,
      including by real valid UUID read from the seed
- [ ] PLATFORM_ADMIN positive control, so the suite cannot pass by denying all

---

## P3 — Availability and cross-venue search

- [ ] Room availability query over a 7-day range
- [ ] Cross-venue search: city, minimum capacity, amenity set, price ceiling
      and availability window, all combined
- [ ] Operating-hours validation per day of week
- [ ] Granularity rules: 30-minute increments, 1–8 hours, 1 hour to 90 days
      ahead
- [ ] First-pass indexes (measured properly in P8, not guessed here)

---

## P4 — Holds and the booking state machine

- [ ] State machine service — the **only** place `bookings.status` is written
- [ ] Every transition emits exactly one AuditEvent
- [ ] Illegal transition returns 409, never 500
- [ ] Hold creation inside one transaction: in-transaction expiry of stale
      holds, then insert against the exclusion constraint (**INV-1**)
- [ ] Equipment admission: `SELECT ... FOR UPDATE` on the equipment type, then
      the sweep-line peak-concurrent-usage check (**INV-2**)
- [ ] Overbooking buffer, equipment only; rooms reject a non-zero buffer with
      422 (see ARCHITECTURE.md Assumption 2)
- [ ] Background hold sweeper, HELD to EXPIRED
- [ ] Checkout re-arm: 10 minutes from checkout, at most twice, never beyond
      30 minutes total hold life (Assumption 1)
- [ ] Unit tests over the state machine, including every failure edge

---

## P5 — Paygate and payment integrity

- [ ] Paygate to spec: `POST /paygate/charges`, `POST /paygate/refunds`,
      HMAC-signed webhook delivery
- [ ] All six chaos behaviours behind `PAYGATE_CHAOS=on`: duplicate delivery
      30%, race on response 25%, transient 500 10%, delayed delivery 5%,
      out-of-order, bad signature 2%
- [ ] Idempotency-Key honoured on charges and refunds
- [ ] Webhook handler idempotent **on business effect**, not merely
      deduplicated on delivery id (**INV-3**)
- [ ] Signature verification: bad signature is 401, logged, never processed
- [ ] Webhook for an unknown charge neither 500s nor is silently dropped
- [ ] Fast webhook path — no heavy work inline; the choice is explained in
      ARCHITECTURE.md
- [ ] Expired hold plus successful payment triggers automatic refund and
      records the sequence (**INV-4**)

---

## P6 — The concurrency proof

- [ ] 200 concurrent requests, released together, through nginx on :8080
- [ ] Same room, same one-hour slot: exactly one success
- [ ] EquipmentType with exactly 3 units: at most 3 units reserved
- [ ] Every other request receives a clean 409, not an error, not a duplicate
      success
- [ ] Database re-read after the run, not just HTTP assertions
- [ ] Replica distribution recorded in the output
- [ ] Output pasted into `ARCHITECTURE.md`

---

## P7 — Cancellation, refunds and reconciliation

- [ ] Refund policy as data: platform default tiers, venue override via API,
      effective immediately with no deployment
- [ ] Policy snapshot written onto the booking at confirmation; cancellation
      reads the snapshot, never live policy (Assumption 3)
- [ ] Refund calculator unit tests across every tier boundary
- [ ] Refunds idempotent — double-clicking cancel refunds once
- [ ] Reconciliation endpoint proving **INV-5**, returning zero discrepancies

---

## P8 — Seed, indexing and load test

- [ ] One seed script, two profiles: `--profile=demo` and `--profile=full`
- [ ] Deterministic non-overlapping slot generation per room (Assumption 4)
- [ ] `EXPLAIN ANALYZE` for the availability and search queries, before
      indexing work
- [ ] Indexing pass; `EXPLAIN ANALYZE` after, with a sentence on what changed
- [ ] k6 scripts in `tests/load`, run from the `grafana/k6` image
- [ ] `LOAD_TEST.md`: p50/p95/p99 and error rate per endpoint, machine spec,
      both EXPLAIN outputs

---

## P9 — Console, deployment, CI and final documents

- [ ] Venue admin console per `DESIGN.md` — rooms, equipment, pricing, policy
- [ ] Revenue and utilisation report per venue over a date range
- [ ] Structured logging with a correlation id surviving into the webhook path
- [ ] `/health` checking real dependencies
- [ ] CI running the test suite on every push
- [ ] Deploy API and web to a zero-cost host, seeded to the demo profile
- [ ] Five test logins: one per role plus a second venue admin at another venue
- [ ] `README.md` with `docker compose up` working in under 5 minutes, plus a
      blunt "Known Issues and What I Did Not Finish"
- [ ] `DECISIONS.md` — 8–15 entries, each with the choice, one rejected
      alternative, and the trade-off accepted
- [ ] `AI_LOG.md` — what was delegated, where the agent was wrong or naive,
      what was overridden and why
- [ ] `TIMELINE.md` — hour by hour, what was cut, why
- [ ] `ARCHITECTURE.md` stub sections completed
- [ ] 5-minute walkthrough recording

---

## Deliverables checklist

Tracked separately because they cut across phases.

- [ ] Public git repository with real commit history (a single squashed commit
      scores zero on process)
- [ ] Deployed frontend URL, live and seeded
- [ ] Deployed API URL, live and seeded
- [ ] `README.md`
- [ ] `ARCHITECTURE.md` — all 8 required sections
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

### Explicit non-goals for now

Tier 3 is deliberately unscheduled: live heatmap and WebSockets, natural
language booking, recurring bookings, waitlist with automatic promotion,
notifications. The brief is direct that a beautiful real-time calendar with a
race condition in the hold path scores below a plain submission with all of
Tier 1 correct. If time remains after P9, that is when this gets revisited —
and the choice gets recorded in `TIMELINE.md`.

---

## Progress log

### 2026-08-23 — P0 complete

Scaffolding and design only. No booking logic, no endpoints, no hold code — by
design, so that the commit timestamp on the concurrency strategy precedes any
implementation of it.

Built: pnpm workspace with three apps and three test packages; docker compose
standing up postgres, three identical API replicas, an nginx round-robin load
balancer on :8080, paygate on :9000 and web on :3000, with a healthcheck on
every service; nginx config; Dockerfiles on node:26-alpine; `CLAUDE.md`,
`PLAN.md`, `ARCHITECTURE.md` (Concurrency Strategy and Assumptions written in
full, six sections stubbed), `DESIGN.md`.

The only executable code written is a Nest bootstrap with a liveness-only
`/health`, a Fastify server with the same, and a placeholder Next page —
present because docker healthchecks need something to probe, and marked as
liveness-only rather than pretending to check dependencies they do not.

Verified: all 18 pinned package versions resolve on npm; `docker compose
config` validates.

Not done, deliberately: schema, endpoints, hold logic, UI.
