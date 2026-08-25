import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { api, ApiError, ApiUnreachableError, qs } from '@/lib/api';
import type { BookingList } from '@/lib/types';
import { BookingTable, Pager } from './booking-table';

/**
 * The bookings list, fetched.
 *
 * Split out from the page so the page can render its header and filter
 * immediately and stream this in behind a `Suspense` boundary. On a cold API
 * that is the difference between a usable screen with a skeleton in it and a
 * blank one.
 */
export async function BookingsList({
  status,
  page,
  readOnly = false,
  basePath,
  emptyTitle,
  emptyHint,
  emptyAction,
}: {
  status?: string | undefined;
  page: number;
  readOnly?: boolean | undefined;
  basePath: string;
  emptyTitle: string;
  emptyHint: string;
  emptyAction?: React.ReactNode;
}) {
  let result: BookingList;

  try {
    result = await api<BookingList>(`/bookings${qs({ status, page })}`);
  } catch (err: unknown) {
    if (err instanceof ApiUnreachableError) {
      return (
        <div className="p-4">
          <Callout tone="warn" title={err.message}>
            The API sleeps after 15 idle minutes on its free tier. Reload — the second
            request lands on a warm instance.
          </Callout>
        </div>
      );
    }
    if (err instanceof ApiError) {
      return (
        <div className="p-4">
          <Callout tone={err.status === 403 ? 'info' : 'danger'} title={err.message}>
            {err.status === 403
              ? 'This account has no venue on its token, so there is no venue-scoped list to show.'
              : null}
          </Callout>
        </div>
      );
    }
    throw err;
  }

  return (
    <>
      <BookingTable
        result={result}
        readOnly={readOnly}
        emptyTitle={emptyTitle}
        emptyHint={emptyHint}
        emptyAction={emptyAction}
      />
      {result.data.length > 0 ? (
        <Pager
          result={result}
          hrefFor={(next) =>
            `${basePath}${qs({ status, page: next === 1 ? undefined : next })}`
          }
        />
      ) : null}
    </>
  );
}

/** The action offered on an empty customer list. Kept here so both callers agree. */
export function FindRoomsAction() {
  return (
    <Button asChild>
      <Link href="/search">Find a room</Link>
    </Button>
  );
}
