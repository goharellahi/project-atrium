# tests/concurrency — the mandatory proof

Built in P6. Not yet implemented.

What this must do, from brief §05:

> Running against three API replicas behind a load balancer, fire 200
> concurrent booking requests against the same room and the same one hour
> slot, and against an EquipmentType with exactly 3 units owned. Assert that
> exactly one room booking succeeds, that at most 3 equipment units are
> reserved, and that every other request received a clean 409 rather than an
> error or a duplicate success.

Non-negotiable properties of the test itself:

- It runs against `http://localhost:8080` — nginx, not a single replica. A
  proof that talks to `api1` directly proves nothing (brief §08, "Why three").
- All 200 requests are released together, not fired in a loop. A loop
  serialises the client and the race never happens.
- It asserts on the *distribution* of responses: exactly one 201, and every
  other response is 409. A 500 is a failure of the test even if no double
  booking occurred — the brief asks for a clean 409, not merely a non-success.
- It re-reads the database afterwards. Asserting on HTTP responses alone would
  miss a row written by a request whose response was lost.
- It records which replica served each request, so the output can show the load
  really was distributed.

Output gets pasted into `ARCHITECTURE.md`.
