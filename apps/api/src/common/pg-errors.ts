/**
 * PostgreSQL error classification.
 *
 * Drizzle wraps driver errors in a DrizzleQueryError and puts the pg error on
 * `cause`, so a naive `err.code === '23505'` check silently never matches and
 * the constraint violation escapes as a 500. That is not a cosmetic bug: a hard
 * rule in CLAUDE.md says a rejected write returns a clean 4xx, never a 500, and
 * the whole room-overlap strategy depends on 23P01 being caught here rather
 * than surfacing as a server error under load.
 *
 * The cause chain is walked rather than checked one level deep, because the
 * nesting depth is a driver implementation detail we should not depend on.
 */
export const PG_UNIQUE_VIOLATION = '23505';
export const PG_EXCLUSION_VIOLATION = '23P01';
export const PG_CHECK_VIOLATION = '23514';
export const PG_FOREIGN_KEY_VIOLATION = '23503';

/** Class 40 — transaction rollback. Transient by definition; safe to retry. */
export const PG_SERIALIZATION_FAILURE = '40001';
export const PG_DEADLOCK_DETECTED = '40P01';

interface PgLikeError {
  code?: unknown;
  constraint?: unknown;
  cause?: unknown;
}

/** The SQLSTATE of `err` or of anything in its cause chain, if there is one. */
export function pgErrorCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 8 && current != null; depth += 1) {
    const candidate = current as PgLikeError;
    if (typeof candidate.code === 'string') return candidate.code;
    current = candidate.cause;
  }
  return undefined;
}

/** The violated constraint name, or undefined. */
export function pgConstraintName(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 8 && current != null; depth += 1) {
    const candidate = current as PgLikeError;
    if (typeof candidate.constraint === 'string') return candidate.constraint;
    current = candidate.cause;
  }
  return undefined;
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  if (pgErrorCode(err) !== PG_UNIQUE_VIOLATION) return false;
  return constraint === undefined || pgConstraintName(err) === constraint;
}

/**
 * The room-overlap rejection. This is INV-1 firing, and it must become a 409.
 * Used from the hold path in P2.
 */
export function isExclusionViolation(err: unknown): boolean {
  return pgErrorCode(err) === PG_EXCLUSION_VIOLATION;
}

/**
 * A transient rollback — deadlock (40P01) or serialization failure (40001).
 *
 * This is NOT a rejection. Postgres has thrown the whole transaction away
 * because it could not order it against a concurrent one, and the correct
 * response is to run it again, not to tell the caller their booking failed.
 *
 * Found in P5, by running the 200-request proof rather than by reasoning about
 * it. One request in 200 came back 500 with 40P01 and
 * `while checking exclusion constraint on tuple ... in relation "bookings"`:
 * two hold transactions each ended up waiting on the other's uncommitted
 * speculative insertion, and Postgres broke the cycle by aborting one. INV-1
 * itself held — exactly one booking existed afterwards — but a 500 where a 409
 * belongs is its own fail condition (CLAUDE.md hard rule 3), and the P2 proof
 * had simply never rolled that particular die.
 *
 * The distinction that matters: 23P01 means "this slot is taken" and is a final
 * answer. 40P01 means "ask me again" and carries no information about whether
 * the slot is taken at all.
 */
export function isTransientRollback(err: unknown): boolean {
  const code = pgErrorCode(err);
  return code === PG_DEADLOCK_DETECTED || code === PG_SERIALIZATION_FAILURE;
}

export function isCheckViolation(err: unknown, constraint?: string): boolean {
  if (pgErrorCode(err) !== PG_CHECK_VIOLATION) return false;
  return constraint === undefined || pgConstraintName(err) === constraint;
}
