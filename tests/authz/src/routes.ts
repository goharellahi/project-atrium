import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The route census.
 *
 * ## Why this file exists
 *
 * A negative test that probes a hand-written list of endpoints proves something
 * about the endpoints that existed the day it was written. Cross-venue leakage
 * is a hard cap on the whole assessment, and the realistic way to breach it is
 * not to write a broken endpoint today — it is to add a correct-looking one in
 * P6 that nobody remembers to add to this suite.
 *
 * So the suite does not trust its own list. It reads the API's controllers,
 * extracts every registered route, and requires that each one is either
 * **probed** by this suite or **exempt** with a written reason. A new endpoint
 * with neither fails the run.
 *
 * ## Why the source and not the running server
 *
 * Nest can be asked for its router table at runtime, but only from inside the
 * process. Exposing it over HTTP would mean adding a route whose entire purpose
 * is to be read by a test — a production surface bought to make a test easier.
 * The decorators are the registration; reading them is reading the truth, one
 * step earlier. The cost is that a route registered dynamically (none are)
 * would be missed, and that is recorded here rather than papered over.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTROLLER_ROOT = join(HERE, '..', '..', '..', 'apps', 'api', 'src');

const METHOD_DECORATOR = /@(Get|Post|Put|Patch|Delete)\(\s*(?:'([^']*)'|"([^"]*)")?\s*\)/g;
const CONTROLLER_DECORATOR = /@Controller\(\s*(?:'([^']*)'|"([^"]*)")?\s*\)/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.controller.ts')) out.push(full);
  }
  return out;
}

function joinPath(base: string, sub: string): string {
  const parts = [base, sub].filter((p) => p.length > 0).join('/');
  return `/${parts.replace(/\/+/g, '/').replace(/^\/|\/$/g, '')}`;
}

/** Every `METHOD /path` the API's controllers register, sorted. */
export function enumerateControllerRoutes(): string[] {
  const routes: string[] = [];

  for (const file of walk(CONTROLLER_ROOT)) {
    const source = readFileSync(file, 'utf8');
    const controller = CONTROLLER_DECORATOR.exec(source);
    if (!controller) continue;
    const base = controller[1] ?? controller[2] ?? '';

    METHOD_DECORATOR.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = METHOD_DECORATOR.exec(source)) !== null) {
      const method = match[1]!.toUpperCase();
      const sub = match[2] ?? match[3] ?? '';
      routes.push(`${method} ${joinPath(base, sub)}`);
    }
  }

  return [...new Set(routes)].sort();
}

/**
 * Routes this suite actively probes across the tenant boundary.
 *
 * Every id here must be exercised by a real request in `inv6.test.ts`; the
 * suite records which ids it touched and fails if one of these was listed but
 * never called. A list that can be satisfied by writing a line in a list is not
 * coverage.
 */
export const PROBED: readonly string[] = [
  'POST /bookings/hold',
  'GET /bookings',
  'GET /bookings/:id',
  'POST /bookings/:id/checkout',
  'POST /bookings/:id/cancel',
  'POST /bookings/:id/pay',
  'GET /equipment-types',
  'GET /equipment-types/:id',
  'GET /rooms/:id',
  'GET /rooms/:id/availability',
  'GET /rooms/:id/equipment-types',
  'GET /search',
  'GET /venues/cancellation-policy',
  'GET /venues/reports/revenue',
  'PUT /venues/cancellation-policy',
  'GET /admin/reconciliation',
  // Venue administration, added in P8. Writes, which is where tenant isolation
  // actually costs money — a leaked read is an embarrassment, a leaked write
  // changes another venue's prices.
  'GET /venues/settings',
  'PATCH /venues/settings',
  'GET /venues/rooms',
  'POST /venues/rooms',
  'PATCH /venues/rooms/:id',
  'POST /venues/equipment-types',
  'PATCH /venues/equipment-types/:id',
];

