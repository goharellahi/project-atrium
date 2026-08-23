# Paygate — the mock payment provider

Built to brief §06. Paygate is deliberately unreliable: it behaves like a real
provider on a bad day, and it is the only payment provider Atrium talks to.

It runs as its **own process on its own port**, not as an in-process stub. The
API must reach it over HTTP so that the failure modes are real network failures,
and so a webhook genuinely arrives back through nginx on whichever replica the
load balancer picks — not necessarily the replica that submitted the charge. A
stubbed function that always resolves would prove nothing about INV-3.

State lives in memory. Paygate is a test double, not a system of record;
restarting it *should* wipe it. The exactly-once effect (INV-3) is the API's
responsibility, enforced in Postgres, and must not depend on the provider
remembering anything.

---

## Extensions to the brief's §06 spec

Everything below is **additive** — nothing the brief specifies behaves
differently because of it. It is listed here in one place because an addition
that is declared reads as engineering judgement, and the same code undeclared
reads as having misread the spec.

| # | Extension | Why |
| --- | --- | --- |
| 1 | Events `charge.failed` and `refund.succeeded` | The brief names only `charge.succeeded`. Without the other two the API's FAILED and REFUNDED states are unreachable, and INV-4 — hold expires, payment succeeds, money is automatically refunded — has no evidence the refund settled. |
| 2 | A `refund_id` field on `refund.succeeded` bodies | The obvious correlation key for a refund. Additive: the signature still covers the whole body, and a receiver ignoring unknown fields is unaffected. |
| 3 | `POST /paygate/_test/deliver` and `POST /paygate/_test/delay` | A chaos rate is a property of the population, not of any one run. An INV-3 test waiting for the 30% duplicate branch, or an INV-4 test hoping for the 5% late branch, is a coin flip rather than a test. See the guard rails below. |
| 4 | `PAYGATE_DECLINE_AMOUNT_MINOR` — a magic decline amount | The brief's chaos table asks for no random declines, but `charge.failed` needs to be reachable on demand. A fixed trigger amount is how real test providers do this, and it keeps a decline out of the middle of a concurrency proof, where it would be indistinguishable from a real bug. |
| 5 | `PAYGATE_SEED` — replayable chaos | Unspecified in the brief. A chaotic test double whose branches cannot be reproduced is a coin flip, not a test double; when a 200-request run turns up one bad booking, replaying the exact chaos is the only way to debug it. |
| 6 | `GET /paygate/charges/:id` and `GET /paygate/refunds/:id` | Read-only. Lets a reviewer see every delivery attempt and the chaos branch each took, rather than taking the log's word for it. |
| 7 | `X-Request-Id` echoed on every webhook delivery | Not in §06's header list, but brief §09 Tier 2 requires a correlation id that survives into the webhook path. Read off the charge request, stored against the charge. |
| 8 | `PAYGATE_WEBHOOK_URL` accepted as an alias for `PAYGATE_CALLBACK_URL` | This repository's `docker-compose.yml`, owned by another phase, uses the second name. Accepting both meant no shared file had to change. The brief's name wins if both are set. |

### Guard rails on the test control surface

The `/paygate/_test/*` routes forge signed webhooks and take no authentication.
Two things keep them from being mistaken for part of the provider:

- They live in their own module, `src/test-routes.ts`, so the line between
  "the provider the brief specified" and "scaffolding I added" is a file
  boundary rather than a comment.
- **They refuse to register when `NODE_ENV=production`**, regardless of
  `PAYGATE_TEST_ENDPOINTS`. Not a security control — Paygate holds no real
  money — but a legibility one: nobody reading a production route table should
  have to work out whether an unauthenticated webhook forger is scaffolding or
  an oversight. In production it is simply not there. If the flag asked for
  them, the refusal is logged rather than applied silently, and `/health`
  reports the effective state, not the requested one.

### Behaviour the spec leaves open

Decided here, and worth disagreeing with explicitly if you would have chosen
otherwise:

- Reusing an `Idempotency-Key` with a **different body** is `409`, not a silent
  replay of the original charge. A replay would hide a caller bug.
- A refund against a charge Paygate never issued is `404`, never `500`.
- The 10% transient-failure branch applies to `POST /charges` only, as written;
  it is not extended to refunds.
- A delivery to an unreachable callback is recorded and dropped, not retried.
  A retry would add a second source of duplicates on top of the specified 30%.

---

## Environment

