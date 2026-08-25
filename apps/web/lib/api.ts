/**
 * The only place this application talks to the Atrium API.
 *
 * ## Why every call is server-side
 *
 * The API sets no `Access-Control-Allow-Origin` — verified against the deployed
 * instance, not assumed — so a browser on a Vercel origin cannot call it
 * directly at all. Enabling CORS is an `apps/api` change and this phase does not
 * touch `apps/api`, so the console reaches the API from the Next server
 * instead: server components read, server actions write, and exactly one route
 * handler exists for the one thing the browser must poll.
 *
 * `next/headers` is imported below, which is itself the guard: importing this
 * module from a client component is a build error rather than a leak. There is
 * no `server-only` package in the lockfile and adding one to restate what the
 * compiler already enforces would be an unpinned dependency for nothing.
 *
 * That constraint turns out to buy the better design anyway. The access token
 * lives in an httpOnly cookie and is attached here; no bearer token is ever
 * serialised into HTML or reachable from client JavaScript, so an XSS in the
 * console cannot walk away with a session.
 */

import { cookies } from 'next/headers';

/** Render's free tier sleeps after 15 idle minutes; a cold start is 30–60s. */
const COLD_START_TIMEOUT_MS = 75_000;

export const SESSION_COOKIE = 'atrium_token';

/**
 * Where the API lives.
 *
 * `API_URL` is consulted first and `NEXT_PUBLIC_API_URL` is the fallback, which
 * is the opposite of the obvious order and is deliberate. Next inlines every
 * `process.env.NEXT_PUBLIC_*` reference at build time — in server code as well
 * as client — so a deployment configured only through that name is pinned to
 * whatever URL was set when the bundle was built, and pointing the console at a
 * different API means a rebuild. `API_URL` is read at runtime, so it can be
 * changed by restarting the process.
 *
 * `NEXT_PUBLIC_API_URL` stays supported because it is what the deployment
 * already sets and because nothing here is secret: the URL is public, and no
 * client component imports this module.
 */
function baseUrl(): string {
  const url = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL;
  if (!url) {
    throw new Error(
      'Neither API_URL nor NEXT_PUBLIC_API_URL is set — the console has no API to talk to.',
    );
  }
  return url.replace(/\/+$/, '');
}

/**
 * A failed API call, carrying the API's own words.
 *
 * The console never invents a message for a 409 or a 422. Under concurrency the
 * API's 409 text says which slot was taken and why, and a generic "Something
 * went wrong" throws that away — so `message` here is whatever the API said,
 * and `body` keeps the rest of the payload (`issues`, `current_status`,
 * `room_id`, `reason`) for the screens that render it.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;

  constructor(status: number, message: string, body: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }

  /** Field-level validation problems, when the API sent any. */
  get issues(): { path: string; message: string }[] {
    const raw = this.body.issues;
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((issue) => {
      if (typeof issue !== 'object' || issue === null) return [];
      const record = issue as Record<string, unknown>;
      return [
        {
          path: typeof record.path === 'string' ? record.path : '',
          message: typeof record.message === 'string' ? record.message : '',
        },
      ];
    });
  }

  get<T>(key: string): T | undefined {
    return this.body[key] as T | undefined;
  }
}

/** The API did not answer at all — asleep, or down. Distinct from a 5xx. */
export class ApiUnreachableError extends Error {
  readonly timedOut: boolean;
  constructor(message: string, timedOut: boolean) {
    super(message);
    this.name = 'ApiUnreachableError';
    this.timedOut = timedOut;
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT';
  body?: unknown;
  /** Send the session token. Off for /auth/login and /auth/register. */
  auth?: boolean;
  /** Passed to fetch's Next cache. Everything here is per-user, so: no store. */
  revalidate?: number | false;
  signal?: AbortSignal;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, auth = true, revalidate = false } = options;

  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';

  if (auth) {
    const token = (await cookies()).get(SESSION_COOKIE)?.value;
    // No token is a 401 without a round trip. The screens treat 401 as "sign in
    // again", which is the honest answer for a 15-minute access token that has
    // simply run out.
    if (!token) throw new ApiError(401, 'Your session has ended. Sign in again.');
    headers.authorization = `Bearer ${token}`;
  }

  let response: Response;
  try {
    // Built rather than spread with `undefined`s in it: `exactOptionalPropertyTypes`
    // is on across this repository, and `body: undefined` is not the same type as
    // an absent body.
    const init: RequestInit & { next?: { revalidate: number } } = {
      method,
      headers,
      signal: options.signal ?? AbortSignal.timeout(COLD_START_TIMEOUT_MS),
      cache: 'no-store',
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    if (revalidate !== false) init.next = { revalidate };

    response = await fetch(`${baseUrl()}${path}`, init);
  } catch (err: unknown) {
    const timedOut = err instanceof Error && err.name === 'TimeoutError';
    throw new ApiUnreachableError(
      timedOut
        ? `The API did not answer within ${COLD_START_TIMEOUT_MS / 1000} seconds.`
        : 'The API could not be reached.',
      timedOut,
    );
  }

  const text = await response.text();
  const payload = text.length > 0 ? safeJson(text) : {};

  if (!response.ok) {
    const record = isRecord(payload) ? payload : {};
    const message =
      typeof record.message === 'string'
        ? record.message
        : Array.isArray(record.message)
          ? record.message.join(', ')
          : `The API returned ${response.status}.`;
    throw new ApiError(response.status, message, record);
  }

  return payload as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Build a querystring, dropping empties so `?city=` never reaches the API. */
export function qs(params: Record<string, string | number | string[] | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const entry of value) if (entry !== '') search.append(key, entry);
    } else if (value !== '') {
      search.set(key, String(value));
    }
  }
  const encoded = search.toString();
  return encoded.length > 0 ? `?${encoded}` : '';
}
