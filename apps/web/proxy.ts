import { NextResponse, type NextRequest } from 'next/server';

/**
 * Publish the request path as a header.
 *
 * A layout cannot read the pathname — Next gives it `params`, not the URL, and
 * that is deliberate: a layout that re-rendered on every navigation would
 * defeat its own caching. The console needs the path in exactly one place, to
 * mark the active item in the nav bar, and a request header set here is the
 * supported way to get it there.
 *
 * The alternative is a client component calling `usePathname`, which would make
 * the whole application shell a client component in order to underline one
 * word.
 *
 * The file is `proxy.ts` rather than `middleware.ts`: Next 16.3 renamed the
 * convention and warns on the old name at build time.
 */
export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set('x-atrium-path', request.nextUrl.pathname);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
