import type { Metadata } from 'next';
import { Suspense } from 'react';
import { PageHeader } from '@/components/app-shell';
import { ColdStartNotice } from '@/components/cold-start';
import { Panel } from '@/components/ui/panel';
import { TableSkeleton } from '@/components/ui/skeleton';
import { BOOKING_COLUMNS } from './booking-table';
import { BookingsList, FindRoomsAction } from './list';
import { StatusFilter } from './status-filter';

export const metadata: Metadata = { title: 'My bookings · Atrium' };

/**
 * Everything this account has booked.
 *
 * There is no `venue_id` or `user_id` on the request and there is nowhere to
 * put one — `GET /bookings` derives the scope from the token. A customer gets
 * their own rows here and a venue account gets its venue's, which is why this
 * page and the venue page differ by a heading and a column rather than by an
 * authorisation check written on this side.
 */
export default async function BookingsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; page?: string }>;
}) {
  const { status, page } = await searchParams;
  const pageNumber = Number(page) > 0 ? Number(page) : 1;

  return (
    <>
      <PageHeader
        title="My bookings"
        description="Held, paid, cancelled and expired — the whole history for this account."
        actions={<StatusFilter basePath="/bookings" value={status ?? ''} />}
      />

      <Panel>
        <Suspense
          key={`${status ?? 'all'}:${pageNumber}`}
          fallback={
            <>
              <TableSkeleton columns={BOOKING_COLUMNS} rows={6} />
              <ColdStartNotice />
            </>
          }
        >
          <BookingsList
            status={status}
            page={pageNumber}
            basePath="/bookings"
            emptyTitle={
              status ? `Nothing here with status ${status}.` : 'No bookings yet.'
            }
            emptyHint={
              status
                ? 'Clear the filter to see the rest of this account’s history.'
                : 'Search for a room, hold a slot, and it will appear here the moment the hold is created.'
            }
            emptyAction={status ? undefined : <FindRoomsAction />}
          />
        </Suspense>
      </Panel>
    </>
  );
}
