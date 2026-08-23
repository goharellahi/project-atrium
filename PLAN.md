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

- [ ] Room availability query over a 7-day range
- [ ] Cross-venue search: city, capacity, amenity set, price ceiling and
      availability window, combined
- [ ] Operating-hours validation per day of week, in the venue's timezone
- [ ] Granularity: 30-minute increments, 1–8 hours, 1 hour to 90 days ahead
- [ ] State machine service — the **only** place `bookings.status` is written
- [ ] Every transition emits exactly one AuditEvent
- [ ] Illegal transition returns 409, never 500
- [ ] Hold creation in one transaction: in-transaction expiry of stale holds,
      then insert against the exclusion constraint (**INV-1**)
- [ ] Equipment admission: `SELECT ... FOR UPDATE` then the sweep-line
      peak-concurrent-usage check (**INV-2**)
- [ ] Overbooking buffer, equipment only; rooms reject non-zero with 422
- [ ] Background hold sweeper, HELD to EXPIRED
- [ ] Checkout re-arm: 10 minutes, at most twice, 30-minute lifetime cap
- [ ] Unit tests over the state machine, every failure edge
- [ ] **INV-6 negative suite** in `tests/authz`, using real UUIDs from the seed

---

## P3 — Paygate and payment integrity · `feat/p3-payments-paygate`

- [ ] `POST /paygate/charges`, `POST /paygate/refunds`, HMAC-signed webhooks
- [ ] All six chaos behaviours behind `PAYGATE_CHAOS=on`
- [ ] Idempotency-Key honoured on charges and refunds
- [ ] Webhook handler idempotent **on business effect**, via
      `payment_events UNIQUE (charge_id, event)` (**INV-3**)
- [ ] Bad signature → 401, logged, never processed
- [ ] Webhook for an unknown charge neither 500s nor is silently dropped
- [ ] Fast webhook path, no heavy work inline; choice explained
- [ ] Expired hold + successful payment → automatic refund, recorded (**INV-4**)
- [ ] Cancellation with data-driven refund policy; policy snapshot at
      confirmation; refunds idempotent
- [ ] Reconciliation endpoint proving **INV-5**, zero discrepancies

---

## P4 — The concurrency proof · `feat/p4-concurrency-proof`

- [ ] 200 concurrent requests, released together, through nginx on :8080
- [ ] Same room, same one-hour slot: exactly one success
- [ ] EquipmentType with exactly 3 units: at most 3 units reserved
- [ ] Every other request gets a clean 409 — not an error, not a duplicate
- [ ] Database re-read after the run, not just HTTP assertions
- [ ] Replica distribution recorded in the output
- [ ] Output pasted into `ARCHITECTURE.md`

---

## P5 — Tests and observability · `feat/p5-tests-observability`

- [ ] Unit tests over the refund calculator, every tier boundary
- [ ] One end-to-end happy path
- [ ] Correlation id surviving into the webhook path, proven by a test
- [ ] CI green with the full suite

---

## P6 — Frontend · `feat/p6-frontend`

- [ ] Console per `DESIGN.md` — rooms, equipment, pricing, policy
- [ ] Booking flow: search, hold, checkout, confirmation
- [ ] Revenue and utilisation report per venue over a date range

---

## P7 — Performance · `feat/p7-performance`

- [ ] One seed script, two profiles: `--profile=demo`, `--profile=full`
- [ ] Deterministic non-overlapping slot generation (Assumption 4)
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
