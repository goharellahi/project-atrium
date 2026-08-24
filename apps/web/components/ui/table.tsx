import * as React from 'react';
import { cn } from '@/lib/cn';

/**
 * The table.
 *
 * 34px rows, 13px type, a sticky header, hover but no zebra striping, and
 * numbers right-aligned and tabular.
 *
 * The wrapper scrolls in both directions rather than only across. That is what
 * makes the sticky header work: `overflow-x: auto` on its own computes
 * `overflow-y` to `auto` as well, so the wrapper becomes the scroll container
 * while never actually scrolling in it — and a header stuck to a container that
 * does not scroll never sticks to anything. Capping the height gives it
 * something to stick against.
 * The one rule that is easy to lose is
 * column width: every table below fixes its columns with a `<colgroup>` so a
 * page of short room names and a page of long ones do not lay out differently.
 * A layout that jumps between result sets is the thing that makes a list feel
 * unreliable, and it costs one element to prevent.
 */

export function TableScroll({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('max-h-[70vh] w-full overflow-auto', className)} {...props} />;
}

export function Table({ className, ...props }: React.TableHTMLAttributes<HTMLTableElement>) {
  return (
    <table
      className={cn('w-full table-fixed border-collapse text-data', className)}
      {...props}
    />
  );
}

export function THead({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead
      className={cn('sticky top-0 z-10 bg-raised text-ink-muted', className)}
      {...props}
    />
  );
}

export function TH({
  className,
  numeric = false,
  ...props
}: React.ThHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean | undefined }) {
  return (
    <th
      scope="col"
      className={cn(
        'h-row border-b border-line px-3 text-xs font-medium uppercase tracking-wide',
        numeric ? 'text-right' : 'text-left',
        className,
      )}
      {...props}
    />
  );
}

export function TBody(props: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody {...props} />;
}

export function TR({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={cn(
        'h-row border-b border-line transition-quiet hover:bg-raised',
        className,
      )}
      {...props}
    />
  );
}

export function TD({
  className,
  numeric = false,
  mono = false,
  ...props
}: React.TdHTMLAttributes<HTMLTableCellElement> & {
  numeric?: boolean | undefined;
  mono?: boolean | undefined;
}) {
  return (
    <td
      className={cn(
        'h-row truncate px-3 align-middle',
        numeric && 'text-right font-mono',
        mono && 'font-mono',
        className,
      )}
      {...props}
    />
  );
}
