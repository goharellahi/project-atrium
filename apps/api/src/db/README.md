# apps/api/src/db

The Drizzle schema, migrations and connection pool live here, inside the API
application. There is deliberately no separate `packages/db` workspace: exactly
one service writes to this database, so a shared package would add a build
boundary without buying isolation.

| File | Role |
| --- | --- |
| `schema.ts` | Table, enum and index definitions |
| `client.ts` | pg `Pool` + Drizzle instance factories |
| `migrate.ts` | One-shot migration runner |
| `migrations/` | See `migrations/README.md` — the split between generated and hand-written matters |

The room-overlap exclusion constraint, the generated `slot` column and the
audit-trail immutability trigger are hand-written SQL in
`migrations/0001_constraints.sql`, not Drizzle DSL. See ARCHITECTURE.md,
"Concurrency Strategy".
