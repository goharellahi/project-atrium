# CLAUDE.md — permanent context for Project Atrium

Read this before touching anything. It is the standing contract for the
repository: the correctness properties, the mechanisms chosen to satisfy them,
the rules that must never be broken, and the pinned toolchain.

**Atrium** is a studio booking platform. Two kinds of inventory, and the
difference between them is the whole problem:

- **Rooms** — a time interval. Two active bookings for one room may never
  overlap. An interval exclusion problem.
- **Equipment** — a quantity over an interval. A venue owning 6 cameras may
  have 6 out at once but never 7, *at any instant*. Not a stock column.

The system is graded on correctness under concurrency, payment integrity
against a deliberately unreliable provider, and honest documentation — not on
feature count.

---

## Working Agreement

Follow this every phase, without being reminded.

### Git

**The human handles GitHub. Claude handles the local repository only.** Never
push, never open a PR, never merge, never touch a remote.

- **One short-lived branch per phase.** Create it at the start of the phase if
  it does not already exist:

  | Phase | Branch |
  | --- | --- |
  | P1 | `feat/p1-schema-auth` |
  | P2 | `feat/p2-booking-core` |
  | P3 | `feat/p3-payments-paygate` |
  | P4 | `feat/p4-concurrency-proof` |
  | P5 | `feat/p5-tests-observability` |
  | P6 | `feat/p6-frontend` |
  | P7 | `feat/p7-performance` |
  | P8 | `docs/p8-final` |

- **Never commit to `main`.** `main` is merged into only by the human, via PR.
- **Granular, conventional commits — one logical change each.** Schema,
  migration, auth and deploy config are four commits, not one.
  Format: `type(scope): subject`, e.g. `feat(db): booking exclusion constraint`.
- **Never squash, never rebase, never amend a pushed commit, never force push.**
  The brief grades commit history: *"a single squashed commit at the end scores
  zero on process."*
- **Keep the `Co-Authored-By` trailer.** The brief requires an `AI_LOG.md`;
  hiding authorship while writing that file would contradict it.

### Handoff protocol

Every phase ends with a block titled exactly **`ACTIONS FOR ME`**, containing
only what the human must do by hand, in order, ready to copy and paste. Nothing
explanatory goes inside it. Three parts, and any empty part is omitted
entirely:

1. **GIT** — the exact push command with the real branch name, then the exact
   `gh pr create` command with a filled-in title and body. PR title is
   conventional-commit style scoped to the phase. PR body is four sections of
   three lines or fewer: *What changed / Why it holds / What I cut / How to
   verify*. Write the body as a real heredoc, pasteable as-is.
2. **DASHBOARD** — numbered steps for Neon, Render, Vercel or GitHub settings,
   with exact field values. Assume the reader is in a hurry and will not read
   prose. State the order, and what proves each step worked.
3. **DECISIONS** — only things genuinely blocked on human judgement. If nothing
   is blocked, omit this part rather than inventing a question.

Above that block: **at most five lines of summary**. What is done, anything
that failed, what is next. Do not narrate what went right — the diff shows it.
Report contradictions with the brief, things that could not be verified, and
places where something was guessed. Those are the only things worth attention.

When the human pastes output back, **act on it — do not restate or grade it.**

---

## The six invariants

These are the non-negotiable correctness properties. They are tested directly,
with concurrent traffic, against the deployed instance. An invariant violation
costs more than a missing feature.

> **INV-1** Rooms never double book, under 5 or 200 concurrent requests.
>
> **INV-2** Equipment never oversells at any instant t — an interval question,
> not a total.
>
> **INV-3** A booking is charged at most once, regardless of client retries,
> webhook redelivery, or out-of-order arrival. Exactly-once effect from an
> at-least-once channel.
>
> **INV-4** Expired holds are unconfirmable. If a hold expires while payment is
> in flight and the payment then succeeds, the booking must NOT become
> CONFIRMED; the money is automatically refunded and the sequence recorded.
>
> **INV-5** Money is never silently lost. Every captured charge maps to exactly
> one CONFIRMED booking or exactly one refund, provable via a reconciliation
> endpoint returning zero discrepancies.
>
> **INV-6** Tenant isolation holds through any endpoint, including by direct
> valid UUID.

---

## Concurrency mechanisms — decided, do not re-litigate

Full reasoning is in `ARCHITECTURE.md`, "Concurrency Strategy". The summary
that matters when writing code:

### Rooms — PostgreSQL exclusion constraint

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE bookings ADD CONSTRAINT no_room_overlap
  EXCLUDE USING gist (room_id WITH =, slot WITH &&)
  WHERE (status IN ('HELD','PENDING_PAYMENT','CONFIRMED'));
