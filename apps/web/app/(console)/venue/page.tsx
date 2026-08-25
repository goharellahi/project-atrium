import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { PageHeader } from '@/components/app-shell';
import { ColdStartNotice } from '@/components/cold-start';
import { Panel } from '@/components/ui/panel';
import { TableSkeleton } from '@/components/ui/skeleton';
import { hasVenueScope, requireUser } from '@/lib/session';
import { VENUE_BOOKING_COLUMNS } from '../bookings/booking-table';
import { BookingsList } from '../bookings/list';
import { StatusFilter } from '../bookings/status-filter';

export const metadata: Metadata = { title: 'Venue · Atrium' };

/**
 * Bookings for the signed-in account's venue. Read only.
 *
 * ## There is no venue id on this page, or in the request that fills it
 *
 * That is the whole point of it. `GET /bookings` derives the scope from the
 * token: a VENUE_STAFF token carries one venue and sees that venue's rows, and
 * there is no parameter — path, query or body — that could ask for another
 * one's. So this screen is the customer's list with a different heading and a
 * customer column, and the isolation it demonstrates is the API's, not a filter
 * written here that somebody could later forget.
 *
 * A CUSTOMER who navigates here is sent to their own list rather than shown a
 * 403 page. The nav does not offer the link to them; typing the URL is not an
 * attack worth an error screen, and the API would refuse them anyway.
 */
export default async function VenuePage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; page?: string }>;
}) {
  const user = await requireUser('/venue');
  // Venue staff and venue admins only. A PLATFORM_ADMIN has no venue on their
  // token, so this screen has no subject for them — `GET /bookings` would
  // return every booking on the platform under a heading that says "venue".
  // They get the reconciliation report instead, which is the platform-wide
  // view that is actually theirs.
  if (!hasVenueScope(user.role)) {
    redirect(user.role === 'PLATFORM_ADMIN' ? '/reconciliation' : '/bookings');
  }

  const { status, page } = await searchParams;
  const pageNumber = Number(page) > 0 ? Number(page) : 1;

  return (
    <>
      <PageHeader
        title="Venue bookings"
        description={
          user.role === 'PLATFORM_ADMIN'
            ? 'A platform admin token carries no venue, so this is every venue on the platform.'
            : 'Scoped to the venue on your token. There is no way to ask this endpoint for another one.'
        }
        actions={<StatusFilter basePath="/venue" value={status ?? ''} />}
      />

      <Panel>
        <Suspense
          key={`${status ?? 'all'}:${pageNumber}`}
          fallback={
            <>
              <TableSkeleton columns={VENUE_BOOKING_COLUMNS} rows={8} />
              <ColdStartNotice />
            </>
          }
        >
          <BookingsList
            status={status}
            page={pageNumber}
            readOnly
            basePath="/venue"
            emptyTitle={
              status
                ? `No bookings with status ${status}.`
                : 'No bookings at this venue yet.'
            }
            emptyHint={
              status
                ? 'Clear the filter to see the rest.'
                : 'Bookings appear here the moment a customer creates a hold against one of this venue’s rooms.'
            }
          />
        </Suspense>
      </Panel>
    </>
  );
}
