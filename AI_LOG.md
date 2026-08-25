# AI_LOG.md

## Tools, and how they were used

**Claude Code (Claude Opus 5)** wrote almost all of the implementation. It ran in
a terminal against this repository, with `CLAUDE.md` as standing context: the
invariants, the concurrency mechanisms already decided, the hard rules, the
pinned versions.

**A second Claude session**, in a browser, was used for the things the coding
agent should not grade itself on — planning each phase, writing the prompts that
started it, and reviewing the diffs it produced. That separation is why several
entries below exist: a few of these defects were found because the reviewing
session was asked "what did this get wrong", not because the implementing session
volunteered it.

**Every commit carries `Co-Authored-By: Claude Opus 5`.** That was deliberate and
it survived a rebase that re-authored the whole P7 branch. The brief asks for this
document; writing it while stripping the trailer from the history it describes
would be incoherent. The trailer is also the only machine-checkable claim in this
file — `git log --format='%(trailers)'` either agrees with this paragraph or it
does not.

## What this file is

Not a list of tasks delegated. A list of places the agent was **wrong, naive, or
confidently incorrect**, and what replaced its answer. The brief is explicit that
reporting zero mistakes is disqualifying, and it is right to be: a 141-commit
project built this way with no agent errors would mean nobody read the output.

Ordered roughly by how much the mistake cost.

---

## 1. The entire payment path was inert, and the phase that built it reported complete

**Where:** `apps/api/src/db/schema.ts` — `webhook_deliveries.raw_body`
**Found:** P5, by running the stack. P4 had declared the payment path done.

The column was typed `jsonb` and the handler wrote the raw request body into it
as a string. Drizzle hands a string to the driver as a jsonb literal and parses
jsonb back on read, so the column returned an **object**, and
`JSON.parse(String(object))` threw `"[object Object]" is not valid JSON` on
**every single delivery**.

Nothing was ever confirmed. No refund was ever issued. Three replicas retried the
same six rows every ten seconds, forever. INV-3, INV-4 and the money half of
INV-5 were arguments in code comments and nothing else.

**Why the first answer was wrong:** `jsonb` looks obviously right for a column
holding a JSON body. It is obviously wrong for a column holding *the exact bytes
an HMAC was computed over*, because jsonb normalises key order and number
formatting — the precise things a signature covers. The agent's own comment above
the column said the raw bytes must be preserved, and then chose `jsonb` anyway.
The reasoning was present and the code contradicted it.

**Replaced with:** `text`, which it should always have been. The deeper fix was
process rather than type: P4's "complete" meant "the code exists", and P5's meant
"the stack ran". Only the second kind is worth reporting.

---

## 2. A provider that remembers nothing is not a provider that captured nothing

**Where:** the payment poll path, `apps/api/src/payments/`
**Found:** P8, by being challenged on Paygate's durability rather than by a test.

When the provider answered **404 — never heard of this charge** — the poll read
that as *nothing was captured* and stopped tracking it. A comment explained the
reasoning and the reasoning sounded fine.

It is wrong in a specific way: "the provider has no record" is a claim about the
provider's *memory*; "no money moved" is a claim about the *world*. Treating the
first as evidence for the second assumes the provider's memory is complete, which
is the exact assumption a payment integrity model exists to refuse.

It was not hypothetical. Paygate's ledger was in memory, and a free-tier restart
— every fifteen idle minutes — emptied it. The provider forgot charges it had
really captured, answered 404, and the API concluded there was no money. **No
reconciliation class disagreed**, because all eight were framed as "our row says
X, the provider says Y", and a forgotten charge produces no Y.

**Replaced with:** a durable Paygate ledger, plus a ninth class,
`charge_accepted_not_settled`, framed on our own state so it survives a provider
that answers nothing. Full write-up in ARCHITECTURE.md §4.

---

## 3. Paygate's ledger held in memory, which made INV-5 undemonstrable

**Where:** `apps/paygate/`
**Found:** P8, only after being asked directly whether a restart loses the ledger.

P3 decided a test double needs no database. That was right about INV-3 —
idempotency within a run works fine from a `Map` — and wrong about INV-5, which
is a claim about money surviving. The agent defended the original decision when
first questioned, and it took pointing at the free tier's fifteen-minute sleep to
move it.