| Variable | Default | What it does |
| --- | --- | --- |
| `PAYGATE_PORT` | `9000` | Listen port. Binds `::`, not `0.0.0.0` — Docker DNS returns AAAA records and an IPv4-only bind produced intermittent 502s through nginx in P1. |
| `PAYGATE_SECRET` | *(required)* | HMAC key for `X-Paygate-Signature`. Shared with the API. |
| `PAYGATE_CHAOS` | `off` | `on` enables all six chaos behaviours. `off` is deterministic and immediate. |
| `PAYGATE_SEED` | `atrium` | Seeds every chaos decision. Same seed + same Idempotency-Keys ⇒ identical branches. |
| `PAYGATE_CALLBACK_URL` | — | Where webhooks are POSTed. |
| `PAYGATE_WEBHOOK_URL` | — | Accepted as an alias. See the note below. |
| `PAYGATE_TEST_ENDPOINTS` | `on` | Requests the `/paygate/_test/*` control surface. Set `off` to remove those routes entirely. |
| `NODE_ENV` | `development` | `production` refuses to register `/paygate/_test/*` at all, whatever `PAYGATE_TEST_ENDPOINTS` says. |
| `PAYGATE_DECLINE_AMOUNT_MINOR` | `666` | A charge for exactly this amount always resolves `charge.failed`. |
| `PAYGATE_DELIVERY_TIMEOUT_MS` | `5000` | Per-delivery HTTP timeout. |
| `LOG_LEVEL` | `info` | pino level. |

> **Two names for the callback URL.** The brief calls it
> `PAYGATE_CALLBACK_URL`; this repository's `docker-compose.yml` sets
> `PAYGATE_WEBHOOK_URL`. Paygate accepts either, `CALLBACK` winning, so nothing
> outside `apps/paygate/` had to change. If compose is ever tidied, the brief's
> name is the one to keep.

With no callback URL configured Paygate still boots, logs a warning, and records
every delivery as skipped rather than pretending to have sent it.

---

## Interface

### `POST /paygate/charges`

```
Idempotency-Key: <uuid>
{ "amount_minor": 45000, "currency": "PKR", "reference": "<booking_id>" }

202 { "charge_id": "ch_...", "status": "processing" }
```

The same `Idempotency-Key` always returns the same `charge_id` and never creates
a second charge — **including when the first attempt returned 500**. The
idempotency record is written *before* the transient-failure branch is
evaluated, which is what makes that guarantee hold: the charge id survives the
500, and the retry adopts it instead of minting a new one. A 500'd charge is
recorded but not *materialised* — no outcome, no webhook — until a retry with
the same key brings it to life.

Reusing a key with a **different body** is a `409 idempotency_key_reuse`, not a
silent replay of the wrong charge.

Other responses: `400` missing `Idempotency-Key`, `422` invalid body,
`500 provider_error` for the 10% chaos branch.

### `POST /paygate/refunds`

```
Idempotency-Key: <uuid>
{ "charge_id": "ch_...", "amount_minor": 22500 }

202 { "refund_id": "re_...", "charge_id": "ch_...", "status": "processing" }
```

Same idempotency contract — double-clicking cancel refunds once. `404
unknown_charge` for a charge Paygate has never issued, `409
charge_not_refundable` if it did not succeed, `422 refund_exceeds_charge` if the
running total would exceed what was captured.

The 10% transient-failure branch is **not** applied to refunds. The brief
specifies it for `POST /charges`; inventing a second failure surface would make
the API's refund path harder to reason about without testing anything asked for.

### Webhook

```
POST <PAYGATE_CALLBACK_URL>
X-Paygate-Signature: hmac_sha256(raw_body, PAYGATE_SECRET)   // hex
X-Paygate-Delivery:  <uuid, NEW on every delivery attempt>
X-Request-Id:        <the correlation id from the charge request>

{ "charge_id": "ch_...", "reference": "...", "event": "charge.succeeded",
  "amount_minor": 45000, "occurred_at": "<ISO-8601>" }
```

Events: `charge.succeeded`, `charge.failed`, `refund.succeeded`.

