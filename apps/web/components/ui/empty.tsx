import * as React from 'react';

/**
 * An empty state: one sentence, one action.
 *
 * No illustration, no centred giant icon. A blank panel reads as broken, and an
 * empty state that fills the space with decoration reads as a landing page —
 * the fix for both is a line of plain language that says what happened and what
 * to do next.
 */
export function Empty({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string | undefined;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-3 px-4 py-8">
      <div className="flex flex-col gap-1">
        <p className="text-sm text-ink">{title}</p>
        {hint ? <p className="text-sm text-ink-muted">{hint}</p> : null}
      </div>
      {action}
    </div>
  );
}
