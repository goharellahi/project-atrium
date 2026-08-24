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

## Snapshots, and why `generate` is a no-op again (P6)

`drizzle-kit generate` diffs `schema.ts` against the newest snapshot in `meta/`.
Migrations 0005, 0006 and 0007 were hand written and shipped without one, so the
snapshot sat at 0004 and `generate` re-proposed everything those three had
already done — a 0008 that dropped two indexes, added a column and created three
indexes that all existed.

That is worse than untidy. P1's note above explains that a stale snapshot is
exactly how `generate` comes to emit `DROP COLUMN slot` and take INV-1 with it.
It did not this time — the check was run and the output read — but the only
reason to be confident about that is having looked, and the point of a clean
`generate` is not having to.

`meta/0007_snapshot.json` is that snapshot, adopted from the 0008 drizzle-kit
proposed and renumbered to the migration it actually describes. `generate` now
answers "No schema changes, nothing to migrate". **If you hand-write a
migration, refresh the snapshot in the same commit.**

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

## Hand-written migrations: `when` must increase

`meta/_journal.json` entries are applied in `when` order, and drizzle applies
only those whose `when` is greater than the last one already recorded in
`drizzle.__drizzle_migrations`. A hand-authored entry with a `when` lower than
an existing generated one is **silently skipped** — no error, no warning, and
`migrations applied` still prints.

That happened in P5 with `0005_audit_clock_timestamp`: it was given a
hand-picked `when` that fell before the real timestamp `drizzle-kit generate`
had stamped on `0004`, so it never ran and the column default stayed wrong while
the migrate service reported success. When adding an entry by hand, take the
maximum existing `when` and add to it.
