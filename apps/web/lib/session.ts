/**
 * The console's own session.
 *
 * The API issues a 15-minute bearer token and nothing else — no refresh token,
 * no server session. So the console stores exactly that, in an httpOnly cookie,
 * and treats a 401 from any call as "it ran out, sign in again" rather than as
 * an error. That is the honest reading: a 15-minute token expiring mid-session
 * is the normal case for a tool someone leaves open all day, and pretending
 * otherwise would produce a screen full of red for a routine event.
 */

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { api, ApiError, SESSION_COOKIE } from './api';
import type { Me } from './types';

/** Matches the API's `expires_in` (900s). One minute of slack for clock skew. */
const COOKIE_MAX_AGE_SECONDS = 900 - 60;

export async function setSession(accessToken: string, expiresIn: number): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, accessToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: Math.max(60, Math.min(expiresIn, COOKIE_MAX_AGE_SECONDS)),
  });
}

export async function clearSession(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}

export async function hasSession(): Promise<boolean> {
  return (await cookies()).get(SESSION_COOKIE) !== undefined;
}

/**
 * The current user, or a redirect to the login screen.
 *
 * `next` is carried through so signing back in returns to the page that was
 * being read, rather than dumping the operator on the search screen with their
 * place lost.
 */
export async function requireUser(returnTo?: string): Promise<Me> {
  try {
    return await api<Me>('/auth/me');
  } catch (err: unknown) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      const suffix = returnTo ? `?next=${encodeURIComponent(returnTo)}` : '';
      redirect(`/login${suffix}`);
    }
    throw err;
  }
}

/** Roles that see venue-wide data rather than their own bookings. */
export function isStaff(role: Me['role']): boolean {
  return role === 'VENUE_ADMIN' || role === 'VENUE_STAFF' || role === 'PLATFORM_ADMIN';
}
