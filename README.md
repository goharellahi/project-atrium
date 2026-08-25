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

*Kept blunt and current. A known, documented bug costs almost nothing; an
undocumented one found in review costs a great deal.*

**Current phase: P8 phase A complete — the Tier 1 correctness gaps, in two
passes.** The second pass found that the payment provider had no memory across
a restart, which made INV-5 undemonstrable rather than merely inconvenient; it
has a durable ledger now, and `tests/e2e/src/provider-restart.e2e.test.ts` pays
a booking, restarts the container and refunds it.
 The
overbooking buffer a venue admin may set is now settable, and proven end to end
through the endpoints rather than around them; equipment line items are
reachable by the only role that books; a room can be read by its own id; and
every seeded settled booking carries the cancellation policy that was live when
it confirmed, so the policy-as-data guarantee is visible on demo data instead of
merely true in code. The Tier 3 cut is withdrawn — the deadline was extended and
the whole brief is in scope.

P7 before it delivered the operations console: six screens on `apps/web` —
sign-in with the seeded role logins on the page, cross-venue search, room
availability and hold, checkout with a live hold countdown and the chaotic
payment path, my bookings with cancellation, and a read-only venue view.

Building it found **an API defect that had been there since the endpoint was
written**: `GET /search?amenity=…` answered 500 for every input, because Drizzle
expanded the array into one placeholder per element and Postgres was handed
`('wifi')::text[]`. It is fixed here, and `apps/api/src/search/search.amenity.test.ts`
pins it against a real database — a unit test on the query builder would have
passed either way, which is why it survived six phases with no test on it.

The four endpoints the brief benchmarks were run against 250,000 bookings
through the load balancer. **Three of the four p95 targets are met; create-hold
misses at 536 ms against 250 ms** — and the cause is measured rather than
guessed. Numbers, machine spec, `EXPLAIN` before and after, and the elimination
that found the real bottleneck are in [LOAD_TEST.md](LOAD_TEST.md).

Three indexes were added because a plan changed, two deleted, and **two built,
measured and rejected** — one of which turned out never to be used as an index
at all and to be supplying a planner *estimate*. That finding is in
[ARCHITECTURE.md](ARCHITECTURE.md) §5, along with §8, which grounds "what breaks
at 100x" in plans captured by widening real queries until they saw that density.

P5 found seven defects in code earlier phases had called complete, including one
that meant the payment path had never worked at all. P6 found four more —
including a seed whose row counts were all correct and whose *distribution* made
the benchmark meaningless. They are itemised in the P5 and P6 entries of
[PLAN.md](PLAN.md), which is the honest record of this project.

The API is deployed on Render's free tier and the console on Vercel; both answer
`/health`. **The deployed database is not seeded** — seeding runs against the
local compose stack.

### Not built yet

Everything below is scheduled, not abandoned. See [PLAN.md](PLAN.md).

- **The venue administration SCREENS.** The API half landed in P8 —
  `PATCH /venues/settings` writes the overbooking buffer, `POST`/`PATCH
  /venues/rooms` and `/venues/equipment-types` manage inventory, all
  VENUE_ADMIN-only and venue-scoped from the token, all probed by the INV-6
  suite. There is no console for them yet; that is Tier 2.
- **Revenue and utilisation page.** The API half landed in P6 and answers; there
  is no screen rendering it. Outside P7's six screens.
- **Two of the four API shapes the console worked around are still open.** There
  is no refund preview, so `apps/web/lib/refund.ts` re-implements the arithmetic
  and labels it a quote; and the API sets no CORS headers, which is why every
  call the console makes is server-side. The other two closed in P8:
  `GET /rooms/:id` exists, and `GET /rooms/:id/equipment-types` is the
  customer-readable catalogue, so the room screen no longer carries the room on
  its querystring and no longer asks a customer to paste a UUID.
- **Create-hold's p95 is missed, and the miss is deliberate.** 536 ms against a
  250 ms target. The endpoint answers in 47 ms p95 in isolation, so it is starved
  rather than slow: three Node replicas pinned at one core each on a four-core
  laptop, with the load generator on the same box. Two candidate causes were
  tested and both were wrong — not the database, not the connection pool.
  Published as a failing threshold rather than re-run in isolation until it
  passes. [LOAD_TEST.md](LOAD_TEST.md) §5 has the elimination;
  [DECISIONS.md](DECISIONS.md) 12 has why it was accepted rather than fixed.

### Tests that do not exist yet, and should

Stated separately from the above because these are gaps in *evidence*, not in
features — the more expensive kind to leave undocumented.

- **CI runs 69 of 121 tests.** The offline suites and the route census run on
  every push; the concurrency proof, the tenant-isolation probes, the
  payment-integrity suite and the soak all need a compose stack CI does not
  stand up. They run locally via `pnpm proof`, `pnpm authz`, `pnpm e2e` and
  `pnpm soak`.
