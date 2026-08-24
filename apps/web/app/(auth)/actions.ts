'use server';

import { redirect } from 'next/navigation';
import { api, ApiError, ApiUnreachableError } from '@/lib/api';
import { clearSession, setSession } from '@/lib/session';
import type { AuthState } from './auth-state';

/**
 * Sign in, sign up, sign out.
 *
 * Server actions rather than a route handler and a fetch, for the reason the
 * whole console is server-side: the API sets no CORS headers, so the browser
 * cannot reach it. Here that constraint is a straight win — the password is
 * posted to the Next server, exchanged for a token, and the token goes into an
 * httpOnly cookie. It never enters the document and no client bundle has a code
 * path that could read it.
 */

interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
}

/** Only same-origin paths are honoured, so `?next=` cannot become an open redirect. */
function safeNext(value: FormDataEntryValue | null): string {
  const next = typeof value === 'string' ? value : '';
  return next.startsWith('/') && !next.startsWith('//') ? next : '/search';
}

export async function signIn(_previous: AuthState, formData: FormData): Promise<AuthState> {
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const next = safeNext(formData.get('next'));

  if (email === '' || password === '') {
    return { error: 'Enter an email address and a password.', issues: [], unreachable: false };
  }

  try {
    const token = await api<TokenResponse>('/auth/login', {
      method: 'POST',
      auth: false,
      body: { email, password },
    });
    await setSession(token.access_token, token.expires_in);
  } catch (err: unknown) {
    return toAuthState(err);
  }

  // Outside the try. `redirect` works by throwing, and catching it here would
  // turn a successful sign-in into "The API returned an error".
  redirect(next);
}

/**
 * Self-registration, which the API restricts to CUSTOMER.
 *
 * It is on the login screen rather than hidden behind a link because the
 * deployed database is not seeded: registration is the only way in on that
 * instance, and a reviewer who cannot get past the first screen never sees the
 * rest of the console.
 */
export async function register(_previous: AuthState, formData: FormData): Promise<AuthState> {
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');

  if (password.length < 12) {
    return {
      error: 'The API requires a password of at least 12 characters.',
      issues: [],
      unreachable: false,
    };
  }

  try {
    const token = await api<TokenResponse>('/auth/register', {
      method: 'POST',
      auth: false,
      body: { email, password },
    });
    await setSession(token.access_token, token.expires_in);
  } catch (err: unknown) {
    return toAuthState(err);
  }

  redirect('/search');
}

export async function signOut(): Promise<void> {
  await clearSession();
  redirect('/login');
}

function toAuthState(err: unknown): AuthState {
  if (err instanceof ApiUnreachableError) {
    return {
      error: `${err.message} It is deployed on a free tier that sleeps after 15 idle minutes; the first request wakes it and can take 30–60 seconds. Try again.`,
      issues: [],
      unreachable: true,
    };
  }
  if (err instanceof ApiError) {
    return { error: err.message, issues: err.issues, unreachable: false };
  }
  throw err;
}
