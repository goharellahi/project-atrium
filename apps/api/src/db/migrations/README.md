# Migrations

Two files, and the split matters.

## `0000_*.sql` — generated

Produced by `drizzle-kit generate` from `../schema.ts`. Tables, enums, indexes,
foreign keys. Regenerate it by changing the schema and running:

```bash
pnpm --filter @atrium/api db:generate
```

One line was removed from it by hand: the `bookings.slot` generated column.
Drizzle 0.45 *can* emit generated columns, but `slot` is moved into `0001` so
that every part of the INV-1 enforcement story — the extension, the generated
column and the exclusion constraint — sits in one hand-written, reviewable file
rather than being split across generated output.

`meta/0000_snapshot.json` still records `slot`, so a future `drizzle-kit
generate` sees the column as present and will not emit a `DROP COLUMN` for it.
Do not delete `slot` from `schema.ts` — that is what keeps the snapshot honest.

## `0001_constraints.sql` — hand written

Never regenerate. Contains:

- `CREATE EXTENSION btree_gist`
- `bookings.slot`, the generated `tstzrange` carrying the 15-minute turnaround
- `no_room_overlap`, the `EXCLUDE USING gist` constraint — this is INV-1
- `audit_events_no_mutate`, the trigger making the audit trail append-only in
  the database rather than by convention
- `CHECK` constraints on role/venue coherence, booking intervals, quantities,
  unit counts and the 10% overbooking cap

It is registered in `meta/_journal.json` as `idx: 1` so `drizzle-kit migrate`
and the runner in `../migrate.ts` both apply it.

## Applying

```bash
pnpm --filter @atrium/api db:migrate
```

In compose this runs as a one-shot `migrate` service that the three API
replicas wait on, so they do not race each other.
