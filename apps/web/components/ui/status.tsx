import { cn } from '@/lib/cn';
import type { BookingStatus } from '@/lib/types';

/**
 * A booking status.
 *
 * A small uppercase mono label, per DESIGN.md — not a coloured pill. The colour
 * that is here does one job: an operator scanning fifty rows has to find the
 * failures without reading them, so `FAILED` is the one status that carries the
 * semantic negative and everything else is separated by weight alone. Adding a
 * green for CONFIRMED and a blue for PENDING would turn a dense table into a
 * legend nobody has.
 *
 * `PENDING_PAYMENT` renders as `PENDING PAY` rather than being truncated with
 * an ellipsis: the column has a fixed width so the table does not jump between
 * pages, and a status a reader has to hover to finish is not a status.
 */

const TONE: Record<BookingStatus, string> = {
  DRAFT: 'text-ink-muted',
  HELD: 'text-ink font-medium',
  PENDING_PAYMENT: 'text-ink font-medium',
  CONFIRMED: 'text-ink font-medium',
  COMPLETED: 'text-ink',
  EXPIRED: 'text-ink-muted',
  CANCELLED: 'text-ink-muted',
  REFUNDED: 'text-ink-muted',
  FAILED: 'text-danger font-medium',
};

const LABEL: Partial<Record<BookingStatus, string>> = {
  PENDING_PAYMENT: 'PENDING PAY',
};

export function Status({
  status,
  className,
}: {
  status: BookingStatus;
  className?: string | undefined;
}) {
  return (
    <span
      className={cn('font-mono text-xs uppercase tracking-wide', TONE[status], className)}
      title={status}
    >
      {LABEL[status] ?? status}
    </span>
  );
}