**Replaced with:** `paygate_*` tables, own migrations, no shared connection and
no foreign key across the boundary. Recorded as a reversal in DECISIONS.md 13
rather than edited to look like the original plan.

**Worth noting about the failure mode:** this one was not found by a test and
could not have been. Every suite passes against an amnesiac provider, because
every suite runs inside one uninterrupted process lifetime.

---

## 4. A bare JS array in a Drizzle `sql` template — 500s that read like INV-2 violations

**Where:** `apps/api/src/search/search.service.ts`, and earlier
`bookings/equipment-availability.ts`
**Found:** P7, in the first minute of pointing a UI at real data.

```ts
sql`${rooms.amenities} @> ${query.amenity}::text[]`   // wrong
```

Drizzle expands a JS array in a `sql` template into **one placeholder per
element**, so this compiled to `@> ($1)::text[]` bound to the string `wifi`, and
Postgres answered `22P02 malformed array literal: "wifi"`. `GET /search?amenity=…`
returned 500 for every input from the day it was written until P7.

The same trap had already bitten the *hold* path in P2, where it produced 500s on
every equipment request. In the concurrency proof those are far worse than a
search failure: a 500 during a 200-request run is indistinguishable from a
genuine INV-2 violation until you read the logs.

**Why it survived six phases:** nothing tested it. The endpoint's coverage
exercised city, capacity and price. There is now a database-backed suite
(`search.amenity.test.ts`) whose six cases all fail with the original binding —
verified by reverting the fix, not assumed.

**What makes it instructive:** the repository already contained `uuidArray()`,
written in P2 with a doc comment describing this exact failure. The knowledge was
present, written down, twenty lines away in a sibling module, and not applied.

---

## 5. `ends_at + interval` is STABLE, not IMMUTABLE

**Where:** migration `0001_constraints.sql`
**Found:** P1, by Postgres refusing to run it.

```
ERROR:  generation expression is not immutable
```

The design document specified `tstzrange(starts_at, ends_at + interval '15
minutes')` as a `STORED` generated column. `timestamptz + interval` depends on
the session `TimeZone` setting, so Postgres classifies it STABLE and refuses it
in a stored generation expression. Fixed by pinning the arithmetic to UTC.

Both versions are left in ARCHITECTURE.md §3 rather than quietly corrected —
the wrong one is the more useful of the two.

---

## 6. `drizzle-kit` wanted to `DROP COLUMN slot`

**Where:** generated migration `0002`
**Found:** P1, by reading the generated SQL before trusting it.

The generated migration dropped and recreated `slot`. `no_room_overlap` depends
on that column, so the drop would have taken **the room invariant** with it, and
the resulting database would have looked entirely healthy while double-booking
every room.

**Why it happened:** drizzle-kit's snapshot did not model the generated
expression, so it saw a column it could not account for and proposed removing it.

**Replaced with:** a patched snapshot so `generate` is a clean no-op. The general
lesson is not about Drizzle: **generated migrations are a proposal, not an
output.** This one was caught because it was read.

---

## 7. Retry-only deadlock handling made 5xx measurably worse

**Where:** `apps/api/src/bookings/bookings.service.ts`
**Found:** P5, by running the proof five times instead of once.

The P2 hold path caught class-40 aborts and retried, and passed the concurrency
proof — **once**. Run repeatedly it collapsed: 227 deadlocks logged, and Postgres
only detects a deadlock after `deadlock_timeout`, a full second. A second of lock
wait per deadlock across a 20-connection pool produced connection timeouts, so
the retry logic converted a contention problem into an availability problem.

**Why the first answer was wrong:** retrying is the correct response to a
deadlock and does nothing about the *cause*. Two transactions taking the
exclusion index's internal locks in different orders will keep deadlocking.

**Replaced with:** `pg_advisory_xact_lock` per room, taken before the insert, so
holds for one room queue in a defined order and never deadlock. 3,200 requests,
zero deadlocks, zero 5xx. Its own ceiling is now item 2 in §9.

---

## 8. nginx reached the API over IPv6 while it bound `0.0.0.0`

**Where:** `apps/api/src/main.ts`
**Found:** P5, as intermittent 502s under the load balancer.

Docker's embedded DNS returns AAAA records for the `api1`/`api2`/`api3` service
names, so nginx connected over IPv6 to a server listening only on IPv4.

