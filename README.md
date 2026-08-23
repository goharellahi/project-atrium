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

**Current phase: P1 complete — schema, constraints, auth, deploy skeleton.**

### Not built yet

Everything below is scheduled, not abandoned. See [PLAN.md](PLAN.md).

- **Booking endpoints.** No hold, availability, search or cancellation
  endpoints exist. P2.
- **Paygate.** The service boots and answers `/health`; charges, refunds,
  webhook delivery and all six chaos behaviours are P3.
- **The concurrency proof.** The exclusion constraint is verified by hand
  against a real Postgres (transcript in ARCHITECTURE.md §3), but that is
  single-connection evidence. The 200-request, three-replica proof is P4.
- **Frontend.** `apps/web` is a placeholder page. P6.
- **Seed script.** Neither profile exists yet, so nothing is seeded. P7.

### Known limitations of what *is* built

- **The deployed instance runs one API replica, not three.** Free tiers do not
  stretch to three. The three-replica configuration is local-only, via
  `docker compose`, which is where the concurrency proof runs. The correctness
  argument does not depend on replica count — the mechanisms are in Postgres —
  but the deployment does not itself demonstrate that.
- **The 15-minute turnaround gap is a platform constant, not per-venue.** It is
  baked into a generated column, and a generated column cannot reference
  another table. Reasoning in ARCHITECTURE.md, Assumption 5.
- **On Render, migrations run inside the start command, not as a pre-deploy
  step.** `preDeployCommand` is a paid-tier feature — a free service is
  rejected at blueprint validation. Chaining gives the same ordering (the
  server never binds until migrations succeed, and a failure exits non-zero so
  the deploy fails). It is safe only because that service runs a single
  instance; `docker compose` keeps a separate one-shot `migrate` service
  precisely because three replicas would race.
- **`migrate` has no healthcheck** while every other compose service does. It
  is a one-shot container that exits; the replicas depend on it with
  `condition: service_completed_successfully`, which is the meaningful check.
- **Local Node is 22, the pin is 26.** Containers use `node:26-alpine`, so
  compose and CI are on the pinned runtime. Only host-side `pnpm` commands run
  on 22.
