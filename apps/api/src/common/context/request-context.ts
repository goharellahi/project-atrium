import { AsyncLocalStorage } from 'node:async_hooks';
import type { UserRole } from '../../db/schema';

/**
 * The authenticated caller, as the rest of the application is allowed to see
 * them.
 *
 * `venueId` here is the ONLY trustworthy source of tenant scope. It comes from
 * the verified JWT. A venue_id appearing in a URL or body is an input to
 * authorise against, never a source of truth (CLAUDE.md, hard rule 4).
 */
export interface AuthPrincipal {
  userId: string;
  role: UserRole;
  /** NULL for CUSTOMER and PLATFORM_ADMIN. */
  venueId: string | null;
}

export interface RequestContext {
  /** From X-Request-Id, or generated. Survives into outbound Paygate calls. */
  correlationId: string;
  principal: AuthPrincipal | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

export function getCorrelationId(): string {
  return storage.getStore()?.correlationId ?? 'no-context';
}

/**
 * The principal, or a thrown error.
 *
 * Deliberately throwing rather than returning null: a repository reaching for
 * tenant scope outside an authenticated request is a bug, and failing loudly is
 * the point. Silently returning null would let a query run unscoped.
 */
export function requirePrincipal(): AuthPrincipal {
  const principal = storage.getStore()?.principal;
  if (!principal) {
    throw new Error(
      'No authenticated principal in request context. A venue-scoped query ran outside an authenticated request.',
    );
  }
  return principal;
}

export function setPrincipal(principal: AuthPrincipal): void {
  const store = storage.getStore();
  if (store) store.principal = principal;
}