**Why it matters more than it looks:** these were intermittent 502s *under the
load balancer during concurrency testing*. A 502 in the middle of the 200-request
proof is indistinguishable from a genuine invariant violation without reading
logs — the exact failure mode most likely to be mistaken for a correctness bug,
or, worse, to hide one.

Now binds `::`, which accepts IPv4-mapped connections too. A later fix (P8) added
a fallback for hosts with **no** IPv6 stack, where binding `::` fails outright —
the two environments want opposite things and the code now detects which it is in.

---

## 9. `now()` is transaction-start time, so the INV-4 audit trail could not be ordered

**Where:** `audit_events.occurred_at`
**Found:** P5, while trying to read the INV-4 sequence back out of the trail.

Every audit row inside one transaction got the **same** timestamp, because
`now()` in Postgres is the transaction's start time. The INV-4 path writes the
expiry and the refund initiation in one transaction, so the trail reported the
refund before the expiry about half the time, depending on tie-breaking.

The whole point of that trail is to demonstrate the ordering. It could not.

**Replaced with:** `clock_timestamp()`. A small fix for a defect that would have
undermined the evidence for the invariant it was recording.

---

## 10. The seed silently delivered 14,138 of 25,000 bookings

**Where:** `apps/api/src/db/seed.ts`
**Found:** P6, by checking the row counts against what was asked for.

The generator's stride arithmetic lost bookings to floating point and the seed
reported success. Every count in the summary was computed from the same
in-memory tally that was wrong, so the seed agreed with itself.

A later, worse variant of the same class: the counts were all *correct* and the
**distribution** was unusable — the walk ran forward from the start of the range
and stopped when a room hit its target, packing every room's allocation into the
oldest months. 21,000 bookings in the first month, 410 in the current one.
Availability, search and create-hold all query the *future*, and the future was
empty. Every p95 in `LOAD_TEST.md` would have been measured against a nearly
empty region of the table: fast, reproducible and meaningless.

**Replaced with:** counts read back from the tables rather than tallied in
memory, and a `date_trunc('month')` histogram checked before trusting the
fixture. **A correct total can still describe an unusable shape** — that is the
part worth keeping.

---

## 11. Two INV-6 assertions passed for the wrong reason

**Where:** `tests/authz/`
**Found:** P6, while reviewing tests that were already green.

Two cross-venue assertions passed because the *setup* failed, not because the
isolation held — the fixture never created the row the test then failed to read.
A test that cannot distinguish "correctly denied" from "never existed" is not
evidence of anything, and these were tests for a hard-capped requirement.

**Why this is the most uncomfortable entry:** the suite was green, the invariant
was real, and the tests were worthless. Nothing in the output said so. They were
found by reading them, and the only reason they were read is that a review pass
was scheduled whether or not anything looked wrong.

---

## 12. Four console defects that `tsc` and `next build` both passed cleanly

**Where:** `apps/web/`
**Found:** P7, by opening the pages in a browser.

- **Every `'use server'` file exported a state constant.** A `'use server'` module
  may only export async functions; exporting `EMPTY_PAY_STATE` beside
  `payForBooking` type-checks, builds, and throws the first time a client
  component imports it. All four action files did it. Sign-in, hold, pay and
  cancel would have shipped **dead**, from a build with no warnings.
- **An unlayered base rule beat Tailwind's `@layer utilities` regardless of
  specificity.** `*, *::before, *::after { border-color: … }` written outside a
  layer silently defeated `border-transparent`, so every ghost button had a grey
  box around it. Fixed by `@layer base`.
- **A `datetime-local` round trip shifted by the reader's UTC offset.** Rendering
  an instant into the input on the server, where the reader's zone is unknown,
  then reading it back as local. Now two pure functions tested under five `TZ`
  values; reintroducing the defect fails under `Asia/Karachi` and **passes under
  UTC**, which is exactly why it was invisible the first time.
- **The active nav item never updated on client-side navigation.** The agent's
  first diagnosis was that the path header was not arriving. Measuring said
  otherwise: a hard reload marked the right item every time. A shared layout is
  not re-rendered when the router moves between its children, so the value was
  computed once and frozen. The header was fine; the consumer never ran again.

The common thread: **a green build says the types agree, not that the program
works.** Four defects, four clean builds.

---

## 13. A 429 presented to the user as the chaotic-failure branch

**Where:** `apps/web/app/(console)/checkout/[id]/`
**Found:** P9, on the deployed instance — it cannot reproduce locally.

