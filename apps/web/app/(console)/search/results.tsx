import Link from 'next/link';
import { api, ApiError, ApiUnreachableError, qs } from '@/lib/api';
import { amount, shortId } from '@/lib/format';
import type { SearchResult } from '@/lib/types';
import { Callout, IssueList } from '@/components/ui/callout';
import { Empty } from '@/components/ui/empty';
import { Button } from '@/components/ui/button';
import { Table, TableScroll, TBody, TD, TH, THead, TR } from '@/components/ui/table';

/**
 * The result set.
 *
 * A dense table, not cards. Column widths are fixed in the `<colgroup>` so page
 * two lays out exactly like page one — a table that reflows when the longest
 * room name changes is the thing that makes a list feel unreliable.
 *
 * The row links carry the room's catalogue fields — name, venue, city, rate —
 * as query parameters. There is no `GET /rooms/:id` on this API and `/search`
 * cannot filter by id, so the detail screen has no other way to name the room a
 * reader just clicked. See `app/(console)/rooms/[id]/page.tsx`.
 *
 * Rates are printed without a currency symbol on purpose. `bookings.currency`
 * exists and is authoritative; `rooms.hourly_rate_minor` has no currency
 * column beside it, and stamping "PKR" on a London room because the column
 * defaults to PKR would be inventing a fact. The header says minor-unit hourly
 * rate and the booking screens, where the currency is real, print it.
 */

export const SEARCH_COLUMNS = [
  { label: 'Room', width: '22%' },
  { label: 'Venue', width: '22%' },
  { label: 'City', width: '12%' },
  { label: 'Capacity', width: '9%', numeric: true },
  { label: 'Rate / hr', width: '11%', numeric: true },
  { label: 'Amenities', width: '16%' },
  { label: '', width: '9%' },
];

