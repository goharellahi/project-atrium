'use client';

import { useEffect, useState } from 'react';
import { clock } from '@/lib/format';

/**
 * The hold countdown.
 *
 * This is the visible face of the hold TTL and it is the thing a walkthrough
 * recording will point a camera at, so it is worth being exact about:
 *
 *   - The digits are mono and tabular. `mm:ss`, zero padded. A clock whose
 *     width changes as it ticks is the single most obvious tell of an interface
 *     nobody looked at, and this one ticks sixty times a minute in front of the
 *     reader.
 *   - The bar is a width transition, linear, one second at a time — matching
 *     the tick rather than animating between arbitrary values. DESIGN.md calls
 *     smooth linear progress the one exception to "no animation", and this is
 *     it. Under `prefers-reduced-motion` the global rule collapses the
 *     transition and the bar simply steps; the number carries the information
 *     either way.
 *   - It reads the deadline off the server's `expires_at` and recomputes from
 *     `Date.now()` on every tick rather than decrementing a counter. A tab
 *     backgrounded for four minutes comes back showing the truth instead of
 *     four minutes of missed intervals.
 *   - It calls `onExpire` once, when it crosses zero. The screen behind it has
 *     to stop offering a Pay button the API will refuse.
 */
export function Countdown({
  expiresAt,
  totalMs,
  onExpire,
}: {
  expiresAt: string;
  /** The full hold window, for the bar's denominator. */
  totalMs: number;
  onExpire?: (() => void) | undefined;
}) {
  const deadline = new Date(expiresAt).getTime();
  const [remaining, setRemaining] = useState(() => Math.max(0, deadline - Date.now()));

  useEffect(() => {
    setRemaining(Math.max(0, deadline - Date.now()));

    const timer = window.setInterval(() => {
      setRemaining(Math.max(0, deadline - Date.now()));
    }, 1000);

    return () => window.clearInterval(timer);
  }, [deadline]);

  const expired = remaining <= 0;

  useEffect(() => {
    if (expired) onExpire?.();
  }, [expired, onExpire]);

  const fraction = totalMs > 0 ? Math.min(1, Math.max(0, remaining / totalMs)) : 0;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <span className="text-xs uppercase tracking-wide text-ink-muted">
          {expired ? 'Hold expired' : 'Hold expires in'}
        </span>
        <span
          className={expired ? 'font-mono text-xl text-ink-muted' : 'font-mono text-xl text-ink'}
          role="timer"
        >
          {clock(remaining)}
        </span>
      </div>

      <div
        className="h-1 w-full overflow-hidden rounded-full bg-raised"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(fraction * 100)}
        aria-label="Time remaining on this hold"
      >
        <div
          className={expired ? 'h-full bg-line-strong' : 'h-full bg-accent'}
          style={{ width: `${fraction * 100}%`, transition: 'width 1s linear' }}
        />
      </div>
    </div>
  );
}