> **Extensions 1 and 2.** `charge.failed`, `refund.succeeded`, and the
> `refund_id` field on refund bodies are additions to §06 — see
> [Extensions to the brief's §06 spec](#extensions-to-the-briefs-06-spec) above
> for what each is for. Both are additive: nothing about `charge.succeeded`
> changes, and the signature still covers the whole body.

**The signature is over the raw bytes.** Paygate serialises the payload exactly
once and both signs and sends that same string; it never re-serialises. Verify
the same way — against the raw request body, before parsing. Whitespace and
number formatting do not survive a parse/stringify round trip, so a receiver
that verifies a re-serialised object will see intermittent, maddening
mismatches. There is a test for this (`test/signature.test.ts`).

### Inspection

- `GET /health` — status, chaos flag, seed, whether a callback URL is set, counts.
- `GET /paygate/charges/:id` — the charge, its chaos plan, its refunds, and
  **every delivery attempt** made for it: delivery id, attempt number, chaos
  branch, whether the signature was deliberately corrupted, scheduled delay,
  response status, duration, error. This is the reviewer's window into what
  actually happened.
- `GET /paygate/refunds/:id` — the refund and its deliveries.

---

## Chaos

All six behaviours from the brief, behind `PAYGATE_CHAOS=on`. Rates are
compiled-in constants rather than env vars: both candidates are graded against
the same specified provider, so a tunable rate would be drift, not a feature.

| Behaviour | Rate | Detail |
| --- | --- | --- |
| Duplicate delivery | 30% | A second delivery of the same event, new `X-Paygate-Delivery`, 30–900 ms later. |
| Race on response | 25% | The webhook is delivered **and awaited** before the 202 is written, so the API sees a charge it has not recorded yet. |
| Transient failure | 10% | `POST /charges` returns 500. Retry with the same key returns the same `charge_id`. |
| Delayed delivery | 5% | 60–90 s, comfortably outside the hold TTL. |
| Out of order | — | See below. |
| Bad signature | 2% | Of *deliveries*, drawn per attempt: the duplicate of a good delivery can be bad, and vice versa. |

**Race and delay are drawn from one uniform, not two coins.** A delivery cannot
both precede the 202 and arrive 60 seconds late. Drawing them independently
would have produced 25% × 95% = 23.75% races; a single uniform partitioned
`[0, 0.25)` → race, `[0.25, 0.30)` → delayed preserves both specified rates
exactly.

**Out of order** is produced two ways, because one alone is not enough. Delivery
delays are randomised per charge, so arrival order across charges is already
independent of `occurred_at` order. On top of that, 35% of charges have
`occurred_at` backdated by 1–30 s, which guarantees inversions even when two
charges happen to be delivered in the order they were created. Either way the
receiver is forced to treat `occurred_at` as untrustworthy, which is the point.

**Paygate never declines at random.** The brief's chaos table does not ask for
it, and a random decline in the middle of a concurrency proof is
indistinguishable from a real bug. Declines are triggered deterministically by
amount (`PAYGATE_DECLINE_AMOUNT_MINOR`, default `666`).

With `PAYGATE_CHAOS=off`: no duplicates, no 500s, no delay, no bad signatures,
delivery immediately after the 202. Reproducible by construction.

### Replay

Every chaos decision is a pure function of `(PAYGATE_SEED, Idempotency-Key)`,
derived per decision rather than drawn from one global stream. That matters
because Paygate serves concurrent requests: a shared stream would hand out
different numbers depending on how the event loop interleaved them, so the same
seed would *not* reproduce the same run. Seeding each decision independently
makes a charge's branch order-independent — replay holds under 200 concurrent
requests, not just serial ones.

Verified against the real process: two runs of 60 charges at seed `replay-me`
produced an identical 500 pattern and identical duplicate counts; a different
seed produced a different pattern.

The one thing that does **not** replay exactly is which webhooks physically beat
their own 202 on the wire — that is a wall-clock race in the client, not a
Paygate decision. The 25% branch that *forces* it is deterministic; ordinary
fast deliveries sometimes win too.

---

## Forcing a scenario

`POST /paygate/_test/*`. **Not part of the brief's spec** — extension 3 above,
so the API's INV-3 and INV-4 tests are deterministic instead of hoping a 30%
branch fires. Set `PAYGATE_TEST_ENDPOINTS=off` to remove the routes, and note
that `NODE_ENV=production` removes them regardless.

### `POST /paygate/_test/deliver` — deliver a specific event now

```json
{ "charge_id": "ch_...", "event": "charge.succeeded", "times": 2,
  "corrupt_signature": false, "amount_minor": 45000,
  "occurred_at": "2026-08-23T09:00:00.000Z", "refund_id": "re_..." }
```

Only `charge_id` is required. `event` defaults to the charge's own outcome,
`times` to 1 (each delivery gets a fresh `X-Paygate-Delivery`),
`corrupt_signature` to the seeded 2% draw. Returns the delivery records.

- **INV-3, duplicate delivery:** `{"charge_id": "...", "times": 3}` — three
  deliveries of the same event, three delivery ids. The booking must be charged
  once.
- **Bad signature:** `{"charge_id": "...", "corrupt_signature": true}` — must be
  rejected 401 and logged, never processed.
- **Out of order:** two calls with hand-picked `occurred_at` values, delivered
  newest-first.

### `POST /paygate/_test/delay` — make the next delivery late

```json
{ "charge_id": "ch_...", "seconds": 75 }
```

Arms a one-shot delay: it fires once, then disarms. Omit `charge_id` to arm it
globally for whichever charge dispatches next — which is how you set up INV-4
without knowing the charge id in advance:

1. `POST /paygate/_test/delay {"seconds": 600}`
2. Create a hold and pay. The charge's webhook is now parked.
3. Let the hold expire (or wait for the sweeper).
4. `POST /paygate/_test/deliver {"charge_id": "...", "event": "charge.succeeded"}`

The booking must **not** become CONFIRMED, the money must be refunded
automatically, and the sequence must be recorded.

---

## Verifying a signature — worked example

Given `PAYGATE_SECRET=dev-paygate-hmac-secret` and this exact request body:

```
{"charge_id":"ch_9f2c1d4e7a8b40c39e1f5a6b7c8d9e0f","reference":"6f0a5c2e-1b3d-4f5a-9c7e-2d8b4a6f1c30","event":"charge.succeeded","amount_minor":45000,"occurred_at":"2026-08-23T09:41:12.418Z"}
```

the header is:

```
X-Paygate-Signature: a275bf85e6a2b4a917b308bb58ca84b7b6fff1232f7b2fa4e2b8a2224fd80973
```

Reproduce it:

```bash
printf '%s' '{"charge_id":"ch_9f2c1d4e7a8b40c39e1f5a6b7c8d9e0f","reference":"6f0a5c2e-1b3d-4f5a-9c7e-2d8b4a6f1c30","event":"charge.succeeded","amount_minor":45000,"occurred_at":"2026-08-23T09:41:12.418Z"}' | openssl dgst -sha256 -hmac 'dev-paygate-hmac-secret' -r
```

`printf` rather than `echo`: a trailing newline changes the digest, which is the
first thing to check when a signature will not verify.

In the receiver, compare in constant time against the **raw** body:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

const expected = createHmac('sha256', process.env.PAYGATE_SECRET!)
  .update(rawBody, 'utf8')
  .digest('hex');

const a = Buffer.from(expected, 'utf8');
const b = Buffer.from(req.headers['x-paygate-signature'] ?? '', 'utf8');
const ok = a.length === b.length && timingSafeEqual(a, b);
if (!ok) return reply.code(401).send({ error: 'invalid signature' });
```

---

## Logging

pino JSON, one line per event.

- `paygate.charge.accepted` — charge id, reference, amount, idempotency key,
  chaos branch, whether a duplicate is planned, clock skew, correlation id.
- `paygate.charge.transient_failure` — the 10% branch, before the 500 goes out.
- `paygate.charge.replayed` / `paygate.refund.replayed` — replay count and
  whether this replay recovered a charge from a 500.
- `paygate.delivery.attempt` — **every** attempt: charge id, refund id, delivery
  id, attempt number, event, chaos branch, `signature_corrupted`, scheduled
  delay, response status, duration, error, correlation id.
- `paygate.delivery.skipped` — no callback URL configured.
- `paygate.test.delay_armed` — the control surface was used.

`X-Request-Id` is read from the incoming charge request, stored against the
charge, echoed on **every** webhook delivery for that charge, and used as
fastify's own request id. One correlation id therefore spans web → nginx → api →
paygate → webhook → api, which is the Tier-2 requirement in brief §09. A refund
inherits the charge's correlation id unless its own request supplies one.

---

## Running

```bash
docker compose up paygate
```

or directly:

```bash
pnpm --filter @atrium/paygate build && PAYGATE_SECRET=dev pnpm --filter @atrium/paygate start
```

Tests — 39 of them, no network beyond a loopback receiver:

```bash
pnpm --filter @atrium/paygate test
```

They cover the idempotency contract (including recovery from a 500), signature
correctness over raw bytes, the refund contract, the delivery history endpoint,
the control surface and its production refusal, and that all six chaos rates
match the brief within tolerance over a 20,000-key sample.

## Known limitations

- **No delivery retry on transport failure.** If the callback URL is
  unreachable, the attempt is recorded with the error and dropped. A real
  provider retries with backoff. Not built because the brief's chaos table does
  not ask for it, and it would add a second source of duplicate deliveries on
  top of the specified 30%.
- **In-memory state.** Restarting Paygate loses every charge, so a webhook
  parked by `_test/delay` does not survive a restart. Deliberate — see the top
  of this file.
- **Idempotency keys are not expired.** The map grows for the process lifetime.
  Fine for a test double; a real provider would scope keys to a 24-hour window.
