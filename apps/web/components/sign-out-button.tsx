'use client';

import { useTransition } from 'react';
import { signOut } from '@/app/(auth)/actions';
import { Button } from './ui/button';

/**
 * Sign out.
 *
 * A transition rather than a bare form submit so the button can look busy for
 * the moment the cookie is cleared and the redirect resolves — and disabled
 * while it is, because a second click during a redirect is how a user ends up
 * with two navigations racing.
 */
export function SignOutButton() {
  const [pending, startTransition] = useTransition();

  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={pending}
      onClick={() => {
        startTransition(async () => {
          await signOut();
        });
      }}
    >
      {pending ? 'Signing out…' : 'Sign out'}
    </Button>
  );
}
