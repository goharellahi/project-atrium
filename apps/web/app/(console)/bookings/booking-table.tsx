import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Empty } from '@/components/ui/empty';
import { Status } from '@/components/ui/status';
import { Table, TableScroll, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { amount, durationHours, shortId, utc } from '@/lib/format';
import type { BookingList } from '@/lib/types';

/**
 * The bookings table, shared by the customer's list and the venue's.
 *
 * One component for both because they are the same table: the API decides what
 * is in it. `GET /bookings` scopes by the token — a CUSTOMER sees their own
 * rows, VENUE_ADMIN and VENUE_STAFF see their venue's, a PLATFORM_ADMIN sees
 * everything — so there is no filtering to do on this side and no `venue_id` to
 * pass. Two components would be two places for that to drift.
 *
 * The venue view adds one column and takes the row link away, which is what
 * `readOnly` does.
 */

export const BOOKING_COLUMNS = [
  { label: 'Booking', width: '13%' },
  { label: 'Room', width: '22%' },
  { label: 'Starts', width: '20%' },
  { label: 'Length', width: '8%', numeric: true },
  { label: 'Status', width: '13%' },
  { label: 'Total', width: '14%', numeric: true },
  { label: '', width: '10%' },
];

export const VENUE_BOOKING_COLUMNS = [
  { label: 'Booking', width: '14%' },
  { label: 'Room', width: '22%' },
  { label: 'Customer', width: '14%' },
  { label: 'Starts', width: '20%' },
  { label: 'Status', width: '14%' },
  { label: 'Total', width: '16%', numeric: true },
];

export function BookingTable({
  result,
  readOnly = false,
  emptyTitle,
  emptyHint,
  emptyAction,
}: {
  result: BookingList;
  readOnly?: boolean | undefined;
  emptyTitle: string;
  emptyHint: string;
  emptyAction?: React.ReactNode;
}) {
  if (result.data.length === 0) {
    return <Empty title={emptyTitle} hint={emptyHint} action={emptyAction} />;
  }

  const columns = readOnly ? VENUE_BOOKING_COLUMNS : BOOKING_COLUMNS;

  return (
    <div className="enter">
      <TableScroll>
        <Table>
          <colgroup>
            {columns.map((column) => (
              <col key={column.label} style={{ width: column.width }} />
            ))}
          </colgroup>
          <THead>
            <TR className="hover:bg-raised">
              {columns.map((column) => (
                <TH key={column.label} numeric={column.numeric}>
                  {column.label}
                </TH>
              ))}
            </TR>
          </THead>
          <TBody>
            {result.data.map((booking) => (
              <TR key={booking.id}>
                <TD mono className="text-ink-muted">
                  {readOnly ? (
                    shortId(booking.id)
                  ) : (
                    <Link
                      href={`/bookings/${booking.id}`}
                      className="text-ink transition-quiet hover:underline"
                    >
                      {shortId(booking.id)}
                    </Link>
                  )}
                </TD>
                <TD>{booking.room_name}</TD>
                {readOnly ? (
                  <TD mono className="text-ink-muted">
                    {shortId(booking.user_id)}
                  </TD>
                ) : null}
                <TD mono className="text-ink-muted">
                  {utc(booking.starts_at)}
                </TD>
                {readOnly ? null : (
                  <TD numeric>{durationHours(booking.starts_at, booking.ends_at)}</TD>
                )}
                <TD>
                  <Status status={booking.status} />
                </TD>
                <TD numeric>{amount(booking.total_minor)}</TD>
                {readOnly ? null : (
                  <TD className="text-right">
                    <Button size="sm" variant="ghost" asChild>
                      <Link
                        href={
                          booking.status === 'HELD' || booking.status === 'PENDING_PAYMENT'
                            ? `/checkout/${booking.id}`
                            : `/bookings/${booking.id}`
                        }
                      >
                        {booking.status === 'HELD' || booking.status === 'PENDING_PAYMENT'
                          ? 'Checkout'
                          : 'Open'}
                      </Link>
                    </Button>
                  </TD>
                )}
              </TR>
            ))}
          </TBody>
        </Table>
      </TableScroll>
    </div>
  );
}

/** Page count, and the two links. Shared by both lists for the same reason. */
export function Pager({
  result,
  hrefFor,
}: {
  result: BookingList;
  hrefFor: (page: number) => string;
}) {
  const lastPage = Math.max(1, Math.ceil(result.total / result.page_size));

  return (
    <div className="flex items-center justify-between gap-4 border-t border-line px-4 py-3">
      <p className="text-sm text-ink-muted">
        <span className="font-mono text-data text-ink">{result.total}</span> bookings
      </p>
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs text-ink-muted">
          {result.page} / {lastPage}
        </span>
        <Button size="sm" disabled={result.page <= 1} asChild={result.page > 1}>
          {result.page > 1 ? (
            <Link href={hrefFor(result.page - 1)}>Previous</Link>
          ) : (
            <span>Previous</span>
          )}
        </Button>
        <Button
          size="sm"
          disabled={result.page >= lastPage}
          asChild={result.page < lastPage}
        >
          {result.page < lastPage ? (
            <Link href={hrefFor(result.page + 1)}>Next</Link>
          ) : (
            <span>Next</span>
          )}
        </Button>
      </div>
    </div>
  );
}