/**
 * Routes that are deliberately cross-venue, and what their probe must assert.
 *
 * These are NOT exempt. `/search`, `/rooms/:id` and `/rooms/:id/equipment-types`
 * publish the catalogue: every signed-in user sees every venue's inventory,
 * which is what a marketplace is for. Isolation protects a venue's bookings,
 * customers and revenue — not the existence of its rooms.
 *
 * So the probe cannot be "venue B is refused"; it is **"what comes back is
 * inventory and nothing else"**. That assertion is what keeps the exemption
 * honest over time: the moment one of these grows a utilisation figure, an
 * occupancy count or a revenue column, the projection test fails and somebody
 * has to decide on purpose.
 *
 * Listed here as well as in PROBED so the reason is written down next to the
 * route rather than living only in a test name.
 */
export const CROSS_VENUE_BY_DESIGN: Readonly<Record<string, string>> = {
  'GET /search': 'The catalogue. Publishes name, capacity, amenities, price across every venue.',
  'GET /rooms/:id': 'One row of the same catalogue /search already publishes. Same projection.',
  'GET /rooms/:id/equipment-types':
    'What a booker may attach to this room. Name, hourly rate, units owned — never live usage, utilisation or revenue.',
  'GET /rooms/:id/availability':
    'Free slots for a room in the catalogue. Reports emptiness, never who holds the rest.',
};

/**
 * Routes that carry no tenant scope, each with the reason.
 *
 * The reason is the point. "Exempt" without one is how a venue-scoped endpoint
 * quietly joins this list during a hurried phase.
 */
export const EXEMPT: Readonly<Record<string, string>> = {
  'POST /auth/login': 'Unauthenticated by definition. Returns a token for the credentials given, nothing venue-scoped.',
  'POST /auth/register':
    'Unauthenticated, and always mints a CUSTOMER with venue_id NULL — a role or venue in the body is ignored (verified in P1).',
  'GET /auth/me': 'Reads the caller\'s own row from the token subject. There is no id to tamper with.',
  'GET /health': 'Public liveness/readiness. Reports Postgres reachability and the replica id, no application rows.',
  'POST /webhooks/paygate':
    'Unauthenticated by design and authenticated instead by HMAC over the raw body. Its authorisation is the signature; there is no principal and no venue scope. Covered by the payment-integrity tests, not by this suite.',
};

export interface CoverageResult {
  registered: string[];
  uncovered: string[];
  staleProbed: string[];
  staleExempt: string[];
  /** Cross-venue entries naming a route that no longer exists. */
  staleCrossVenue: string[];
  /**
   * Cross-venue entries that are not also in PROBED.
   *
   * A route cannot buy its way out of the census by declaring itself
   * deliberately cross-venue. The declaration is a statement about WHAT the
   * probe asserts, never a substitute for having one.
   */
  unprobedCrossVenue: string[];
}

export function checkCoverage(): CoverageResult {
  const registered = enumerateControllerRoutes();
  const known = new Set<string>([...PROBED, ...Object.keys(EXEMPT)]);
  const probed = new Set<string>(PROBED);

  return {
    registered,
    uncovered: registered.filter((r) => !known.has(r)),
    staleProbed: PROBED.filter((r) => !registered.includes(r)),
    staleExempt: Object.keys(EXEMPT).filter((r) => !registered.includes(r)),
    staleCrossVenue: Object.keys(CROSS_VENUE_BY_DESIGN).filter(
      (r) => !registered.includes(r),
    ),
    unprobedCrossVenue: Object.keys(CROSS_VENUE_BY_DESIGN).filter((r) => !probed.has(r)),
  };
}

// ---------------------------------------------------------------------------
// Probe ledger
// ---------------------------------------------------------------------------

const touched = new Set<string>();

/** Called by every probe. Turns `PROBED` from a claim into a record. */
export function recordProbe(routeId: string): void {
  touched.add(routeId);
}

export function unprobed(): string[] {
  return PROBED.filter((r) => !touched.has(r));
}
