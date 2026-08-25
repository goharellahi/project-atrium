import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { hasSession } from '@/lib/session';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Sign in · Atrium' };

/**
 * The way in.
 *
 * The one screen outside the application shell, so it carries its own chrome —
 * the same product mark on the same `raised` band, over the same `canvas` page,
 * so arriving at the console after signing in is a continuation rather than a
 * change of application.
 *
 * Nothing is centred in a viewport-height flex container. This is the first
 * screen of a tool, not a landing page, and it is laid out like the six behind
 * it.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  if (await hasSession()) redirect('/search');
  const { next } = await searchParams;

  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-raised">
        <div className="mx-auto flex h-header max-w-[1120px] items-center px-6">
          <span className="text-sm font-medium tracking-tight text-ink">Atrium</span>
          <span className="ml-3 text-sm text-ink-muted">Operations console</span>
        </div>
      </header>

      <main className="mx-auto max-w-[1120px] px-6 py-10">
        <LoginForm next={next} />
      </main>
    </div>
  );
}
