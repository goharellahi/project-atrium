# Project Atrium

A booking platform for a network of creative studios. Two kinds of inventory,
and the difference between them is the whole problem:

- **Rooms** are booked for a time interval. A room is a single physical space,
  so two active bookings for it may never overlap. An interval exclusion
  problem.
- **Equipment** is booked as a quantity over an interval. A venue owning 6
  cameras may have 6 out at once but never 7, *at any instant*. Not a stock
  column.

The system is built for correctness under concurrency, payment integrity
against a deliberately unreliable provider, and honest documentation.

| Document | What is in it |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | ERD, state machine, concurrency strategy, payment integrity, 100x, stack justification |
| [AI_LOG.md](AI_LOG.md) | Where the agent was wrong, and what replaced its answer |
| [TIMELINE.md](TIMELINE.md) | Hour by hour from commit timestamps; what was cut and reversed |
| [DECISIONS.md](DECISIONS.md) | Numbered decisions, including the ones reversed |
| [LOAD_TEST.md](LOAD_TEST.md) | The four benchmarked endpoints, and the p95 that is missed |
| [CLAUDE.md](CLAUDE.md) | Invariants, hard rules, pinned versions, working agreement |
| [PLAN.md](PLAN.md) | Phases and progress log |
| [DESIGN.md](DESIGN.md) | Visual direction for the console |

---

## Deployed

| | URL |
| --- | --- |
| API | https://atrium-api-3p3j.onrender.com |
| Paygate | https://atrium-paygate.onrender.com |
| Console | https://project-atrium.vercel.app |

```bash
curl -s https://atrium-api-3p3j.onrender.com/health
curl -s https://atrium-paygate.onrender.com/health
```

Paygate's `/health` reports its own configuration, which is the quickest way to
see what the deployed provider will and will not do:

```json
{"status":"ok","service":"paygate","chaos":"on","seed":"atrium-render",
 "callback_url_configured":true,"test_endpoints":"off"}
```

`test_endpoints: off` is deliberate and permanent — `NODE_ENV=production` is
baked into Paygate's Dockerfile and it refuses to register `/paygate/_test/*`
there regardless of the flag, so the deployed instance is the chaotic provider
the brief describes and deterministic scenarios stay local.

`callback_url_configured: true` says only that a callback URL is set, not that
it points at this API — the value is not exposed, and the deployed database is
unseeded, so the round trip has never actually run on the deployed pair. The
webhook path is proven locally by `pnpm e2e`, against a stack where it does.

Four things a reviewer should know before trying these:

- **Both services sleep after 15 minutes idle.** The first request wakes them
  and takes 30–60 seconds. That is Render's free tier, not the application.
- **The deployed database is not seeded.** `POST /auth/register` works and
  creates a CUSTOMER. The seed exists and runs against the local stack
  (`pnpm seed`); it has not been run against the free-tier database.
- **Paygate runs with chaos ON, as the brief specifies.** A `502` from
  `POST /bookings/:id/pay` is its 10% transient-failure branch, not a bug —
  retry the same booking and it cannot be charged twice, because the idempotency
  key is derived from the booking id. A confirmation may also take a few seconds
  to appear: the webhook is asynchronous, and 5% of deliveries are deliberately
  parked for 60–90 seconds.
- **`/paygate/_test/*` does not exist on the deployed instance.** Paygate
  refuses to register its control surface when `NODE_ENV=production`. Forcing a
  specific scenario is a local capability; see `pnpm e2e`.

