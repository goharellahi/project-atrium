import { redirect } from 'next/navigation';
import { hasSession } from '@/lib/session';

/**
 * There is no home page.
 *
 * An operations console opens on work. `/` decides between the search screen
 * and the sign-in screen and gets out of the way; a landing page here would be
 * a page every user passes through and nobody reads.
 */
export default async function RootPage() {
  redirect((await hasSession()) ? '/search' : '/login');
}
