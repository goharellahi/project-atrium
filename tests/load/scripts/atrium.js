/* eslint-disable */
/**
 * Atrium — k6 benchmark for the four endpoints the brief names.
 *
 *   docker run --rm -i --network=atrium_atrium \
 *     -e ATRIUM_BASE_URL=http://nginx:8080 \
 *     -v "$PWD/tests/load/scripts:/scripts" \
 *     grafana/k6 run /scripts/atrium.js
 *
 * ## Through the load balancer, never a replica
 *
 * `ATRIUM_BASE_URL` defaults to nginx on the compose network. Pointing it at
 * api1 would measure one process and report it as the system's latency, which
 * is the same mistake the concurrency proof exists to prevent — and it would
 * quietly hide connection-pool contention, since three replicas share one
 * Postgres and one replica does not.
 *
 * ## All four scenarios run at once
 *
 * The targets are per endpoint, but a p95 measured with nothing else running is
 * a number about an idle machine. These four run concurrently against one
 * database, and each is tagged so its own p95 is still separable. Where a
 * target is missed, LOAD_TEST.md says by how much and against what else was in
 * flight rather than re-running it alone until it passes.
 *
 * ## Holds are real writes
 *
 * The hold scenario inserts against a live exclusion constraint. Its slots come
 * from `GET /rooms/:id/availability` during setup, so every request targets a
 * window the venue is actually open for and no two VUs aim at the same slot. A
 * 409 is therefore a genuine lost race and is counted separately rather than
 * folded into the error rate — 409 is the correct answer to a contended slot,
 * and a benchmark that calls it a failure is measuring the wrong thing.
 */
import http from 'k6/http';
import { check } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';
import exec from 'k6/execution';

const BASE = __ENV.ATRIUM_BASE_URL || 'http://nginx:8080';
const PASSWORD = __ENV.ATRIUM_SEED_PASSWORD || 'AtriumDemo123!';
const DURATION = __ENV.ATRIUM_DURATION || '60s';

// Seeded logins. Printed by `db:seed`; see apps/api/src/db/seed.ts.
const CUSTOMER_EMAIL = __ENV.ATRIUM_CUSTOMER || 'customer@atrium.test';
const VENUE_ADMIN_EMAIL = __ENV.ATRIUM_VENUE_ADMIN || 'admin.a@atrium.test';

// --------------------------------------------------------------------------
// Metrics
// --------------------------------------------------------------------------

const availabilityMs = new Trend('atrium_availability_ms', true);
const searchMs = new Trend('atrium_search_ms', true);
const holdMs = new Trend('atrium_hold_ms', true);
const revenueMs = new Trend('atrium_revenue_ms', true);

// One counter per endpoint, purely so the thresholds below have something with
// a `count` aggregation to assert on — a Trend has none.
const requests = {
  availability: new Counter('atrium_availability_reqs'),
  search: new Counter('atrium_search_reqs'),
  hold: new Counter('atrium_hold_reqs'),
  revenue: new Counter('atrium_revenue_reqs'),
};

const errors = new Rate('atrium_errors');
const holdConflicts = new Counter('atrium_hold_409');
const holdCreated = new Counter('atrium_hold_201');
const holdRejected = new Counter('atrium_hold_4xx_other');

/**
 * `ATRIUM_ONLY=hold` runs one scenario alone.
 *
 * Not a way to make a number look better — the mixed run is the headline and
 * stays the headline. It exists to answer "is this endpoint slow, or is it slow
 * while twenty-five other VUs are on the same database", which is a different
 * question with a different fix, and guessing between the two is how a
 * benchmark produces confident advice about the wrong component.
 */
const ONLY = __ENV.ATRIUM_ONLY || '';

/**
 * Read concurrency, so the offered load can be turned down without changing the
 * mix. The default (10) is the headline run; lower values are how the knee gets
 * located rather than guessed at.
 */
const READ_VUS = Number(__ENV.ATRIUM_READ_VUS || 10);

const allScenarios = {
    availability: {
      executor: 'constant-vus',
      vus: READ_VUS,
      duration: DURATION,
      exec: 'availability',
      tags: { endpoint: 'availability' },
    },
    search: {
      executor: 'constant-vus',
      vus: READ_VUS,
      duration: DURATION,
      exec: 'search',
      tags: { endpoint: 'search' },
    },
    hold: {
      executor: 'constant-arrival-rate',
      rate: 5,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 10,
      maxVUs: 30,
      exec: 'hold',
      tags: { endpoint: 'hold' },
    },
    revenue: {
      executor: 'constant-vus',
      vus: Math.max(1, Math.round(READ_VUS / 2)),
      duration: DURATION,
      exec: 'revenue',
      tags: { endpoint: 'revenue' },
    },
};

