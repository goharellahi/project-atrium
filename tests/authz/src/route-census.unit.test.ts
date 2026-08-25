import { describe, expect, it } from 'vitest';
import { checkCoverage } from './routes.js';

/**
 * The census, and the only part of this package that runs in CI.
 *
 * It needs no stack, no database and no network — it reads the API's controller
 * decorators. That is deliberate: the failure this guards against is a
 * venue-scoped endpoint added in a later phase without a probe, and a guard
 * that only fires when someone remembers to run `docker compose up` would not
 * have fired. Cross-venue leakage is a hard cap on the assessment; this is the
 * cheapest place to make forgetting impossible.
 *
 * The probes themselves live in `inv6.authz.test.ts` and need the live stack.
 */
describe('route census', () => {
  it('every registered route is either probed by the INV-6 suite or exempt with a reason', () => {
    const {
      registered,
      uncovered,
      staleProbed,
      staleExempt,
      staleCrossVenue,
      unprobedCrossVenue,
    } = checkCoverage();

    expect(registered.length, 'no controllers found — the census is reading the wrong path').toBeGreaterThan(0);

    expect(
      uncovered,
      `These routes are registered but neither probed by tests/authz nor exempt.\n` +
        `Add a probe to inv6.authz.test.ts, or an entry to EXEMPT in routes.ts WITH A REASON:\n  ` +
        uncovered.join('\n  '),
    ).toEqual([]);

    // The mirror failure: an entry left behind after a route is renamed, which
    // would make the coverage claim silently false while still passing.
    expect(staleProbed, 'PROBED names a route that no longer exists').toEqual([]);
    expect(staleExempt, 'EXEMPT names a route that no longer exists').toEqual([]);
    expect(
      staleCrossVenue,
      'CROSS_VENUE_BY_DESIGN names a route that no longer exists',
    ).toEqual([]);

    // A deliberately cross-venue route still needs a probe. The declaration
    // says what the probe must assert — that the response is inventory and
    // nothing operational — it does not replace the probe.
    expect(
      unprobedCrossVenue,
      'CROSS_VENUE_BY_DESIGN entries must also appear in PROBED',
    ).toEqual([]);
  });
});