```

`slot` is a `tstzrange` that **already includes the 15-minute turnaround
buffer**. The buffer is therefore enforced by the same constraint, not by
application logic. Never re-check the buffer in application code — one rule,
one place.

The rule lives in the database, so it holds identically across 1 or N API
replicas.

Rejected, and must stay rejected:

- **query-then-insert** — both racers pass the check, both insert.
- **in-process mutex or semaphore** — passes on one replica, fails on three.
- **SERIALIZABLE isolation** — correct, but produces retry storms at 200
  concurrent requests contending the same rows.

### Equipment — row lock plus max-concurrent-usage

An exclusion constraint cannot express "sum <= N". Two parts, both required:

1. `SELECT ... FROM equipment_types WHERE id = $1 FOR UPDATE` inside the hold
   transaction. A database row lock, so it serialises correctly across
   replicas.
2. A **max-concurrent-usage** check, not a naive SUM. A naive
   `SELECT SUM(qty) WHERE interval && requested` over-counts and produces false
   rejections. The correct computation is a sweep line over interval boundary
   events: `+qty` at each overlapping booking's start, `-qty` at its end,
   clipped to the requested window; order the events; take a running
   `SUM() OVER (ORDER BY event_time)`; the MAX of that running sum is peak
   concurrent usage. Admit the booking iff
   `peak + requested_qty <= owned_units * (1 + overbooking_buffer)`.

If you find yourself writing `SUM(quantity)` against overlapping bookings,
stop — that is the exact bug this design exists to prevent.

### Both mechanisms are enforced by PostgreSQL, not application memory

That is precisely why the strategy survives three replicas behind a load
balancer. Nothing that decides whether a booking is admissible may live in
process memory.

### Hold expiry

Exclusion constraints cannot carry a time-varying predicate, so an
expired-but-not-yet-swept `HELD` row still blocks a legitimate booking.
Mitigation is twofold and both halves are required:

- a background sweeper flipping `HELD` to `EXPIRED`, and
- an in-transaction expiry of stale holds for that room immediately before
  insert.

The sweeper alone is insufficient.

---

## Hard rules

1. **Never write `UPDATE bookings SET status` outside the state machine
   service.** Every transition goes through it. A status update scattered
   across a controller is a fail condition, not a style preference.
2. **Every transition writes exactly one AuditEvent** — actor, timestamp, from
   state, to state, reason. Not zero, not two. `audit_events` is append only:
   never updated, never deleted.
3. **An illegal transition returns 409, never 500.** A 500 means the state
   machine was surprised; being asked for an illegal transition is not a
   surprise, it is the normal case under concurrency.
4. **Every venue-scoped query derives `venue_id` from the auth token**, never
   from the request path or body. A `venue_id` in a URL is an input to
   authorise, never a source of truth. Bypassing this is one of the three hard
   caps on the total score.

---

## Pinned versions — do not upgrade or downgrade

All verified to resolve on npm.

| Area | Pin |
| --- | --- |
| Runtime | node 26 (`node:26-alpine`) |
| Package manager | pnpm workspaces |
| Language | typescript 6.0.3 (**not** 7.x) |
| API | @nestjs/core 11.2.1, @nestjs/common 11.2.1, @nestjs/cli 11.0.24, @nestjs/terminus 11.1.1 |
| Data | drizzle-orm 0.45.2, drizzle-kit 0.31.10, pg 8.23.0 |
| Web | next 16.3.2 (App Router), react 19.2.8, tailwindcss 4.3.3 |
| Payments mock | fastify 5.12.1 |
| Logging | pino 10.3.1 |
| Validation | zod 4.4.3 (v4 API) |
| Tests | vitest 4.1.11 |
| Infra images | postgres:16-alpine, nginx:alpine, grafana/k6 (docker image, not npm) |
| UI primitives | shadcn 4.19.0 (CLI), radix-ui 1.6.7, lucide-react 1.33.0 |

Tailwind 4 is configured **CSS-first via `@theme`** in
`apps/web/app/globals.css`. Do not generate a v3-style `tailwind.config.js`.

The Drizzle schema lives at `apps/api/src/db`. There is no separate db package.

---

## Layout

```
apps/api           NestJS — booking state machine, holds, payments, audit
apps/paygate       Fastify — the mock payment provider, chaos on
apps/web           Next.js App Router — operations console
apps/api/src/db    Drizzle schema and migrations
tests/concurrency  the mandatory 200-request proof
tests/authz        cross-venue isolation negative tests (INV-6)
tests/load         k6 scripts (run from the grafana/k6 image)
nginx/nginx.conf   round-robin LB on :8080 over api1/api2/api3
docker-compose.yml postgres + 3 API replicas + nginx + paygate + web
```

`docker compose up` must always stand up **three** API replicas behind the load
balancer. A correctness strategy that only works in one process is not a
correctness strategy, and one instance will never reveal that.

---

## Confidentiality

`.brief/` holds the assessment PDF, which is marked *Confidential — do not
redistribute*. This repository is public. `.brief/` is in `.gitignore` and must
never be committed. Do not quote the brief at length in committed files.

---

## Current phase

**P2 — booking core. Complete, including the 200-request concurrency proof
(delivered early; transcript in `ARCHITECTURE.md` Appendix A) and the seed
script (pulled forward from P7).**
Next: **P3 — paygate and payment integrity**, on `feat/p3-payments-paygate`.

See `PLAN.md` for the full phase list and the progress log.

> **Update `PLAN.md` after every phase.** Tick the boxes, and append a dated
> entry to the progress log saying what was built, what was cut, and anything
> that turned out to contradict an earlier decision. If the implementation ever
> contradicts the concurrency draft in `ARCHITECTURE.md`, do not quietly
> rewrite that document — leave both in and record what changed and why.
