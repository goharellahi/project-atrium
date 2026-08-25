-- ---------------------------------------------------------------------------
-- Paygate's ledger.
--
-- These tables belong to Paygate and to nothing else. Every name is prefixed
-- `paygate_`, this file is applied by Paygate's own runner against its own
-- `paygate_migrations` table, and there is no foreign key, view or join
-- reaching outside this file in either direction.
--
-- `reference` in particular is NOT a foreign key and must never become one. It
-- holds whatever string the caller passed — the API happens to pass a booking
-- id — exactly as a real provider's `metadata.reference` does. Paygate does not
-- know what a booking is, cannot validate one, and answers identically if the
-- API's schema is dropped.
--
-- The two services share one Postgres instance because the free tier provides
-- one. Splitting them is a connection string; see ARCHITECTURE.md §7.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS paygate_charges (
  id                text PRIMARY KEY,
  reference         text        NOT NULL,
  amount_minor      bigint      NOT NULL CHECK (amount_minor > 0),
  currency          char(3)     NOT NULL,
  idempotency_key   text        NOT NULL UNIQUE,
  correlation_id    text,
  status            text        NOT NULL CHECK (status IN ('processing','succeeded','failed')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  occurred_at       timestamptz,
  -- False between `POST /charges` returning 500 and its retry. A charge that is
  -- not materialised has no outcome and cannot be refunded.
  materialised      boolean     NOT NULL DEFAULT false,
  refunded_minor    bigint      NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0),
  -- Re-derivable from (PAYGATE_SEED, idempotency_key) — `planFor` is pure. Kept
  -- anyway so `GET /paygate/charges/:id` can still show a reviewer which branch
  -- a charge took after the seed has been changed, which is the one case the
  -- derivation cannot reproduce.
  plan              jsonb       NOT NULL,
  attempts          integer     NOT NULL DEFAULT 0,

  -- The provider's own half of INV-5: it cannot hand back more than it took.
  CONSTRAINT paygate_charges_not_over_refunded CHECK (refunded_minor <= amount_minor)
);

CREATE INDEX IF NOT EXISTS paygate_charges_reference_idx ON paygate_charges (reference);

CREATE TABLE IF NOT EXISTS paygate_refunds (
  id                text PRIMARY KEY,
  -- Inside the boundary, so a foreign key here is correct rather than coupling.
  charge_id         text        NOT NULL REFERENCES paygate_charges (id) ON DELETE CASCADE,
  reference         text        NOT NULL,
  amount_minor      bigint      NOT NULL CHECK (amount_minor > 0),
  idempotency_key   text        NOT NULL UNIQUE,
  correlation_id    text,
  status            text        NOT NULL CHECK (status IN ('processing','succeeded')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  occurred_at       timestamptz,
  materialised      boolean     NOT NULL DEFAULT false,
  plan              jsonb       NOT NULL
);

CREATE INDEX IF NOT EXISTS paygate_refunds_charge_idx ON paygate_refunds (charge_id);

-- The idempotency ledger, and the reason `openCharge` is atomic.
--
-- The PRIMARY KEY is what serialises two concurrent requests carrying the same
-- key: whoever inserts owns the resource, and the loser reads back what the
-- winner wrote. In memory that was true by accident, because Node runs one
-- request at a time between awaits. Here it is true on purpose.
CREATE TABLE IF NOT EXISTS paygate_idempotency (
  scope             text        NOT NULL CHECK (scope IN ('charge','refund')),
  key               text        NOT NULL,
  resource_id       text        NOT NULL,
  fingerprint       text        NOT NULL,
  outcome           text        NOT NULL CHECK (outcome IN ('accepted','failed_500')),
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  replays           integer     NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, key)
);

-- Every delivery attempt, recorded BEFORE the HTTP call and updated after it.
--
-- That ordering is the point: a delivery that times out, or that hits a dead
-- callback, still leaves a row. A silent drop inside the provider is
-- indistinguishable from a bug in the API, and this is where a reviewer settles
-- that argument.
CREATE TABLE IF NOT EXISTS paygate_deliveries (
  delivery_id         uuid PRIMARY KEY,
  charge_id           text        NOT NULL REFERENCES paygate_charges (id) ON DELETE CASCADE,
  refund_id           text,
  event               text        NOT NULL,
  attempt             integer     NOT NULL,
  branch              text        NOT NULL,
  signature_corrupted boolean     NOT NULL,
  scheduled_delay_ms  integer     NOT NULL,
  occurred_at         timestamptz NOT NULL,
  sent_at             timestamptz,
  response_status     integer,
  duration_ms         integer,
  error               text,
  correlation_id      text,
  recorded_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS paygate_deliveries_charge_idx
  ON paygate_deliveries (charge_id, recorded_at);
