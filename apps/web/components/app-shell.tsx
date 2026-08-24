import Link from 'next/link';
import { cn } from '@/lib/cn';
import type { Me } from '@/lib/types';
import { isStaff } from '@/lib/session';
import { SignOutButton } from './sign-out-button';

/**
 * The frame every console screen sits in.
 *
 * One 48px bar, hairline underneath, no second level of navigation. Four
 * destinations at most and they are the four things this tool does; a sidebar
 * would be structure for its own sake at that count.
 *
 * The current section is marked by weight and an amber underline rather than by
 * a filled background — this is the accent's one appearance on most screens,
 * which leaves the second for the primary action on the page.
 */
export function AppShell({
  user,
  active,
  children,
}: {
  user: Me;
  active: 'search' | 'bookings' | 'venue';
  children: React.ReactNode;
}) {
  const staff = isStaff(user.role);

  const links: { href: string; label: string; key: 'search' | 'bookings' | 'venue' }[] = [
    { href: '/search', label: 'Search', key: 'search' },
    { href: '/bookings', label: 'My bookings', key: 'bookings' },
    ...(staff ? [{ href: '/venue', label: 'Venue', key: 'venue' as const }] : []),
  ];

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-line bg-surface">
        <div className="mx-auto flex h-header max-w-[1400px] items-center gap-6 px-4">
          <Link
            href="/search"
            className="text-sm font-medium tracking-tight text-ink"
            aria-label="Atrium, back to search"
          >
            Atrium
          </Link>

          <nav className="flex h-full items-stretch gap-4" aria-label="Sections">
            {links.map((link) => (
              <Link
                key={link.key}
                href={link.href}
                aria-current={active === link.key ? 'page' : undefined}
                className={cn(
                  'flex items-center border-b-2 text-sm transition-quiet',
                  active === link.key
                    ? 'border-ink font-medium text-ink'
                    : 'border-transparent text-ink-muted hover:text-ink',
                )}
              >
                {link.label}
              </Link>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <div className="hidden flex-col items-end sm:flex">
              <span className="font-mono text-xs text-ink">{user.email}</span>
              <span className="font-mono text-xs uppercase tracking-wide text-ink-muted">
                {user.role.replace('_', ' ')}
              </span>
            </div>
            <SignOutButton />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] px-4 py-6">{children}</main>
    </div>
  );
}

/**
 * A page heading. 20px, tight, with an optional right-hand slot for the one
 * primary action a screen is allowed.
 */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string | undefined;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-lg font-medium text-ink">{title}</h1>
        {description ? <p className="text-sm text-ink-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