Five payment attempts returned 502 in a row. Chaos is roughly one in ten, so five
consecutive is about one in a hundred thousand. The body said what it really was:
`provider_status: 429`, `provider_body: "Too Many Requests\n"` — the platform edge
throttling the API's outbound hop, not the provider declining anything.

The console mapped every 502 to "roughly one charge in ten, press again". For a
429 that advice is **exactly inverted**: pressing again is what keeps the limit
closed.

**Why it is here:** the mechanism was right and the *words* were wrong, and wrong
words in a payment flow are a defect. The local stack has no edge in front of it,
so no amount of local testing would have found it.

---

## Smaller ones, recorded for completeness

- **`node:26-alpine` no longer ships corepack**, so the Docker build failed on a
  step that had worked in every previous image.
- **Drizzle nests pg errors under `cause`**, so `isUniqueViolation` checking
  `err.code` never matched and duplicate registration returned 500 instead of
  409. `common/pg-errors.ts` walks the chain.
- **Per-directory `.dockerignore` files are inert.** Every Docker build was
  silently copying the host's `node_modules`.
- **Reconciliation reported `LIMIT 500` as the true total.** A report whose only
  job is to be trustworthy was truncating its own headline number.
- **The equipment sweep line needed an explicit tie-break** at equal instants —
  ends before starts — or every back-to-back handover reports a phantom peak and
  refuses legal bookings. The design said "order the events" without saying how.
- **Availability offered slots in the past** until P8.
- **The console's date assembly trusted ICU's `en-GB` formatting** rather than
  building dates from fields.

---

## Direction that did not come from the agent

The brief's real question is whether the candidate was the architect or the
passenger. These were specified before any code existed, and in several cases
against what the agent proposed or would have proposed:

**The sweep-line max-concurrent-usage check.** The natural implementation of
"never more than N out at once" is `SELECT SUM(quantity) WHERE interval overlaps`,
and it is wrong — it over-counts across non-overlapping sub-intervals and refuses
legal bookings. The correct computation is a sweep line over interval boundary
events: `+qty` at each start, `-qty` at each end, clipped to the requested window,
ordered, with a running `SUM() OVER (ORDER BY event_time)`, and the peak of that
running sum compared against the ceiling. **This was specified in `CLAUDE.md`
before the first line of booking code**, with an explicit instruction that finding
yourself writing `SUM(quantity)` means stopping. It is the difference between
INV-2 holding and appearing to hold.

**Deploying in the first hour rather than the last.** Deployment is a hard cap on
the score, and P1 shipped it. Four separate free-tier constraints surfaced —
`preDeployCommand` is paid-tier only, `dockerCommand` is not run through a shell,
Vercel reads the installed package before building, migrations must run in-process
— and none of them are discoverable locally. Discovering them at the end would
have cost the cap outright.

**Making the concurrency proof the gate on the hold path**, not a later phase. The
proof was pulled forward into P2, so no hold code was accepted before 200
concurrent requests had run against three replicas. Its later reordering (P4's
proof delivered in P2) is recorded in `PLAN.md` rather than tidied away.

**Deploying Paygate rather than leaving payments demonstrable only locally.** The
easy path is a mock that runs on the reviewer's laptop. A deployed provider is
what makes the payment path real to somebody who never clones the repository.

**The durable Paygate ledger** — entry 3 above. The agent had a defensible
position and held it; the reversal came from asking what a restart costs.

**Reversing the P6/P7 order**, putting performance before the console because
performance held the remaining Tier 1 risk and the console held none.

---

## What I would tell the next person using an agent this way

The three most expensive defects in this project — the inert payment path, the
amnesiac provider, the array binding — were all cases where **the agent wrote the
correct reasoning in a comment and then did something else in the code**. The
comment above `raw_body` said the raw bytes must be preserved. `uuidArray()`
documented the array-binding trap in the same repository that then repeated it.
The poll path explained its 404 handling in a paragraph that was internally
coherent and premised on something false.

Reading the prose is not reading the diff. The prose is generated by the same
process as the code and is confident in the same way.

The second thing: **a green build and a green suite are weaker evidence than they
feel.** Four console defects passed `tsc` and `next build`. Two INV-6 tests passed
by failing their own setup. The payment path passed an entire phase while being
completely inert. Everything on that list was found by running the thing, or by
reading tests that were already green — never by the pipeline.
