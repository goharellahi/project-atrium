import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { hasSession } from '@/lib/session';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Sign in · Atrium' };

/**
 * The way in.
 *
 * Two columns and no hero. The left is the form; the right is the seeded
 * accounts, each one a button that fills the form rather than a line of text to
 * retype. Nothing is centred in a viewport-height flex container — this is the
 * first screen of an application, not a landing page, and it is laid out like
 * the five screens behind it.
 *
 * The whole panel is one client component. The account list has to write into
 * the form's fields, so splitting the prose out to save a few hundred bytes
 * would mean lifting state through a context for no benefit anyone can measure.
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
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex h-header max-w-[1100px] items-center px-4">
          <span className="text-sm font-medium tracking-tight text-ink">Atrium</span>
          <span className="ml-3 text-sm text-ink-muted">Operations console</span>
        </div>
      </header>

      <main className="mx-auto max-w-[1100px] px-4 py-8">
        <LoginForm next={next} />
      </main>
    </div>
  );
}
