'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { Select } from '@/components/ui/input';
import type { BookingStatus } from '@/lib/types';

/**
 * The status filter.
 *
 * Nine statuses and one "all", which is few enough for a native select and far
 * too few to justify a listbox. Selecting navigates — the filter is in the URL
 * like every other filter in this console, so a filtered list is a link.
 */
const STATUSES: BookingStatus[] = [
  'HELD',
  'PENDING_PAYMENT',
  'CONFIRMED',
  'COMPLETED',
  'EXPIRED',
  'FAILED',
  'CANCELLED',
  'REFUNDED',
  'DRAFT',
];

export function StatusFilter({ basePath, value }: { basePath: string; value: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <Select
      aria-label="Filter by status"
      className="w-[180px]"
      value={value}
      disabled={pending}
      onChange={(event) => {
        const next = event.target.value;
        startTransition(() =>
          router.push(next === '' ? basePath : `${basePath}?status=${next}`),
        );
      }}
    >
      <option value="">All statuses</option>
      {STATUSES.map((status) => (
        <option key={status} value={status}>
          {status.replace('_', ' ')}
        </option>
      ))}
    </Select>
  );
}
