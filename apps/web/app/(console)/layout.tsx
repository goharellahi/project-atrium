import { AppShell } from '@/components/app-shell';
import { requireUser } from '@/lib/session';

/**
 * Everything behind sign-in.
 *
 * The user is resolved once, here, and passed down — `/auth/me` is a call on a
 * free-tier API and asking again on every screen would put a cold start in
 * front of each navigation.
 *
 * Note what this layout no longer does: derive the active nav item. A shared
 * layout is not re-rendered when the router moves between its children, so
 * anything computed here from the request is frozen at the first server render.
 * That is correct behaviour and it is why `SidebarNav` reads the pathname on
 * the client instead. See the comment there.
 */
export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();

  return <AppShell user={user}>{children}</AppShell>;
}
