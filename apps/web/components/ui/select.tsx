'use client';

import * as React from 'react';
import { Select as RadixSelect } from 'radix-ui';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * A select that matches everything around it.
 *
 * The native `<select>` cannot: its popup is drawn by the operating system, so
 * the 4px radius, the stone palette, the 13px mono and the hairline stop at the
 * control's edge and the list that opens is whatever the OS feels like. On a
 * screen whose whole argument is that one visual language is applied
 * consistently, that is the one element that gives the game away.
 *
 * Radix supplies the behaviour — typeahead, roving focus, escape, scroll
 * locking, correct ARIA — and every visible surface is ours. The trigger is the
 * same 32px, same border, same hover as `Input`, so a filter row reads as one
 * row of controls rather than three unrelated widgets.
 */
export interface Option {
  value: string;
  label: string;
}

export function Select({
  value,
  onValueChange,
  options,
  placeholder = 'Select…',
  disabled = false,
  ariaLabel,
  className,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: Option[];
  placeholder?: string;
  disabled?: boolean | undefined;
  ariaLabel?: string | undefined;
  className?: string | undefined;
}) {
  return (
    <RadixSelect.Root value={value} onValueChange={onValueChange} disabled={disabled}>
      <RadixSelect.Trigger
        aria-label={ariaLabel}
        className={cn(
          'flex h-8 w-full items-center justify-between gap-2 rounded border border-line-strong bg-surface px-2',
          'text-sm text-ink transition-quiet hover:border-ink-muted',
          'disabled:cursor-not-allowed disabled:border-line disabled:bg-canvas disabled:text-ink-muted',
          'data-[placeholder]:text-ink-muted',
          className,
        )}
      >
        <RadixSelect.Value placeholder={placeholder} />
        <RadixSelect.Icon>
          <ChevronDown className="size-3.5 shrink-0 text-ink-muted" strokeWidth={2} />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>

      <RadixSelect.Portal>
        <RadixSelect.Content
          position="popper"
          sideOffset={4}
          className={cn(
            'z-50 max-h-[320px] min-w-[var(--radix-select-trigger-width)] overflow-hidden',
            'rounded border border-line-strong bg-surface',
          )}
        >
          <RadixSelect.Viewport className="p-1">
            {options.map((option) => (
              <RadixSelect.Item
                key={option.value}
                value={option.value}
                className={cn(
                  'relative flex h-8 cursor-default select-none items-center rounded pl-7 pr-2',
                  'text-sm text-ink outline-none transition-quiet',
                  'data-[highlighted]:bg-raised data-[state=checked]:font-medium',
                )}
              >
                <span className="absolute left-2 flex size-3.5 items-center justify-center">
                  <RadixSelect.ItemIndicator>
                    <Check className="size-3.5" strokeWidth={2.5} />
                  </RadixSelect.ItemIndicator>
                </span>
                <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}
