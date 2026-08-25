import Link from 'next/link';
import { cn } from '@/lib/cn';
import { shortId } from '@/lib/format';
import { hasVenueScope } from '@/lib/session';
import type { Me } from '@/lib/types';
import { SidebarNav, type NavItem } from './sidebar-nav';
import { SignOutButton } from './sign-out-button';

/**
 * The navigation each role's permissions justify — no more, and no less.
 *
 * P7 had one list gated by `isStaff`, which is true for a PLATFORM_ADMIN. So a
 * platform admin was offered a "Venue" item for a venue they do not have, and
 * was offered no route at all to `/admin/reconciliation` — the one report that
 * is theirs alone and that INV-5 is proven by. Both halves of that were wrong
 * in the same way: the nav was describing a rank rather than a set of
 * permissions.
 *
 * The labels differ by role too, because the same route is not the same thing
 * to everyone. `GET /bookings` is scoped by the token: a customer's own rows, a
 * venue's rows, or — for a platform admin, who has no scope — every booking on
 * the platform. Calling that third one "My bookings" would be a lie in the
 * navigation.
 */
function navFor(role: Me['role']): NavItem[] {
  const search: NavItem = { href: '/search', label: 'Search', match: ['/search', '/rooms'] };

  if (role === 'PLATFORM_ADMIN') {
    return [
      search,
      { href: '/bookings', label: 'All bookings', match: ['/bookings', '/checkout'] },
      {
        href: '/reconciliation',
        label: 'Reconciliation',
        match: ['/reconciliation'],
      },
    ];
  }

  const bookings: NavItem = {
    href: '/bookings',
    label: 'My bookings',
    match: ['/bookings', '/checkout'],
  };

  return hasVenueScope(role)
    ? [search, bookings, { href: '/venue', label: 'Venue', match: ['/venue'] }]
    : [search, bookings];
}

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
  const items = navFor(user.role);

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
 * ## "all venues" was the wrong words for two different roles
 *
 * A CUSTOMER's sidebar read "all venues", which describes a privilege. A
 * customer has no venue scope at all: they can browse every venue's catalogue,
 * like anyone, and they can see exactly one person's bookings — their own. A
 * PLATFORM_ADMIN genuinely does have platform-wide reach, and the two were
 * being told the same thing.
 *
 * So each role now says what its token actually means. The venue id stays in
 * mono on hover for the two roles that have one; the name is not fetched here
 * because `GET /venues/settings` is a request per navigation for a label, and
 * the id is what appears in every other identifier on these screens anyway.
 */
function scopeLabel(user: Me): { text: string; title: string } {
  switch (user.role) {
    case 'PLATFORM_ADMIN':
      return {
        text: 'every venue',
        title: 'No venue on this token — platform-wide reach by role.',
      };
    case 'CUSTOMER':
      return {
        text: 'your own bookings',
        title:
          'No venue scope. The room catalogue is public to signed-in users; bookings are yours alone.',
      };
    default:
      return {
        text: user.venueId ? `venue ${shortId(user.venueId)}` : 'no venue on this token',
        title: user.venueId ?? 'No venue on this token',
      };
  }
}

function Identity({ user }: { user: Me }) {
  const scope = scopeLabel(user);

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
          <span className="truncate font-mono text-xs text-ink-muted" title={scope.title}>
            {scope.text}
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