- **The state machine's runtime edges are covered end to end, not per edge.**
  The transition *table* is asserted exhaustively offline; the row lock, the
  one-audit-row-per-transition rule and the 409 body are exercised by the proof
  and the e2e suite rather than by a dedicated unit suite. Those need a real
  Postgres.
- **The benchmark is one machine's.** Every number in
  [LOAD_TEST.md](LOAD_TEST.md) comes from a single four-core laptop with the
  load generator co-resident, over 60-second runs. The saturation analysis is
  sound on that box and untested on any other, and nothing there says what the
  gist index costs to maintain under sustained write load over days.

### Known limitations of what *is* built

- **The deployed instance runs one API replica, not three.** Free tiers do not
  stretch to three. The three-replica configuration is local-only, via
  `docker compose`, which is where the concurrency proof runs. The correctness
  argument does not depend on replica count — the mechanisms are in Postgres —
  but the deployment does not itself demonstrate that.
- **Availability is advisory, deliberately.** `GET /rooms/:id/availability` can
  offer a slot that a hold then rejects, because someone took it in between.
  This is not a defect to be engineered away — it is why the hold path does not
  consult it. It does *not* offer a slot that could never have worked: until P8
  it enumerated from the venue's opening time regardless of the hour, so a range
  starting today listed slots that had already happened and clicking the first
  one answered "must start at least 60 minutes ahead". Advising the impossible
  is a different and worse thing than losing a race.
- **Paygate keeps a durable ledger, and it did not until P8.** It held every
  charge in memory, which meant Render's free tier — asleep after fifteen idle
  minutes — forgot everything it had captured, and the next refund answered
  `404 unknown_charge`. That is not a demo-data quirk: INV-5 cannot be
  demonstrated against a provider that cannot remember what it captured, and the
  API's poll-the-provider recovery path could only ever be told "never heard of
  it". Paygate now has its own `paygate_*` tables, its own migrations, no import
  and no foreign key across the boundary, and the seed registers its charges
  with them — so seeded and live bookings both refund for real. The reversal,
  including what it costs, is [DECISIONS.md](DECISIONS.md) 13.
- **Paygate shares the API's Postgres instance, and that is a cost constraint
  rather than coupling.** The free tier gives one instance. Everything that
  would make it coupling is absent and checkable: no import from
  `apps/api/src/db`, no Drizzle dependency at all, no foreign key crossing in
  either direction, a separate `PAYGATE_DATABASE_URL`, and
  `paygate_charges.reference` holding the booking id as an opaque string exactly
  as a real provider's `metadata.reference` does. Pointing that variable at a
  different database is the whole of what separating them takes.
- **Re-seeding leaves orphaned rows in Paygate's ledger.** The seed truncates
  the API's tables and mints new booking ids, so the previous run's charges stay
  at the provider with nothing pointing at them. Left alone deliberately: a real
  provider does not forget because a merchant reset their own database, and a
  destructive "clear the provider" endpoint would be a worse thing to own.
- **The 15-minute turnaround applies to rooms only.** Equipment uses raw
  `starts_at`/`ends_at`, not the buffered `slot` column. A tripod handed back at
  14:00 is available at 14:00. ARCHITECTURE.md, Assumption 7.
- **Four routes are cross-venue by design.** `GET /search`,
  `GET /rooms/:id`, `GET /rooms/:id/availability` and
  `GET /rooms/:id/equipment-types` return catalogue data — name, capacity,
  amenities, price, hourly rate, units owned, free/busy — and no bookings,
  customers, revenue or live utilisation. They are listed in the census as
  `CROSS_VENUE_BY_DESIGN` with a written reason each, and the census requires
  every one of them to *also* be probed: the assertion is not a denial, it is
  that the response body carries only inventory. ARCHITECTURE.md, Assumption 8.
- **A payment cannot be re-attempted after a decline.** The charge idempotency
  key is derived from the booking id, so `FAILED` is terminal and the customer
  books again. That matches the brief's own state machine, which gives `FAILED`
  no outgoing edge. DECISIONS.md, entry 1.
- **Paygate keeps its state in memory.** Restarting it — routine on a sleeping
  free tier — forgets every charge. The API treats “the provider has never heard
  of this charge” as an answer and lets the hold expire; no money moved, so
  nothing is lost.
- **A webhook refused during a cold start is lost permanently.** Paygate does
  not retry a delivery, by design — a retry would be a second source of
  duplicates on top of the specified 30%. The API therefore polls the provider
  for charge and refund outcomes it was never told about
  (`CHARGE_POLL_AFTER_SECONDS`, `REFUND_POLL_AFTER_SECONDS`). Found by the P5
  soak, which lost six refunds to the 2% corrupt-signature branch before this
  existed.
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
