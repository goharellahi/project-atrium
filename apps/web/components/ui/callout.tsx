import * as React from 'react';
import { cn } from '@/lib/cn';

/**
 * The API's own answer, rendered.
 *
 * Three tones, and the distinction between the first two is the point of this
 * component. A 409 from the hold path is not a failure — under concurrency it
 * is the expected answer for every request but the first, and the API's message
 * says which slot went and why. Showing that in the same red box as a crash
 * teaches an operator to distrust the tool. So:
 *
 *   `info`   — a 409, and anything else that is the world saying no. Neutral.
 *   `warn`   — something is in flight or unresolved. Carries the accent.
 *   `danger` — a genuine failure. The only tone that is red.
 *
 * `title` is always the API's message where there is one. Nothing here invents
 * copy on the API's behalf.
 */
type Tone = 'info' | 'warn' | 'danger';

const TONE: Record<Tone, string> = {
  info: 'border-line-strong bg-raised text-ink',
  warn: 'border-accent bg-accent-wash text-ink',
  danger: 'border-danger bg-danger-wash text-ink',
};

export function Callout({
  tone = 'info',
  title,
  children,
  className,
}: {
  tone?: Tone | undefined;
  title: React.ReactNode;
  children?: React.ReactNode;
  className?: string | undefined;
}) {
  return (
    <div className={cn('enter rounded border p-3', TONE[tone], className)} role="status">
      <p className="text-sm font-medium">{title}</p>
      {children ? <div className="mt-1 text-sm text-ink-muted">{children}</div> : null}
    </div>
  );
}

/**
 * A 422's field problems, listed.
 *
 * The API returns `issues: [{ path, message }]` and the paths are real — `to`,
 * `ends_at`, `line_items.0.equipment_type_id`. Printing the path alongside the
 * message is what lets a reviewer match the complaint to the control, and it is
 * cheaper and more truthful than mapping every path to a field label and
 * silently dropping the ones that have no mapping.
 */
export function IssueList({ issues }: { issues: { path: string; message: string }[] }) {
  if (issues.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-col gap-1">
      {issues.map((issue, index) => (
        <li key={`${issue.path}-${index}`} className="flex gap-2 text-sm">
          {issue.path ? (
            <code className="shrink-0 font-mono text-data text-ink">{issue.path}</code>
          ) : null}
          <span className="text-ink-muted">{issue.message}</span>
        </li>
      ))}
    </ul>
  );
}
