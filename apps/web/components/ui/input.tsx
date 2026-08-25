import * as React from 'react';
import { cn } from '@/lib/cn';

/**
 * Text, number and select controls, and a label that goes with them.
 *
 * There is deliberately no select here. It used to be the native element, on the
 * argument that this console's lists are short and the native control is already
 * keyboard complete — but a native popup is drawn by the operating system, so
 * every token stopped at the control's edge and it was the one element that gave
 * the screen away. `components/ui/select.tsx` replaces it on Radix. Removing the
 * export rather than deprecating it means nothing can quietly regress.
 */

const CONTROL =
  'h-8 w-full rounded border border-line-strong bg-surface px-2 text-sm text-ink placeholder:text-ink-muted transition-quiet hover:border-ink-muted disabled:cursor-not-allowed disabled:border-line disabled:bg-canvas disabled:text-ink-muted';

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(CONTROL, className)} {...props} />;
}

export function Label({
  className,
  ...props
}: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn('text-xs uppercase tracking-wide text-ink-muted', className)}
      {...props}
    />
  );
}

/** Label above control, 4px apart. Every form field on every screen. */
export function LabelledField({
  label,
  htmlFor,
  hint,
  children,
  className,
}: {
  label: string;
  htmlFor: string;
  hint?: string | undefined;
  children: React.ReactNode;
  className?: string | undefined;
}) {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-ink-muted">{hint}</p> : null}
    </div>
  );
}
