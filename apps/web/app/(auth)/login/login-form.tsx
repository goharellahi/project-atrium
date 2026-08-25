'use client';

import { useActionState, useState } from 'react';
import { register, signIn } from '../actions';
import { EMPTY_AUTH_STATE, type AuthState } from '../auth-state';
import { SEED_LOGINS, SEED_PASSWORD } from './credentials';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Input, LabelledField } from '@/components/ui/input';
import { cn } from '@/lib/cn';

/**
 * Sign in, and the seeded accounts that make signing in possible.
 *
 * Two actions share one pair of fields. `useActionState` keeps the form
 * controlled by the server's answer rather than by a local guess about what
 * went wrong, so a 401 and a 422 both render from the API's own words.
 *
 * ## Three fixes from browser testing
 *
 * The password field used to carry a placeholder of bullet characters, so an
 * empty field looked like a filled one and the screen read as pre-populated.
 * The email placeholder was a real seeded address, which compounded it. Both
 * are gone: the placeholder is neutral, the password has none, and the seeded
 * rows on the right — which already fill the form on click — are the way an
 * address gets in.
 *
 * And submitting the form empty produced nothing at all. The action returned a
 * message, but the only thing rendering it was a branch this state never
 * reached. Errors now render in two places at once: a banner for the summary,
 * and against the field itself, keyed on the API's own `issues` paths.
 */
export function LoginForm({ next }: { next?: string | undefined }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const [signInState, signInAction, signingIn] = useActionState(signIn, EMPTY_AUTH_STATE);
  const [registerState, registerAction, registering] = useActionState(
    register,
    EMPTY_AUTH_STATE,
  );

  // Whichever action last produced a result is the one being shown. Both start
  // empty, so before any submission this is simply the empty state.
  const state: AuthState = registerState.error ? registerState : signInState;
  const busy = signingIn || registering;

  const fieldError = (field: string): string | undefined =>
    state.issues.find((issue) => issue.path === field || issue.path.endsWith(`.${field}`))
      ?.message;

  const emailError = fieldError('email');
  const passwordError = fieldError('password');

  return (
    <div className="grid gap-8 lg:grid-cols-[340px_1fr]">
      <section>
        <h1 className="text-lg font-medium text-ink">Sign in</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Access tokens last 15 minutes. The console asks again when one runs out.
        </p>

        <form action={signInAction} className="mt-6 flex flex-col gap-4" noValidate>
          <input type="hidden" name="next" value={next ?? ''} />

          <LabelledField label="Email" htmlFor="email">
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              autoFocus
              aria-invalid={emailError ? true : undefined}
              aria-describedby={emailError ? 'email-error' : undefined}
              className={cn('font-mono text-data', emailError && 'border-danger')}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
            />
            {emailError ? (
              <p id="email-error" className="text-xs text-danger">
                {emailError}
              </p>
            ) : null}
          </LabelledField>

          <LabelledField label="Password" htmlFor="password">
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              aria-invalid={passwordError ? true : undefined}
              aria-describedby={passwordError ? 'password-error' : undefined}
              className={cn('font-mono text-data', passwordError && 'border-danger')}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            {passwordError ? (
              <p id="password-error" className="text-xs text-danger">
                {passwordError}
              </p>
            ) : (
              <p className="text-xs text-ink-muted">
                Registration requires at least 12 characters.
              </p>
            )}
          </LabelledField>

          {state.error ? (
            <Callout tone={state.unreachable ? 'warn' : 'danger'} title={state.error}>
              {state.issues.length > 0 && !emailError && !passwordError ? (
                <ul className="mt-1 flex flex-col gap-1">
                  {state.issues.map((issue, index) => (
                    <li key={`${issue.path}-${index}`} className="flex gap-2 text-sm">
                      <code className="font-mono text-data text-ink">{issue.path}</code>
                      <span>{issue.message}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </Callout>
          ) : null}

          <div className="flex items-center gap-2">
            <Button type="submit" variant="primary" disabled={busy}>
              {signingIn ? 'Signing in…' : 'Sign in'}
            </Button>
            <Button type="submit" formAction={registerAction} disabled={busy}>
              {registering ? 'Registering…' : 'Register as customer'}
            </Button>
          </div>

          {busy ? (
            <p className="reveal-late text-xs text-ink-muted">
              Still waiting on the API. It sleeps after 15 idle minutes and the first
              request takes 30–60 seconds to wake it.
            </p>
          ) : null}
        </form>
      </section>

      <section>
        <h2 className="text-sm font-medium text-ink">Seeded accounts</h2>
        <p className="mt-1 text-sm text-ink-muted">
          Every seeded account shares the password{' '}
          <code className="font-mono text-data text-ink">{SEED_PASSWORD}</code>. Pick one
          to fill the form.
        </p>

        <ul className="mt-4 divide-y divide-line overflow-hidden rounded border border-line bg-surface">
          {SEED_LOGINS.map((login) => (
            <li key={login.email}>
              <button
                type="button"
                onClick={() => {
                  setEmail(login.email);
                  setPassword(SEED_PASSWORD);
                }}
                className="flex w-full items-center gap-3 px-3 py-2 text-left transition-quiet hover:bg-raised"
              >
                <span className="w-[124px] shrink-0 font-mono text-xs uppercase tracking-wide text-ink">
                  {login.role}
                </span>
                <span className="flex-1 truncate font-mono text-data text-ink-muted">
                  {login.email}
                </span>
                <span className="shrink-0 text-xs text-ink-muted">{login.scope}</span>
              </button>
            </li>
          ))}
        </ul>

        <p className="mt-3 text-xs text-ink-muted">
          The two venue admins are at different venues on purpose — that is the pair
          tenant isolation has to be demonstrated against, and one account cannot do it.
        </p>
      </section>
    </div>
  );
}
