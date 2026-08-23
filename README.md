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
| [ARCHITECTURE.md](ARCHITECTURE.md) | Concurrency strategy, assumptions, and the design record |
| [CLAUDE.md](CLAUDE.md) | Invariants, hard rules, pinned versions, working agreement |
| [PLAN.md](PLAN.md) | Phases and progress log |
| [DESIGN.md](DESIGN.md) | Visual direction for the console |

---

## Deployed

| | URL |
| --- | --- |
| API | https://atrium-api-3p3j.onrender.com |
| Console | https://project-atrium.vercel.app |

```bash
curl -s https://atrium-api-3p3j.onrender.com/health
```

Two things a reviewer should know before trying these:

- **The API sleeps after 15 minutes idle.** The first request wakes it and takes
  30–60 seconds. That is Render's free tier, not the application.
- **The database is empty.** The seed script is P7, so there are no test logins
  yet. `POST /auth/register` works today and creates a CUSTOMER; the five
  role-based logins the brief asks for arrive with the seed.

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

*Kept blunt and current. A known, documented bug costs almost nothing; an
undocumented one found in review costs a great deal.*

**Current phase: P2 complete — booking core, seed, and the concurrency proof.**

The API is deployed on Render's free tier and the console on Vercel; both answer
`/health`. **The deployed database is not seeded** — seeding runs against the
local compose stack. Registering through `POST /auth/register` works on the
deployed instance today.

### Not built yet

Everything below is scheduled, not abandoned. See [PLAN.md](PLAN.md).

- **Payments.** `apps/api/src/payments/payment-provider.ts` defines the
  interface and binds a provider that throws. Paygate itself boots and answers
  `/health`; charges, refunds, webhook delivery and all six chaos behaviours are
  P3, on a separate branch.
- **Refund amounts.** `POST /bookings/:id/cancel` changes state and returns
  `refund: null`. What the customer is owed is computed against the policy
  snapshot in P3; returning a placeholder number would be worse than none.
- **Frontend.** `apps/web` is a placeholder page. P6.
- **Venue administration.** Nothing writes `venues.overbooking_buffer_pct`, so
  the room-side 422 for a non-zero buffer has no way to be triggered yet. P6.
- **Indexing.** No indexing pass has been done and no `EXPLAIN ANALYZE`
  captured. The P2 queries are written for correctness, not for plans. P7.

### Tests that do not exist yet, and should

Stated separately from the above because these are gaps in *evidence*, not in
features — the more expensive kind to leave undocumented.

- **State machine unit tests.** The transition table is exercised end to end by
  the proof and by manual probes, but there is no per-edge suite. Cut for time
  in P2, scheduled for P5.
- **The INV-6 negative suite.** `tests/authz` is still a stub. Isolation was
  verified by hand — a `VENUE_ADMIN` at venue B requesting a booking at another
  venue by valid UUID gets 404, and `GET /bookings` totals differ per admin —
  but *verified by hand* is not *tested*. P5.
- **The proof has only been run against the `demo` profile** (25k bookings). It
  has not been run against `full` (250k), where the gist index is doing
  materially more work.

### Known limitations of what *is* built

- **The deployed instance runs one API replica, not three.** Free tiers do not
  stretch to three. The three-replica configuration is local-only, via
  `docker compose`, which is where the concurrency proof runs. The correctness
  argument does not depend on replica count — the mechanisms are in Postgres —
  but the deployment does not itself demonstrate that.
- **Availability is advisory, deliberately.** `GET /rooms/:id/availability` can
  offer a slot that a hold then rejects, because someone took it in between.
  This is not a defect to be engineered away — it is why the hold path does not
  consult it.
- **The 15-minute turnaround applies to rooms only.** Equipment uses raw
  `starts_at`/`ends_at`, not the buffered `slot` column. A tripod handed back at
  14:00 is available at 14:00. ARCHITECTURE.md, Assumption 7.
- **`GET /search` is cross-venue by design and is not tenant-scoped.** It
  returns inventory — name, capacity, amenities, price — and no bookings,
  customers or occupancy. ARCHITECTURE.md, Assumption 8.
- **The 15-minute turnaround gap is a platform constant, not per-venue.** It is
  baked into a generated column, and a generated column cannot reference
  another table. Reasoning in ARCHITECTURE.md, Assumption 5.
- **On Render, migrations run in-process at boot** (`RUN_MIGRATIONS_ON_BOOT=true`),
  not as a pre-deploy step and not via a shell command. The free tier rejects
  `preDeployCommand` outright, and `dockerCommand` is not run through a shell,
  so `sh -c "a && b"` exits 127. Ordering is unchanged — the server does not
  bind until migrations succeed, and a failure rejects the boot. Safe only
  because that service runs a single instance; `docker compose` leaves the flag
  off and uses a separate one-shot `migrate` service, because three replicas
  each migrating on boot would race.
- **`migrate` has no healthcheck** while every other compose service does. It
  is a one-shot container that exits; the replicas depend on it with
  `condition: service_completed_successfully`, which is the meaningful check.
- **`output: 'standalone'` is scoped to the Docker build.** It exists so the
  runtime image can `node server.js` without pnpm. Vercel does its own
  packaging, so the flag is disabled when `VERCEL` is set. `apps/web/vercel.json`
  deliberately carries no `installCommand` or `buildCommand`: Vercel detects the
  pnpm workspace from the repo root itself, and overriding install broke its
  Next.js version detection.
- **Local Node is 22, the pin is 26.** Containers use `node:26-alpine`, so
  compose and CI are on the pinned runtime. Only host-side `pnpm` commands run
  on 22.
