import type { Metadata } from 'next';
import { Suspense } from 'react';
import { PageHeader } from '@/components/app-shell';
import { ColdStartNotice } from '@/components/cold-start';
import { Panel } from '@/components/ui/panel';
import { TableSkeleton } from '@/components/ui/skeleton';
import { SearchFilters, type FilterValues } from './filters';
import { SEARCH_COLUMNS, SearchResults } from './results';

export const metadata: Metadata = { title: 'Search · Atrium' };

/**
 * Cross-venue room search.
 *
 * The filter bar renders immediately and the table streams in behind a
 * `Suspense` boundary, so a cold API — 30 to 60 seconds on Render's free tier —
 * produces a usable screen with a skeleton in the results area rather than a
 * blank page. The `key` on the boundary is the querystring: without it React
 * reuses the resolved subtree across navigations and the second search shows
 * the first search's rows until the new ones land.
 */
export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;

  const initial: FilterValues = {
    city: first(params.city) ?? '',
    min_capacity: first(params.min_capacity) ?? '',
    amenity: (Array.isArray(params.amenity)
      ? params.amenity
      : params.amenity
        ? [params.amenity]
        : []
    ).join(', '),
    max_rate_major: first(params.max_rate) ?? '',
    from_iso: first(params.from) ?? '',
    to_iso: first(params.to) ?? '',
  };

  return (
    <>
      <PageHeader
        title="Rooms"
        description="Every filter is optional and every filter combines. The API reports which ones it actually applied."
      />

      <div className="flex flex-col gap-6">
        <SearchFilters initial={initial} />

        <Panel>
          <Suspense
            key={new URLSearchParams(
              Object.entries(params).flatMap(([key, value]) =>
                value === undefined
                  ? []
                  : Array.isArray(value)
                    ? value.map((entry) => [key, entry] as [string, string])
                    : [[key, value] as [string, string]],
              ),
            ).toString()}
            fallback={
              <>
                <TableSkeleton columns={SEARCH_COLUMNS} rows={8} />
                <ColdStartNotice />
              </>
            }
          >
            <SearchResults params={params} />
          </Suspense>
        </Panel>
      </div>
    </>
  );
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
