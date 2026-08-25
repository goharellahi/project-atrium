'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Input, LabelledField, Select } from '@/components/ui/input';

/**
 * The search filters.
 *
 * Every filter is a URL parameter and the URL is the state. That is worth the
 * small amount of plumbing: a result set an operator wants a colleague to look
 * at is a link, the back button returns to the previous query instead of
 * clearing it, and a reload does not lose the last twenty seconds of work. A
 * `useState` form would have none of those properties and would look identical.
 *
 * Initial values arrive as props from the server component rather than from
 * `useSearchParams`, so this never triggers a client-side bailout and the
 * filter bar is present in the first paint.
 *
 * The two window fields are the exception, and the exception is unavoidable.
 * They are `datetime-local`, which is wall-clock in the reader's own zone; the
 * server does not know that zone. Rendering an instant into them on the server
 * would either show UTC labelled as local, or shift the window on the next
 * submit when the client reads it back as local. So the server sends the raw
 * instants and they are converted after hydration, in an effect, where the
 * zone is known. Everything else is server-rendered with its value in place.
 */

export interface FilterValues {
  city: string;
  min_capacity: string;
  amenity: string;
  max_rate_major: string;
  /** ISO instants as they appear in the URL, not `datetime-local` values. */
  from_iso: string;
  to_iso: string;
}

interface FormValues extends Omit<FilterValues, 'from_iso' | 'to_iso'> {
  from: string;
  to: string;
}

/** An instant to the `datetime-local` value that means the same moment here. */
function toLocalInput(iso: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

/** Cities in the seed. A datalist rather than a select — the database may hold others. */
const SEEDED_CITIES = ['Karachi', 'Dubai', 'London'];

/** The seed's amenity vocabulary, offered as suggestions on a free-text field. */
const SEEDED_AMENITIES = [
  'wifi',
  'air_conditioning',
  'blackout',
  'grand_piano',
  'drum_kit',
  'iso_booth',
  'green_screen',
  'cyclorama',
  'live_room',
  'street_level',
  'loading_bay',
  'kitchenette',
];

export function SearchFilters({ initial }: { initial: FilterValues }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [values, setValues] = useState<FormValues>({
    city: initial.city,
    min_capacity: initial.min_capacity,
    amenity: initial.amenity,
    max_rate_major: initial.max_rate_major,
    from: '',
    to: '',
  });

  // Runs once after hydration, when `getTimezoneOffset` is meaningful. A link
  // shared with an availability window in it therefore opens showing that
  // window in the reader's own clock rather than in UTC wearing a local label.
  useEffect(() => {
    setValues((previous) => ({
      ...previous,
      from: toLocalInput(initial.from_iso),
      to: toLocalInput(initial.to_iso),
    }));
  }, [initial.from_iso, initial.to_iso]);

  function set<K extends keyof FormValues>(key: K, value: string) {
    setValues((previous) => ({ ...previous, [key]: value }));
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const params = new URLSearchParams();
    if (values.city.trim()) params.set('city', values.city.trim());
    if (values.min_capacity.trim()) params.set('min_capacity', values.min_capacity.trim());

    // The API accepts `?amenity=a&amenity=b` or one comma-separated value, and
    // containment semantics: a room must have every amenity asked for, not any
    // of them. The hint under the field says so, because "wifi, grand_piano"
    // returning nothing is otherwise indistinguishable from a broken filter.
    for (const amenity of values.amenity.split(',').map((a) => a.trim()).filter(Boolean)) {
      params.append('amenity', amenity);
    }

    if (values.max_rate_major.trim()) params.set('max_rate', values.max_rate_major.trim());

    // `datetime-local` yields a wall-clock string with no zone. It is the
    // reader's own clock, so converting through `Date` and out to an instant is
    // correct — and it has to happen here, on the client, because the server
    // has no idea which zone the reader is in.
    if (values.from && values.to) {
      params.set('from', new Date(values.from).toISOString());
      params.set('to', new Date(values.to).toISOString());
    }

    startTransition(() => {
      router.push(`/search?${params.toString()}`);
    });
  }

  const windowHalfSet = Boolean(values.from) !== Boolean(values.to);

  return (
    <form
      onSubmit={submit}
      className="rounded border border-line bg-surface p-4"
      aria-label="Room filters"
    >
      <div className="grid gap-4 md:grid-cols-4">
        <LabelledField label="City" htmlFor="city">
          <Input
            id="city"
            list="atrium-cities"
            value={values.city}
            onChange={(event) => set('city', event.target.value)}
            placeholder="Any city"
          />
          <datalist id="atrium-cities">
            {SEEDED_CITIES.map((city) => (
              <option key={city} value={city} />
            ))}
          </datalist>
        </LabelledField>

        <LabelledField label="Minimum capacity" htmlFor="min_capacity">
          <Input
            id="min_capacity"
            type="number"
            min={1}
            max={10000}
            inputMode="numeric"
            value={values.min_capacity}
            onChange={(event) => set('min_capacity', event.target.value)}
            placeholder="Any size"
            className="font-mono text-data"
          />
        </LabelledField>

        <LabelledField
          label="Price ceiling / hour"
          htmlFor="max_rate"
          hint="Major units. Sent to the API in minor units."
        >
          <Input
            id="max_rate"
            type="number"
            min={0}
            inputMode="decimal"
            value={values.max_rate_major}
            onChange={(event) => set('max_rate_major', event.target.value)}
            placeholder="No ceiling"
            className="font-mono text-data"
          />
        </LabelledField>

        <LabelledField
          label="Amenities"
          htmlFor="amenity"
          hint="Comma separated. A room must have all of them."
        >
          <Input
            id="amenity"
            list="atrium-amenities"
            value={values.amenity}
            onChange={(event) => set('amenity', event.target.value)}
            placeholder="wifi, blackout"
            className="font-mono text-data"
          />
          <datalist id="atrium-amenities">
            {SEEDED_AMENITIES.map((amenity) => (
              <option key={amenity} value={amenity} />
            ))}
          </datalist>
        </LabelledField>

        <LabelledField label="Available from" htmlFor="from">
          <Input
            id="from"
            type="datetime-local"
            value={values.from}
            onChange={(event) => set('from', event.target.value)}
            className="font-mono text-data"
          />
        </LabelledField>

        <LabelledField
          label="Available to"
          htmlFor="to"
          hint="Both ends, or neither. Your local clock."
        >
          <Input
            id="to"
            type="datetime-local"
            value={values.to}
            onChange={(event) => set('to', event.target.value)}
            className="font-mono text-data"
          />
        </LabelledField>
      </div>

      <div className="mt-4 flex items-center gap-3 border-t border-line pt-4">
        <Button type="submit" variant="primary" disabled={pending || windowHalfSet}>
          {pending ? 'Searching…' : 'Search'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={pending}
          onClick={() => {
            setValues({
              city: '',
              min_capacity: '',
              amenity: '',
              max_rate_major: '',
              from: '',
              to: '',
            });
            startTransition(() => router.push('/search'));
          }}
        >
          Clear
        </Button>

        {windowHalfSet ? (
          <p className="text-sm text-ink-muted">
            The availability window needs both ends — the API rejects one on its own.
          </p>
        ) : null}
      </div>
    </form>
  );
}
