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

export function isCheckViolation(err: unknown, constraint?: string): boolean {
  if (pgErrorCode(err) !== PG_CHECK_VIOLATION) return false;
  return constraint === undefined || pgConstraintName(err) === constraint;
}
