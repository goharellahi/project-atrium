/**
 * The shape a sign-in or registration attempt comes back in.
 *
 * In its own module, and not in `actions.ts`, because a `'use server'` file may
 * only export async functions. Exporting the initial-state constant alongside
 * the actions type-checks and builds cleanly and then throws at runtime with
 * "a 'use server' file can only export async functions, found object" the first
 * time a client component imports it — a failure the compiler will not catch
 * for you.
 */
export interface AuthState {
  error: string | null;
  /** Field problems from a 422, keyed by the API's own paths. */
  issues: { path: string; message: string }[];
  /** True when the API was asleep or unreachable, which is not a credentials problem. */
  unreachable: boolean;
}

export const EMPTY_AUTH_STATE: AuthState = { error: null, issues: [], unreachable: false };