The deployed API runs **one** replica. The three-replica configuration is local
only — see [Why three replicas](#why-three-replicas).

---

## Running it

Requires Docker. Nothing else.

```bash
cp .env.example .env
```

```bash
docker compose up --build
```

That stands up:

| Service | Port | What it is |
| --- | --- | --- |
| `nginx` | 8080 | Round-robin load balancer — **use this**, not a replica directly |
| `api1` `api2` `api3` | 3001 (internal) | Three identical API replicas |
| `migrate` | — | One-shot; runs to completion before any replica starts |
| `postgres` | 5432 | postgres:16-alpine |
| `paygate` | 9000 | The mock payment provider |
| `web` | 3000 | Next.js console |

Verify it came up:

```bash
curl -s localhost:8080/health
```

### Seeding

One script, two profiles, one code path. `demo` fits a 500 MB free database
(≈15 MB measured); `full` is the 250,000-booking set for the P7 load work.

```bash
docker compose exec api1 node dist/db/seed.js --profile=demo
```

```bash
docker compose exec api1 node dist/db/seed.js --profile=full
```

It prints five test logins — one per role plus a **second `VENUE_ADMIN` at a
different venue**, which is what INV-6 needs to be demonstrable at all — and a
known-empty room and time window for probing by hand. Every seeded account
shares the password the script prints.

### The concurrency proof

The mandatory 200-request proof. It needs the compose stack up (three replicas
behind nginx); it does **not** need the seed, because it creates its own
fixtures.

```bash
pnpm proof
```

It fires 200 requests, released together, at one room and one one-hour slot,
and separately at an equipment type owning exactly 3 units across 200 distinct
rooms. It asserts exactly one room booking, at most 3 equipment units, a clean
409 for every loser, zero 5xx, that all three replicas served traffic, and then
**re-reads the database directly** to confirm the rows agree with the
responses.

Transcript of the current run is in
[ARCHITECTURE.md](ARCHITECTURE.md#appendix-a--concurrency-proof-output),
Appendix A.

### Endpoints as of P2

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/auth/register` `/auth/login` | Registration always creates a CUSTOMER |
| `GET` | `/auth/me` | |
| `GET` | `/search` | Cross-venue: city, capacity, amenities, price ceiling, availability window |
| `GET` | `/rooms/:id/availability` | Free slots over a range. Advisory — see below |
| `POST` | `/bookings/hold` | The core. 201, or 409 from `no_room_overlap` / equipment capacity |
| `POST` | `/bookings/:id/checkout` | Re-arms the hold. At most twice, 30-minute lifetime cap |
| `POST` | `/bookings/:id/cancel` | State only; refund amounts are P3 |
| `GET` | `/bookings` `/bookings/:id` | Scope derived from the token, never from the request |

`GET /rooms/:id/availability` is **advisory**. It reports what was free when it
ran, and the hold path never consults it — a design in which that read gated the
write would have a race in it by construction. `no_room_overlap` decides.

### Why three replicas

Because a correctness strategy that only works inside a single process is not a
correctness strategy, and one instance will never reveal that. Every invariant
must hold with requests distributed across all three.

Both concurrency mechanisms are enforced by PostgreSQL — an exclusion
constraint for rooms, a row lock plus a peak-concurrent-usage check for
equipment — so neither is aware of how many API processes exist. Anything
living in application memory (a mutex, a semaphore, an in-process map of held
slots) would pass on one instance and fail on three.

Send load to `:8080`. Talking to `api1` directly proves nothing.

---

## Layout

```
apps/api           NestJS — booking state machine, holds, payments, audit
apps/api/src/db    Drizzle schema and migrations
apps/paygate       Fastify — the mock payment provider
apps/web           Next.js App Router — operations console
tests/concurrency  the 200-request proof
tests/authz        cross-venue isolation negative tests
tests/load         k6 scripts (run from the grafana/k6 image)
nginx/nginx.conf   round-robin LB over the three replicas
```

---

## Known Issues and What I Did Not Finish

*Blunt and current. A known, documented bug costs almost nothing; an
undocumented one found in review costs a great deal. Everything below is either
measured or reproduced, not suspected.*

**Status: complete and submitted.** Tier 1 and Tier 2 are built, deployed and
verified. Tier 3 is not built, and that was a choice — see `TIMELINE.md`.

### Deployment and infrastructure

- **The deployed API runs a single instance.** The three-replica configuration is
  `docker-compose.yml` only, and that is where the concurrency proof runs. The
  property the whole design turns on — that the invariants hold across replicas
  because Postgres enforces them rather than application memory — is therefore
  *demonstrated* locally and only *asserted* in production. Render's free tier
  does not do horizontal scaling.
- **Both services sleep after 15 idle minutes.** The first request wakes them and
  takes 30–60 seconds. That is the free tier, not the application, but a reviewer
  who does not know it will read the first page load as broken.
- **Render's free Postgres expires 30 days after creation.** After that the
  deployed instance has no database and every authenticated route fails. This one
  was created on 23 August 2026.
- **The API's outbound hop to Paygate is rate-limited by the platform edge.**
  Rapid retries return plain-text `429 Too Many Requests`, which the API wraps as
  a 502 carrying `provider_status: 429`. It is transient — one attempt succeeds
  roughly a minute later — and the console now says so specifically instead of
  presenting it as the provider's chaotic-failure branch. Paced payments are
  unaffected; hammering the pay button is not.
- **Re-seeding orphans the previous run's charges in Paygate's ledger.** The seed
  truncates the API's tables and registers fresh charges; the old ones remain on
  the provider side with no booking to match, and reconciliation correctly reports
  them as `capture_without_confirmation`. They are artefacts of re-seeding, not
  lost money. The workaround is to re-seed Paygate's database too. There is no
  generation marker that would make a stale charge self-identifying, and there
  should be.

### Testing and CI

- **CI runs the offline suites only — 96 tests.** `pnpm authz`, `pnpm proof` and
  `pnpm e2e` all need the compose stack, so **"CI green" currently means the unit
  tests pass**, while the tenant-isolation suite, the 200-request proof and the
  payment end-to-end are exactly what a regression would break silently. A
  compose-backed job is item 5 in `ARCHITECTURE.md` §9, and was deliberately not
  attempted in the final phase rather than half-done.
- **The concurrency proof asserts a three-replica topology and fails without
  one.** Correct behaviour, and worth knowing before running it: the invariant
  assertions themselves pass against a single replica, but the run is not
  certified, because a single-replica pass does not demonstrate the claim.
- **`create-hold` misses its p95 target: 536 ms against 250 ms.** Published as a
  failing threshold rather than re-run in isolation until it passed. The endpoint
  answers in 47 ms p95 on its own, so it is starved rather than slow — three Node
  replicas pinned at one core each on a four-core laptop, with the load generator
  on the same box. `LOAD_TEST.md` §5 has the elimination; `DECISIONS.md` 12 has
  why it was accepted rather than fixed.
- **Reconciliation takes 5.2 seconds at 250,000 bookings** and degrades badly —
  `ARCHITECTURE.md` §8. It is INV-5's only evidence, which makes it the slow query
  that matters most.

### Not built

- **Tier 3 entirely** — recurring bookings, waitlists, dynamic pricing. Not
  started. The reasoning, and what the time went to instead, is in `TIMELINE.md`.
- **The revenue and utilisation page.** The API exists and is one of the four
  endpoints benchmarked in `LOAD_TEST.md`; no screen renders it. Skipped in the
  final phase under an explicit time bound rather than rushed.
- **A compose-backed CI job.** Same call, same reason.
- **A customer-facing venue browse.** Search is room-first; no page lists a venue
  and its rooms together.

### Known limitations of what *is* built

- **The console shows a venue as a short id, not a name.** `/auth/me` returns
  `venueId` only, and the sole endpoint exposing a venue's name is the revenue
  report, which runs four aggregates and demands a date range. Spending that on a
  sidebar label was the wrong trade; "a missing read endpoint" is the honest
  description.
- **`GET /admin/reconciliation` requires `from` and `to`.** Omitting them returns
  422 with `expected date, received Date` — a zod-v4 phrasing quirk for a missing
  required parameter rather than a bug, and it reads like one.
- **The equipment sweep line is unbounded, in two different query plans**, and it
  runs inside the hold transaction while holding `FOR UPDATE`. Measured, with both
  plans, in `ARCHITECTURE.md` §8.
- **`hashtext(room_id)` can collide**, so two unrelated rooms may serialise
  against each other on the same advisory lock. Invisible until it is a latency
  mystery.
- **Building natively rather than through Docker needs two manual copies.** `tsc`
  and `nest build` do not copy `.sql` files, so `dist/db/migrations` and
  `dist/ledger/migrations` have to be copied by hand. Both Dockerfiles do it;
  only the Docker path is supported, and this is why.
- **The console's client-side behaviour is unverified against the deployed URL
  from CI.** It was verified in a real browser against the same build locally,
  and the deployed screens were verified server-rendered per role. Stated because
  the distinction is real.