export const options = {
  discardResponseBodies: false,
  // p50/p95/p99 are what LOAD_TEST.md reports, and k6's default summary prints
  // neither p99 nor a labelled median. Asked for explicitly so the artifact and
  // the table cannot drift apart.
  summaryTrendStats: ['min', 'med', 'avg', 'p(90)', 'p(95)', 'p(99)', 'max'],
  scenarios: ONLY
    ? { [ONLY]: allScenarios[ONLY] }
    : allScenarios,
  // The brief's numbers, as thresholds rather than as prose. A missed target
  // fails the run, which is the only way a target is a target.
  //
  // `count>0` on every trend is not padding. A threshold over an empty metric
  // passes: a run that dies in setup reports four green ticks and a p(95) of
  // zero, which is how a broken benchmark comes to look like a passing one.
  thresholds: {
    'atrium_availability_ms': ['p(95)<300'],
    'atrium_search_ms': ['p(95)<500'],
    'atrium_hold_ms': ['p(95)<250'],
    'atrium_revenue_ms': ['p(95)<800'],
    ...(ONLY
      ? { [`atrium_${ONLY}_reqs`]: ['count>0'] }
      : {
          'atrium_availability_reqs': ['count>0'],
          'atrium_search_reqs': ['count>0'],
          'atrium_hold_reqs': ['count>0'],
          'atrium_revenue_reqs': ['count>0'],
        }),
    'atrium_errors': ['rate<0.01'],
  },
};

// --------------------------------------------------------------------------
// Setup
// --------------------------------------------------------------------------

function login(email) {
  const res = http.post(
    `${BASE}/auth/login`,
    JSON.stringify({ email, password: PASSWORD }),
    { headers: { 'content-type': 'application/json' } },
  );
  if (res.status !== 200) {
    throw new Error(`login ${email} failed ${res.status}: ${res.body}`);
  }
  return res.json('access_token');
}

/** Round up to the next 30-minute boundary. */
function ceilGrid(ms) {
  const step = 30 * 60 * 1000;
  return Math.ceil(ms / step) * step;
}