export async function SearchResults({
  params,
}: {
  params: Record<string, string | string[] | undefined>;
}) {
  let result: SearchResult;

  try {
    result = await api<SearchResult>(
      `/search${qs({
        city: asString(params.city),
        min_capacity: asString(params.min_capacity),
        amenity: asArray(params.amenity),
        max_hourly_rate_minor: toMinor(asString(params.max_rate)),
        from: asString(params.from),
        to: asString(params.to),
        page: asString(params.page) ?? '1',
      })}`,
    );
  } catch (err: unknown) {
    return <SearchFailure error={err} />;
  }

  if (result.data.length === 0) {
    return (
      <Empty
        title="No rooms match these filters."
        hint={
          result.filters_applied.length > 0
            ? `The API applied: ${result.filters_applied.join(', ')}. Widen one of them.`
            : 'The API applied no filters, so this is the whole catalogue — the database has no rooms in it.'
        }
      />
    );
  }

  const page = result.page;
  const lastPage = Math.max(1, Math.ceil(result.total / result.page_size));

  return (
    <div className="enter">
      <TableScroll>
        <Table>
          <colgroup>
            {SEARCH_COLUMNS.map((column) => (
              <col key={column.label} style={{ width: column.width }} />
            ))}
          </colgroup>
          <THead>
            <TR className="hover:bg-raised">
              {SEARCH_COLUMNS.map((column) => (
                <TH key={column.label} numeric={column.numeric}>
                  {column.label}
                </TH>
              ))}
            </TR>
          </THead>
          <TBody>
            {result.data.map((room) => (
              <TR key={room.id}>
                <TD>
                  <Link
                    href={roomHref(room)}
                    className="text-ink transition-quiet hover:underline"
                  >
                    {room.name}
                  </Link>
                  <span className="ml-2 font-mono text-xs text-ink-muted">
                    {shortId(room.id)}
                  </span>
                </TD>
                <TD className="text-ink-muted">{room.venue_name}</TD>
                <TD className="text-ink-muted">{room.city}</TD>
                <TD numeric>{room.capacity}</TD>
                <TD numeric>{amount(room.hourly_rate_minor)}</TD>
                <TD className="font-mono text-xs text-ink-muted" title={room.amenities.join(', ')}>
                  {room.amenities.join(' · ')}
                </TD>
                <TD className="text-right">
                  <Button size="sm" variant="ghost" asChild>
                    <Link href={roomHref(room)}>Open</Link>
                  </Button>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </TableScroll>

      <div className="flex items-center justify-between gap-4 border-t border-line px-4 py-3">
        <p className="text-sm text-ink-muted">
          <span className="font-mono text-data text-ink">{result.total}</span> rooms
          {result.filters_applied.length > 0 ? (
            <>
              {' · '}filters applied:{' '}
              <span className="font-mono text-data text-ink">
                {result.filters_applied.join(', ')}
              </span>
            </>
          ) : null}
          {result.truncated_at_candidates ? (
            <>
              {' · '}candidate set capped at{' '}
              <span className="font-mono text-data text-ink">
                {result.truncated_at_candidates}
              </span>
            </>
          ) : null}
        </p>

        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-ink-muted">
            {page} / {lastPage}
          </span>
          <Button size="sm" disabled={page <= 1} asChild={page > 1}>
            {page > 1 ? (
              <Link href={pageHref(params, page - 1)}>Previous</Link>
            ) : (
              <span>Previous</span>
            )}
          </Button>
          <Button size="sm" disabled={page >= lastPage} asChild={page < lastPage}>
            {page < lastPage ? (
              <Link href={pageHref(params, page + 1)}>Next</Link>
            ) : (
              <span>Next</span>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * A failed search, rendered as the API described it.
 *
 * A 422 here means a filter could never be valid — the availability window with
 * one end, a `to` before its `from` — and the API names the offending field. It
 * is information, not an error screen, so it gets the neutral tone and the
 * field list rather than a red box.
 */
function SearchFailure({ error }: { error: unknown }) {
  if (error instanceof ApiUnreachableError) {
    return (
      <div className="p-4">
        <Callout tone="warn" title={error.message}>
          The API sleeps after 15 idle minutes on its free tier. Search again — the
          second request lands on a warm instance.
        </Callout>
      </div>
    );
  }

  if (error instanceof ApiError) {
    // A 5xx is the API failing, not a filter being refused, and the difference
    // matters to whoever is looking at the screen: one of them is something they
    // did and can undo, the other is not. Saying which costs a sentence and
    // stops a server fault reading as a broken console.
    const serverFault = error.status >= 500;

    return (
      <div className="p-4">
        <Callout tone={serverFault ? 'danger' : error.status === 422 ? 'info' : 'danger'} title={error.message}>
          {serverFault ? (
            <p>
              The API failed on this request. Nothing was rejected — the console sent the
              filters as entered and the server did not answer with a result. Changing a
              filter may route around it; the fault is not on this side.
            </p>
          ) : null}
          <IssueList issues={error.issues} />
        </Callout>
      </div>
    );
  }

  throw error;
}

/** The detail link, carrying what only the catalogue knows. */
function roomHref(room: SearchResult['data'][number]): string {
  const params = new URLSearchParams({
    name: room.name,
    venue: room.venue_name,
    venue_id: room.venue_id,
    city: room.city,
    rate: room.hourly_rate_minor,
  });
  return `/rooms/${room.id}?${params.toString()}`;
}

function pageHref(
  params: Record<string, string | string[] | undefined>,
  page: number,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key === 'page' || value === undefined) continue;
    if (Array.isArray(value)) for (const entry of value) search.append(key, entry);
    else search.set(key, value);
  }
  search.set('page', String(page));
  return `/search?${search.toString()}`;
}

function asString(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

function asArray(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

/** The filter is entered in major units; the API takes minor. Integers only. */
function toMinor(major: string | undefined): string | undefined {
  if (major === undefined || major.trim() === '') return undefined;
  const parsed = Number(major);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return String(Math.round(parsed * 100));
}
