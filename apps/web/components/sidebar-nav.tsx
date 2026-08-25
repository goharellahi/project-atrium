'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';

/**
 * The navigation list, and the only client component in the shell.
 *
 * ## Why `usePathname` and not the request header
 *
 * The previous version derived the active item in the layout from an
 * `x-atrium-path` header set by a proxy. The header worked; the consumer did
 * not. A shared layout in the App Router is **not re-rendered when navigating
 * between its own children** — that is what lets a layout hold scroll position
 * and form state across navigation — so `active` was computed once on the first
 * server render and never again.
 *
 * Measured rather than reasoned about, in a browser:
 *
 *   hard load /search              Search active      ✓
 *   click through to /bookings     Search STILL active ✗
 *   hard reload /bookings          My bookings active ✓
 *
 * The third line is the proof that the header arrives intact — a server render
 * of `/bookings` marks the right item every time. Only client-side navigation
 * is wrong, because on that path no server render happens at all.
 *
 * So active-nav state is inherently a client-router concern, and `usePathname`
 * is the correct answer rather than a workaround. The cost is kept to this file:
 * the surrounding shell, the identity block and the page headers all stay server
 * components, and `proxy.ts` was deleted because nothing consumes it any more.
 */
export interface NavItem {
  href: string;
  label: string;
  /** Sections whose sub-routes should also light this item up. */
  match: string[];
}

export function SidebarNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-1 p-2" aria-label="Sections">
      {items.map((item) => {
        const active = item.match.some(
          (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
        );

        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex h-8 items-center rounded border px-3 text-sm transition-quiet',
              active
                ? 'border-line bg-surface font-medium text-ink'
                : 'border-transparent text-ink-muted hover:bg-surface/60 hover:text-ink',
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