export function setup() {
  const customerToken = login(CUSTOMER_EMAIL);
  const adminToken = login(VENUE_ADMIN_EMAIL);

  const me = http.get(`${BASE}/auth/me`, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  if (me.status !== 200) throw new Error(`auth/me failed ${me.status}`);

  // A city with real inventory, taken from the catalogue rather than hardcoded,
  // so a reseed with different cities does not silently benchmark an empty
  // result set. An empty search is the fastest search there is.
  // Authenticated. Search and availability are catalogue endpoints — readable
  // across venues by design (ARCHITECTURE.md Assumption 8) — but they are not
  // anonymous: guards are global and routes opt out, so everything but /health
  // and the auth pair needs a token.
  const auth = { headers: { authorization: `Bearer ${customerToken}` } };
  const catalogue = http.get(`${BASE}/search?page_size=100`, auth);
  if (catalogue.status !== 200) throw new Error(`search failed ${catalogue.status}`);
  const rows = catalogue.json('data');
  if (!rows || rows.length === 0) throw new Error('catalogue is empty — seed first');

  const city = rows[0].city;
  const roomIds = rows.slice(0, 60).map((r) => r.id);

  // Free slots for the hold scenario, read from the availability endpoint so
  // every hold lands inside real operating hours. Far enough ahead that the
  // seeded calendar is sparse there and a 409 means contention between two VUs
  // rather than a collision with seeded data.
  //
  // Three weeks wide across sixty rooms, which is far more than one run needs.
  // The width is for the run AFTER this one: each run creates 301 real holds
  // that live for HOLD_TTL_SECONDS, so a narrow window makes the second
  // consecutive run collide with the first's bookings and the fourth fail
  // setup outright for want of anywhere to aim. Measured: at seven days and
  // forty rooms, the fourth run found 50 free slots and refused to start.
  //
  // 51 days out is still inside the 90-day booking horizon.
  const from = new Date(ceilGrid(Date.now() + 30 * 86_400_000));
  const to = new Date(from.getTime() + 21 * 86_400_000);

  const perRoom = [];
  for (const roomId of roomIds) {
    const res = http.get(
      `${BASE}/rooms/${roomId}/availability?from=${from.toISOString()}&to=${to.toISOString()}&duration_minutes=60`,
      auth,
    );
    if (res.status !== 200) continue;
    const free = res.json('free_slots') || [];

    // Every THIRD free slot, not every one.
    //
    // Availability enumerates starts on the 30-minute grid, so for a 60-minute
    // duration it returns 09:00, 09:30, 10:00 — a list in which consecutive
    // entries overlap each other. Handing those to consecutive iterations means
    // the benchmark competes with itself: the first run of this script took 301
    // holds and got 196 conflicts, and every one of them was the script's own
    // earlier booking, not contention worth measuring. A 60-minute booking plus
    // the 15-minute turnaround occupies 75 minutes, so three grid steps apart
    // is the first spacing that cannot self-collide.
    const spaced = [];
    for (let i = 0; i < free.length; i += 3) spaced.push(free[i]);
    perRoom.push(spaced.map((f) => ({ room_id: roomId, starts_at: f.starts_at, ends_at: f.ends_at })));
  }

  // Round-robin across rooms rather than room-by-room, so VUs running at the
  // same moment are aimed at different rooms and different exclusion-constraint
  // keys. Consecutive iterations on one room would serialise on its advisory
  // lock and report that as the endpoint's latency.
  const slots = [];
  const deepest = Math.max(0, ...perRoom.map((r) => r.length));
  for (let i = 0; i < deepest; i += 1) {
    for (const room of perRoom) if (room[i]) slots.push(room[i]);
  }

  if (slots.length < 100) {
    throw new Error(`only ${slots.length} bookable slots found — the hold scenario needs a populated, open venue`);
  }
  console.log(`setup: ${roomIds.length} rooms, ${slots.length} non-overlapping slots, city=${city}`);

  return {
    customerToken,
    adminToken,
    city,
    roomIds,
    slots,
  };
}

// --------------------------------------------------------------------------
// Scenarios
// --------------------------------------------------------------------------

/** Room availability over a seven-day range — target p95 < 300 ms. */
export function availability(data) {
  const roomId = data.roomIds[exec.scenario.iterationInTest % data.roomIds.length];
  // A rolling window rather than a fixed one, so no two iterations can be
  // answered from an identical cached plan-and-parameters pair.
  const offsetDays = exec.scenario.iterationInTest % 60;
  const from = new Date(ceilGrid(Date.now() + offsetDays * 86_400_000));
  const to = new Date(from.getTime() + 7 * 86_400_000);

  const res = http.get(
    `${BASE}/rooms/${roomId}/availability?from=${from.toISOString()}&to=${to.toISOString()}`,
    {
      headers: { authorization: `Bearer ${data.customerToken}` },
      tags: { endpoint: 'availability' },
    },
  );

  availabilityMs.add(res.timings.duration);
  requests.availability.add(1);
  const ok = check(res, { 'availability 200': (r) => r.status === 200 });
  errors.add(!ok);
}

/** Cross-venue search, every filter at once — target p95 < 500 ms. */
export function search(data) {
  const i = exec.scenario.iterationInTest;
  const capacity = 4 + (i % 12);
  const amenity = ['wifi', 'blackout', 'air_conditioning', 'live_room'][i % 4];
  const ceiling = 400_000 + (i % 10) * 100_000;
  const page = 1 + (i % 3);

  const from = new Date(ceilGrid(Date.now() + (2 + (i % 20)) * 86_400_000));
  const to = new Date(from.getTime() + 2 * 3_600_000);

  const url =
    `${BASE}/search?city=${encodeURIComponent(data.city)}` +
    `&min_capacity=${capacity}` +
    `&amenity=${amenity}` +
    `&max_hourly_rate_minor=${ceiling}` +
    `&from=${from.toISOString()}&to=${to.toISOString()}` +
    `&page=${page}&page_size=20`;

  const res = http.get(url, {
    headers: { authorization: `Bearer ${data.customerToken}` },
    tags: { endpoint: 'search' },
  });

  searchMs.add(res.timings.duration);
  requests.search.add(1);
  const ok = check(res, { 'search 200': (r) => r.status === 200 });
  errors.add(!ok);
}

/** Create hold — target p95 < 250 ms. */
export function hold(data) {
  // A distinct slot per iteration. Two VUs colliding is a real race and is
  // recorded as one; two VUs colliding because the script handed them the same
  // slot would be the script benchmarking its own bug.
  const slot = data.slots[exec.scenario.iterationInTest % data.slots.length];

  const res = http.post(
    `${BASE}/bookings/hold`,
    JSON.stringify({
      room_id: slot.room_id,
      starts_at: slot.starts_at,
      ends_at: slot.ends_at,
      line_items: [],
    }),
    {
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${data.customerToken}`,
      },
      tags: { endpoint: 'hold' },
    },
  );

  holdMs.add(res.timings.duration);
  requests.hold.add(1);

  if (res.status === 201) holdCreated.add(1);
  else if (res.status === 409) holdConflicts.add(1);
  else holdRejected.add(1);

  // 409 is a correct answer, not an error: the slot was taken between this
  // request and the constraint. Anything else in the 4xx/5xx range is not.
  const ok = check(res, {
    'hold 201 or 409': (r) => r.status === 201 || r.status === 409,
  });
  errors.add(!ok);
}

/** Venue revenue report, 30 days — target p95 < 800 ms. */
export function revenue(data) {
  const i = exec.scenario.iterationInTest;
  // Slide the window a day at a time so consecutive iterations are not the
  // identical query answered from the same warm pages.
  const to = new Date(Date.now() - (i % 30) * 86_400_000);
  const from = new Date(to.getTime() - 30 * 86_400_000);

  const res = http.get(
    `${BASE}/venues/reports/revenue?from=${from.toISOString()}&to=${to.toISOString()}`,
    {
      headers: { authorization: `Bearer ${data.adminToken}` },
      tags: { endpoint: 'revenue' },
    },
  );

  revenueMs.add(res.timings.duration);
  requests.revenue.add(1);
  const ok = check(res, { 'revenue 200': (r) => r.status === 200 });
  errors.add(!ok);
}
