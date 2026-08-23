# tests/authz — tenant isolation (INV-6)

Built in P2. Not yet implemented.

The brief calls this a REQUIRED NEGATIVE TEST:

> Ship an automated test proving a VENUE_ADMIN of Venue A receives a 403 or 404,
> and never data, when requesting a booking, room, or report belonging to
> Venue B. Include the case where they guess a valid UUID from Venue B
> directly. Authorisation that lives only in the frontend is treated as absent.

Coverage this must include:

- A VENUE_ADMIN of Venue A hitting a booking, a room and a report belonging to
  Venue B, addressed by a **real, valid UUID read from the seed** — not a
  fabricated one. A 404 on a nonexistent id proves nothing.
- Both read and write verbs on each resource.
- VENUE_STAFF as well as VENUE_ADMIN.
- The assertion is on the body as much as the status: a 403 that leaks the
  resource in an error message still fails.
- A PLATFORM_ADMIN positive control, so the test cannot pass by denying
  everyone.

Bypassing authorisation across venues is one of the brief's three hard caps on
the total score, so this suite gates every venue-scoped endpoint added later.
