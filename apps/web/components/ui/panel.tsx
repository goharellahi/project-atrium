import * as React from 'react';
import { cn } from '@/lib/cn';

/**
 * A bordered surface. One hairline, 4px radius, and no shadow — DESIGN.md is
 * explicit that cards do not cast one, and a shadow is what makes a dense
 * screen look like a marketing page.
 */
export function Panel({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded border border-line bg-surface', className)}
      {...props}
    />
  );
}

/**
 * A panel header. 12px vertical, 16px horizontal, and the same on every panel:
 * sibling sections that breathe differently read as sloppiness even when nobody
 * can name what is wrong.
 */
export function PanelHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex h-header items-center justify-between gap-3 border-b border-line px-4',
        className,
      )}
      {...props}
    />
  );
}

export function PanelTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn('text-sm font-medium text-ink', className)} {...props} />;
}

export function PanelBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-4', className)} {...props} />;
}

/** A label/value pair. Used wherever a screen states facts rather than lists. */
export function Field({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean | undefined;
}) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs uppercase tracking-wide text-ink-muted">{label}</dt>
      <dd className={cn('text-sm text-ink', mono && 'font-mono text-data')}>{children}</dd>
    </div>
  );
}
