import * as React from 'react';
import { cn } from '@/lib/cn';

/**
 * Text, number and select controls, and a label that goes with them.
 *
 * The select is the native element rather than a Radix listbox. That is a
 * decision, not a shortcut: this console's selects hold two to five short
 * options, the native control is already keyboard complete, already correct on
 * a touch device, and already renders above everything without a portal. Radix
 * earns its keep on a combobox with a hundred options and a filter; the two on
 * this screen would only inherit the maintenance.
 */

const CONTROL =
  'h-8 w-full rounded border border-line-strong bg-surface px-2 text-sm text-ink placeholder:text-ink-muted transition-quiet hover:border-ink-muted disabled:cursor-not-allowed disabled:border-line disabled:bg-canvas disabled:text-ink-muted';

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(CONTROL, className)} {...props} />;
}

export function Select({
  className,
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn(CONTROL, 'pr-6', className)} {...props}>
      {children}
    </select>
  );
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
