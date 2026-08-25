import { headers } from 'next/headers';
import { AppShell } from '@/components/app-shell';
import { requireUser } from '@/lib/session';

/**
 * Everything behind sign-in.
 *
 * The user is resolved once, here, and passed down — `/auth/me` is one call on
 * a free-tier API and asking for it again on every screen would put a cold
 * start in front of each navigation.
 *
 * The active section is derived from the request path rather than passed by
 * each page, because a page that forgets to say which nav item it is leaves the
 * bar looking like nothing is selected, and that is a bug nobody files.
 */
export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const path = (await headers()).get('x-atrium-path') ?? '';
  const user = await requireUser(path || undefined);

  const active = path.startsWith('/venue')
    ? 'venue'
    : path.startsWith('/bookings') || path.startsWith('/checkout')
      ? 'bookings'
      : 'search';

  return (
    <AppShell user={user} active={active}>
      {children}
    </AppShell>
  );
}
