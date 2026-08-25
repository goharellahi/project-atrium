# TIMELINE.md

Derived from `git log`, not from memory. Every time below is the **author**
timestamp of a real commit in `PKT (UTC+05:00)`, and every claim here is
checkable:

```bash
git log --reverse --pretty=format:'%ad  %h  %s' --date=format:'%a %d %b %H:%M' main
```

141 commits, first at **Sun 23 Aug 06:06**, last at **Tue 25 Aug 21:12**.
Roughly 24 hours of actual work spread across three days.

---

## Before the first commit

**Friday evening — the brief arrives.** Read once that night, not started.

**Saturday — lost to travel.** No commits, and none claimed. The repository is
empty until Sunday morning.

This matters for one reason, addressed head-on below: the brief's
design-before-code checkpoint asks for the concurrency strategy committed within
the first four hours, and the clock for that runs from receiving the brief.
**In absolute terms that checkpoint was missed by roughly a day and a half.**

What the history does show is that the *ordering* held. The first commit in the
repository is the concurrency strategy, and no hold endpoint existed until three
and a half hours after it. Both facts are in the log; neither excuses the other.

---

## Sunday 23 August — 06:06 to 20:54

The first hours were compressed. The working assumption that morning was a
**midday deadline**, and the plan was cut to fit it: Tier 1 correctness,
deployment, and nothing else.

### 06:06 – 07:06 · Design, then schema (P0/P1)

| Time | Commit |
| --- | --- |
| 06:06 | `docs: concurrency strategy and system constraints, before implementation` |
| 06:31 | `docs(process): working agreement — branch per phase, granular commits, handoff protocol` |
| 06:39 | `feat(db): drizzle schema for venues, bookings, payments and audit` |
| 06:39 | `feat(db): booking exclusion constraint, generated slot column, audit immutability` |
| 06:48 | `fix(db): make slot generation expression immutable` |
| 06:48 | `feat(auth): jwt, argon2id, role and venue-scope guards, repository-level tenancy` |
| 07:05 | `feat(obs): pino structured logging, correlation id, dependency-checking health` |
| 07:05 | `build(deploy): dockerfiles, render blueprint, vercel config, CI, README` |

The 06:48 fix is the first reversal of the day and it is 9 minutes old: the
generated column as designed at 06:06 would not run, because
`ends_at + interval` is STABLE rather than IMMUTABLE. Postgres rejected it. Both
versions are still in ARCHITECTURE.md §3.

### 07:51 – 08:56 · Deployment, four failures deep (P1)

P1 merged at 07:51, then **four consecutive fix branches** before anything was
live:

| Time | What broke |
| --- | --- |
| 08:00 | `preDeployCommand` is paid-tier only — blueprint rejected at validation |
| 08:25 | `dockerCommand` is not run through a shell; migrations moved in-process |
| 08:41 | Vercel reads the *installed* package before building, so the no-op install command guaranteed "No Next.js version detected" |
| 08:54 | Deployed URLs recorded, verified live |

Roughly an hour on deployment plumbing at the point in the schedule where it felt
least affordable. It is the decision I would defend hardest: none of these four
is discoverable locally, and finding them on the last day would have cost the
deployment hard cap outright.

### 09:23 – 09:56 · Paygate, then the booking core (P3, P2)

Paygate first (09:23–09:25) — seeded RNG, HMAC over raw bytes, all six chaos
behaviours at the brief's rates, verified over a 20,000-key sample.

Then the booking core in a single 09:35–09:37 burst: the state machine as the
only writer of `bookings.status`, the equipment sweep line, the hold sweeper
elected by advisory lock, availability and search, hold/checkout/cancel — and at
09:37, `test(concurrency): the 200-request proof against three replicas`.

**The proof was pulled forward into P2 on purpose.** It had been scheduled for
P4. Moving it made it the gate on the hold path rather than a later verification
of it, so no booking code was accepted before 200 concurrent requests had run
against three replicas behind nginx.

### 10:18 – 10:22 · Payments (P4)

Pay, webhook ingest, the delivery worker, refunds, the cancellation policy as
data, the reconciliation endpoint, and the required cross-venue negative suite.
P4 declared complete at 10:22.

It was not. See AI_LOG entry 1 — the payment path was inert and stayed inert
until P5 ran the stack.

### 10:22 – 18:30 · The deadline moves

**Eight hours idle.** This is where the midday deadline was extended and the
scope reopened. Everything from here is work that the morning's plan had cut.

### 18:30 – 20:54 · Reopening, and P5 finding what P4 missed

`DECISIONS.md` at 18:30, then P5's fixes from 19:22: the seed restoring the
policy it truncates, a missing default policy made visible instead of a bare 500,
**holds serialised per room so the exclusion index stops deadlocking**, and
reconciliation no longer reporting a truncated count as the real one.

