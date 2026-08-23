# tests/authz — tenant isolation (INV-6)

The brief's REQUIRED NEGATIVE TEST. Cut from P2 for time and verified by hand
instead; hand verification does not lift the cap, so it was the first thing
built in P4.

> Ship an automated test proving a VENUE_ADMIN of Venue A receives a 403 or 404,
> and never data, when requesting a booking, room, or report belonging to
> Venue B. Include the case where they guess a valid UUID from Venue B
> directly. Authorisation that lives only in the frontend is treated as absent.

## Running it

The census runs anywhere, including CI:

```bash
pnpm --filter @atrium/tests-authz test
```

The probes need the full stack — three replicas behind nginx on :8080, sharing
one Postgres:

```bash
pnpm authz
```

## Two halves, and the split is the point

**`route-census.unit.test.ts`** reads the API's controller decorators and
requires that every registered route is either probed by this suite or listed
in `EXEMPT` with a written reason. It needs no stack, no database and no
network, so it runs on every push.

That is deliberate. The realistic way to breach this cap is not to write a
broken endpoint today — it is to add a correct-looking one in P6 that nobody
remembers to add here. A guard that only fires when someone runs
`docker compose up` would not have fired. `EXEMPT` demands a reason because
"exempt" without one is how a venue-scoped endpoint quietly joins the list
during a hurried phase.

The census reads the source rather than asking the running server for its
router table. Nest can be asked, but only from inside the process, and exposing
it over HTTP would mean adding a production route whose entire purpose is to be
read by a test. The decorators *are* the registration. The cost — a route
registered dynamically would be missed — is recorded rather than papered over;
none are.

**`inv6.authz.test.ts`** makes the requests. It closes the other end of the
loop: `PROBED` cannot be satisfied by writing a line in a list, because each
probe records itself and the last test fails if a claimed route was never
actually called.

## What is asserted

- **Real UUIDs.** Every cross-venue probe uses the actual primary key of the
  other venue's row, read back from the INSERT. A 404 on a fabricated UUID
  proves only that the row does not exist.
- **VENUE_ADMIN and VENUE_STAFF**, on every venue-scoped route, read verbs and
  write verbs.
- **The body, not just the status.** "and never data" is the brief's phrase. A
  403 whose message names the room, or a 404 that echoes the venue it could not
  find, has confirmed the row exists and handed back an identifier the prober
  did not have. Every denial is checked against every identifier belonging to
  the other tenant.
- **The write probes changed nothing.** A denial that still performed the write
  passes every status assertion, so the rows are read back from Postgres
  afterwards.
- **Lists.** The leak with no UUID in the URL: `GET /bookings` and
  `GET /equipment-types` must contain no row from the other venue.
- **A write with no id in the request at all.** `PUT /venues/cancellation-policy`
  is sent with Venue B's id in the body by Venue A's admin. It must be ignored,
  and B's policy must be unchanged afterwards.
- **A CUSTOMER** cannot read another customer's booking, and their list contains
  only their own.
- **A PLATFORM_ADMIN reads both venues.** The positive control, without which
  the suite would pass against a server that denies everyone everything.

## Denials are 404, not 403

Both satisfy the brief. 404 is chosen because 403 confirms the row exists, and a
VENUE_ADMIN probing UUIDs could then enumerate another venue's identifiers. The
cost is worse ergonomics for legitimate users, who cannot tell a typo from a
permissions problem. Recorded in ARCHITECTURE.md under Assumptions.

## The two catalogue routes

`GET /rooms/:id/availability` and `GET /search` are reachable across venues **by
design** — cross-venue search is a Tier-1 requirement and a customer cannot book
a room whose calendar they cannot see. They are probed anyway, for what they
must *not* carry: free/busy intervals and room attributes, never a booking id, a
customer id or an email. An endpoint that says a slot is taken is catalogue; one
that says who has it is a leak.

## The suite owns its fixtures

Nothing here reads the seed script. A negative test asserting against seeded
rows is asserting the seed's current shape: change the seed and the suite either
breaks noisily or — far worse — quietly stops proving anything, because the
"other venue" it probes no longer exists and every request legitimately 404s.

Privileged principals are made by registering through the API (which always
mints a CUSTOMER, whatever the body says), promoting the row in SQL, and logging
in again. The second login is the point — the token's claims are re-read from
the row, so the suite exercises the same token-minting path a real admin would,
rather than proving it can sign its own JWTs.

## Known limitations

- Fixture venues are left behind. `audit_events` is append-only by trigger and
  `booking_id` is `ON DELETE restrict`, so tearing them down would mean
  defeating the guarantee the trigger exists to provide. Rows are tagged
  `authz-inv6` and each run makes its own.
- The census cannot see a route registered at runtime rather than by decorator.
  None are, and adding one would need this file amended alongside.
