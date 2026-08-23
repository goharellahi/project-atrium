import { NotFoundException } from '@nestjs/common';
import { and, eq, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { Db } from '../db/client';
import { requirePrincipal, type AuthPrincipal } from '../common/context/request-context';

/**
 * Tenant isolation (INV-6), enforced in one place.
 *
 * The rule: every query against a venue-scoped table takes `venue_id` from the
 * request context. A `venue_id` in a URL or body is an input to authorise
 * against, never a source of truth.
 *
 * Why this lives at the repository layer rather than in controllers or a guard:
 * a guard sees the route, not the row. It can check that a VENUE_ADMIN is
 * allowed to call `GET /bookings/:id`, but it cannot know which venue that
 * particular booking belongs to without doing the query itself. Pushing the
 * filter down to the only layer that touches the database means a new endpoint
 * cannot forget it — there is no unscoped read to forget.
 *
 * PLATFORM_ADMIN bypasses the filter. Nobody else can.
 */
export abstract class VenueScopedRepository {
  protected constructor(protected readonly db: Db) {}

  /**
   * The venue filter for the current principal, or `undefined` for
   * PLATFORM_ADMIN (meaning: no filter).
   *
   * Throws if there is no principal. A venue-scoped query running outside an
   * authenticated request is a bug, and it must fail loudly rather than
   * silently returning everything.
   */
  protected venueFilter(column: PgColumn): SQL | undefined {
    const principal = requirePrincipal();

    if (principal.role === 'PLATFORM_ADMIN') return undefined;

    if (principal.venueId === null) {
      // A CUSTOMER has no venue scope. Customer-owned resources are filtered by
      // user_id instead — see `ownerFilter`. Reaching here means a customer hit
      // a venue-scoped read path, which is a routing bug, not a data question.
      throw new NotFoundException();
    }

    return eq(column, principal.venueId);
  }

  /** Restrict to rows owned by the calling user. CUSTOMER reads use this. */
  protected ownerFilter(column: PgColumn): SQL | undefined {
    const principal = requirePrincipal();
    if (principal.role === 'PLATFORM_ADMIN') return undefined;
    return eq(column, principal.userId);
  }

  /**
   * Compose the tenant filter with query-specific predicates.
   *
   * Always call this rather than building `and(...)` by hand — it is what makes
   * "did this query get scoped?" a question with one answer.
   */
  protected scoped(
    venueColumn: PgColumn,
    ...predicates: (SQL | undefined)[]
  ): SQL | undefined {
    return and(this.venueFilter(venueColumn), ...predicates);
  }

  protected principal(): AuthPrincipal {
    return requirePrincipal();
  }

  /**
   * 404, not 403, for a resource belonging to another venue.
   *
   * The brief requires "a 403 or 404, and never data". We return 404 because
   * 403 confirms the row exists — a VENUE_ADMIN of Venue A probing UUIDs could
   * distinguish "this booking exists but is not yours" from "no such booking"
   * and enumerate another venue's identifiers. 404 leaks nothing.
   *
   * The cost is worse ergonomics for legitimate users, who cannot tell a typo
   * from a permissions problem. That trade is accepted; it is recorded in
   * DECISIONS.md and in ARCHITECTURE.md under Assumptions.
   */
  protected notFound(): never {
    throw new NotFoundException();
  }

  /** Returns the row, or throws 404 — never `null` that a caller might ignore. */
  protected requireOne<T>(rows: T[]): T {
    const row = rows[0];
    if (row === undefined) this.notFound();
    return row;
  }
}