The per-room advisory lock is the second significant reversal. P2's retry-only
deadlock handling passed the proof once and collapsed when run five times — 227
deadlocks, then connection timeouts. Retrying was the correct response to a
deadlock and did nothing about the cause.

---

## Monday 24 August — 01:37 to 23:45

### 01:37 – 03:08 · P5 closes

The verification phase that found seven defects in code earlier phases had called
complete.

### 10:46 – 14:33 · Performance (P6), and the frontend starts

**P6 and P7 were swapped.** Performance held the remaining Tier 1 risk; the
console held none. The reordering is recorded in `PLAN.md` rather than presented
as the original plan.

P6: the `full` profile made real at 250,000 bookings, three indexes added because
a plan changed, two deleted, **two built, measured and rejected**. Three of four
p95 targets met; create-hold misses at 536 ms against 250 ms, and the miss is
published rather than tuned away (`DECISIONS.md` 12).

It also found the seed producing a fixture no benchmark could use — correct row
counts, unusable distribution.

The P7 console commits carry 10:46–10:47 author timestamps from the branch.

### 23:45 · The amenity defect

`fix(api): bind the amenity array as one parameter, not one per element` — a
required search filter that had returned 500 for every input since it was
written, found in the first minute of pointing a UI at real data.

---

## Tuesday 25 August — 01:22 to 21:12

### 01:22 – 05:26 · The deployed console (P7 second pass)

Browser testing found six defects a green build could not: the active nav item,
two misleading sign-in placeholders, form errors that rendered nowhere, and two
unstyled native controls. Plus `SEED_ON_BOOT`, because Render's free tier has no
shell and the deployed database was empty — meaning four of the five accounts the
login page advertised did not exist.

### 06:46 – 07:54 · P8 phase A — the Tier 1 gaps, and a cut withdrawn

`GET /rooms/:id`, a customer-readable equipment catalogue, **venue administration
and the overbooking buffer** — which unblocked the rooms-reject-non-zero-buffer
422 that had been open since P2 — and the settled payment published on the
booking read.

### 09:31 · The reversal that mattered most

`feat(paygate): a durable ledger, because a provider with amnesia breaks INV-5`,
and alongside it `fix(api): stop reading "never heard of it" as "nothing was
captured"`.

P3 had decided a test double needs no database. Right about INV-3, wrong about
INV-5. Recorded as a reversal in `DECISIONS.md` 13.

### 21:12 · P8 merged

---

## What was cut, and when

| Cut | When | Reinstated? |
| --- | --- | --- |
| Everything but Tier 1 + deployment | Sun ~06:00, under the believed midday deadline | Yes — Sun 18:30 |
| The frontend | Sun morning | Yes — P7, Mon/Tue |
| Venue administration | P2, deferred | Yes — P8, Tue 06:47 |
| The revenue **page** (API exists) | P7 scoping | **No** |
| **Tier 3 entirely** | Sun morning, and confirmed after the extension | **No** |

## Decisions reversed mid-build

The brief calls discovering your first approach was wrong "good engineering", so
these belong here as much as the successes:

1. **The generated column expression** — 06:06 → 06:48, nine minutes, because
   Postgres refused it.
2. **Deadlock handling: retry → per-room advisory lock** — P2 → P5, because
   retrying passed once and collapsed under repetition.
3. **`webhook_deliveries.raw_body`: jsonb → text** — P4 → P5, after it made the
   entire payment path inert.
4. **Paygate's ledger: in-memory → durable** — P3 → P8, because a provider that
   forgets cannot participate in a proof that no money was lost.
5. **Phase order: P6 and P7 swapped** — performance ahead of the console.
6. **The Tier 3 cut, withdrawn and then re-taken** — briefly reopened in P8
   phase A, then closed again in favour of Tier 1 closure and these documents.

---

## Tier 3 was not built, and that was a choice

The brief warns that Tier 3 is more visible in a demo than a correct locking
strategy, and asks candidates to say which they chose.

**I chose Tier 1 correctness, the Tier 2 console, and these documents.**

Recurring bookings, waitlists and dynamic pricing are not built and are not
started. With the time that would have taken, the alternatives were: the
concurrency proof running against three replicas under repetition rather than
once; the payment path actually working rather than appearing to; a durable
provider ledger; the venue administration that unblocked a 422 open since P2; and
ARCHITECTURE.md.

The trade is deliberate and I would make it again. A waitlist demonstrates well
and proves nothing; a system that never double-books under 200 concurrent
requests demonstrates poorly and is the entire point of the exercise.

The honest cost: a reviewer scanning feature lists sees three gaps, and the
recurring-bookings design in ARCHITECTURE.md §9 is reasoning rather than running
code.
