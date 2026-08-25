import Link from 'next/link';
import { cn } from '@/lib/cn';
import { shortId } from '@/lib/format';
import { isStaff } from '@/lib/session';
import type { Me } from '@/lib/types';
import { SidebarNav, type NavItem } from './sidebar-nav';
import { SignOutButton } from './sign-out-button';

/**
 * The application shell.
 *
 * A persistent sidebar and a content region that do not share a background.
 * That separation is the whole point: chrome sits on `raised`, the page sits on
 * `canvas`, panels sit on `surface`, and a hairline divides them. Three tones
 * from one ramp, each with one job — no shadow is needed to say which layer a
 * thing is on, which is what makes the difference between a product and an
 * unstyled admin template.
 *
 * Below `lg` the sidebar becomes a horizontal bar. A fixed 240px column on a
 * phone is not navigation, it is an obstruction.
 */
export function AppShell({ user, children }: { user: Me; children: React.ReactNode }) {
  const items: NavItem[] = [
    { href: '/search', label: 'Search', match: ['/search', '/rooms'] },
    { href: '/bookings', label: 'My bookings', match: ['/bookings', '/checkout'] },
    ...(isStaff(user.role)
      ? [{ href: '/venue', label: 'Venue', match: ['/venue'] }]
      : []),
  ];

  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      <aside
        className={cn(
          'shrink-0 border-line bg-raised',
          'border-b lg:h-screen lg:w-[240px] lg:border-r lg:border-b-0',
          'lg:sticky lg:top-0 lg:flex lg:flex-col',
        )}
      >
        <div className="flex h-header items-center gap-2 border-line px-4 lg:border-b">
          <Link href="/search" className="flex flex-col leading-none">
            <span className="text-sm font-medium tracking-tight text-ink">Atrium</span>
            <span className="mt-1 text-xs text-ink-muted">Operations console</span>
          </Link>
        </div>

        <div className="lg:flex-1">
          <SidebarNav items={items} />
        </div>

        <Identity user={user} />
      </aside>

      <div className="min-w-0 flex-1">
        <div className="mx-auto max-w-[1440px] px-4 py-6 lg:px-8 lg:py-8">{children}</div>
      </div>
    </div>
  );
}

/**
 * Who you are signed in as, and — the part that matters in a multi-tenant
 * console — which tenant you are acting for.
 *
 * The venue is shown as its id rather than its name, and that is a gap rather
 * than a choice: this API has no endpoint that returns the caller's venue.
 * `/auth/me` carries `venueId` and nothing else, and the only place a venue's
 * name appears is inside the revenue report, which runs four aggregates and
 * demands a date range. Spending that on a label would be the wrong trade, so
 * the id is shown in mono with the full value on hover, and the missing
 * endpoint is recorded in PLAN.md next to the other four.
 */
function Identity({ user }: { user: Me }) {
  return (
    <div className="flex flex-col gap-3 border-line px-4 py-4 lg:border-t">
      <div className="flex flex-col gap-2">
        <p className="truncate font-mono text-data text-ink" title={user.email}>
          {user.email}
        </p>
        <div className="flex flex-col gap-1">
          <span className="font-mono text-xs uppercase tracking-wide text-ink">
            {user.role.replace('_', ' ')}
          </span>
          <span
            className="truncate font-mono text-xs text-ink-muted"
            title={user.venueId ?? 'No venue on this token'}
          >
            {user.venueId ? `venue ${shortId(user.venueId)}` : 'all venues'}
          </span>
        </div>
      </div>
      <SignOutButton />
    </div>
  );
}

/**
 * The page header every screen uses.
 *
 * Title, one line of context, and the screen's single primary action aligned
 * right, over a hairline. Identical on all six screens, so moving between them
 * feels like one application rather than six pages that happen to share a
 * palette.
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
    <header className="mb-6 flex items-start justify-between gap-4 border-b border-line pb-4">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="text-lg font-medium text-ink">{title}</h1>
        {description ? <p className="text-sm text-ink-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}
