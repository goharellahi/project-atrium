'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { Select } from '@/components/ui/select';
import type { BookingStatus } from '@/lib/types';

/**
 * The status filter.
 *
 * On the styled select rather than the native one. Nine statuses is few enough
 * that a native control would have worked functionally, and that was the old
 * argument for it — but it was the only element on the screen whose popup was
 * drawn by the operating system, and it showed.
 *
 * Selecting navigates: the filter lives in the URL like every other filter in
 * this console, so a filtered list is a link.
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

const ALL = '__all__';

export function StatusFilter({ basePath, value }: { basePath: string; value: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <div className="w-[196px]">
      <Select
        ariaLabel="Filter by status"
        value={value === '' ? ALL : value}
        disabled={pending}
        options={[
          { value: ALL, label: 'All statuses' },
          ...STATUSES.map((status) => ({
            value: status,
            label: status.replace('_', ' '),
          })),
        ]}
        onValueChange={(next) => {
          startTransition(() =>
            router.push(next === ALL ? basePath : `${basePath}?status=${next}`),
          );
        }}
      />
    </div>
  );
}
