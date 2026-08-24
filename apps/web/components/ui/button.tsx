import * as React from 'react';
import { Slot } from 'radix-ui';
import { cn } from '@/lib/cn';

/**
 * Three variants and two sizes, and that is the whole set.
 *
 * `primary` is the amber one. DESIGN.md allows the accent twice per screen, so
 * a screen with two primary buttons on it has a hierarchy problem rather than a
 * styling problem — there is deliberately no fourth variant to reach for when
 * that happens.
 *
 * Disabled looks disabled. `opacity-50` alone is the usual shortcut and it
 * makes a disabled control look like a control that is loading; this drops the
 * border weight and the text colour as well, so the affordance itself reads as
 * absent.
 */
type Variant = 'primary' | 'default' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

const VARIANT: Record<Variant, string> = {
  primary:
    'bg-accent text-accent-ink border border-accent hover:bg-accent-deep hover:border-accent-deep disabled:bg-raised disabled:text-ink-muted disabled:border-line',
  default:
    'bg-surface text-ink border border-line-strong hover:bg-raised disabled:bg-canvas disabled:text-ink-muted disabled:border-line',
  ghost:
    'bg-transparent text-ink-muted border border-transparent hover:bg-raised hover:text-ink disabled:text-ink-muted',
  danger:
    'bg-surface text-danger border border-line-strong hover:bg-danger-wash disabled:bg-canvas disabled:text-ink-muted disabled:border-line',
};

const SIZE: Record<Size, string> = {
  sm: 'h-7 px-2 text-xs gap-1',
  md: 'h-8 px-3 text-sm gap-2',
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  asChild?: boolean;
}

export function Button({
  variant = 'default',
  size = 'md',
  asChild = false,
  className,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot.Root : 'button';
  return (
    <Comp
      className={cn(
        'inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded font-medium',
        'transition-quiet',
        'disabled:cursor-not-allowed',
        SIZE[size],
        VARIANT[variant],
        className,
      )}
      {...props}
    />
  );
}
