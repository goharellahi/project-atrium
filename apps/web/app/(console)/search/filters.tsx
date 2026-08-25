'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { DateTimeField } from '@/components/ui/datetime-field';
import { Input, LabelledField } from '@/components/ui/input';
import { instantToWallClock, wallClockToInstant, type WallClock } from '@/lib/wall-clock';

/**
 * The search filters.
 *
 * Every filter is a URL parameter and the URL is the state. That is worth the
 * plumbing: a result set an operator wants a colleague to look at is a link, the
 * back button returns to the previous query instead of clearing it, and a reload
 * does not lose the last twenty seconds of work.
 *
 * The availability window is the only part that cannot be server-rendered with
 * its value in place. It is a local wall clock and the server does not know the
 * reader's zone, so the instants arrive as props and are converted after
 * hydration — see `lib/wall-clock.ts` for why that conversion is a tested
 * function rather than a `new Date(string)` somewhere in this file.
 */

export interface FilterValues {
  city: string;
  min_capacity: string;
  amenity: string;
  max_rate_major: string;
  /** ISO instants exactly as they appear in the URL. */
  from_iso: string;
  to_iso: string;
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

  const [city, setCity] = useState(initial.city);
  const [minCapacity, setMinCapacity] = useState(initial.min_capacity);
  const [amenity, setAmenity] = useState(initial.amenity);
  const [maxRate, setMaxRate] = useState(initial.max_rate_major);
  const [from, setFrom] = useState<Partial<WallClock>>({});
  const [to, setTo] = useState<Partial<WallClock>>({});

  // Runs once after hydration, where the reader's zone is knowable. A link
  // shared with a window in it therefore reopens showing that window on the
  // reader's own clock rather than in UTC wearing a local label.
  useEffect(() => {
    setFrom(initial.from_iso ? (instantToWallClock(initial.from_iso) ?? {}) : {});
    setTo(initial.to_iso ? (instantToWallClock(initial.to_iso) ?? {}) : {});
  }, [initial.from_iso, initial.to_iso]);

  const fromInstant = wallClockToInstant(from);
  const toInstant = wallClockToInstant(to);
  const windowStarted = Boolean(from.date || from.time || to.date || to.time);
  const windowIncomplete = windowStarted && (fromInstant === null || toInstant === null);
  const windowBackwards =
    fromInstant !== null && toInstant !== null && toInstant <= fromInstant;

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (windowIncomplete || windowBackwards) return;

    const params = new URLSearchParams();
    if (city.trim()) params.set('city', city.trim());
    if (minCapacity.trim()) params.set('min_capacity', minCapacity.trim());

    // The API accepts `?amenity=a&amenity=b` or one comma-separated value, and
    // containment semantics: a room must have every amenity asked for, not any
    // of them. The hint under the field says so, because "wifi, grand_piano"
    // returning nothing is otherwise indistinguishable from a broken filter.
    for (const entry of amenity.split(',').map((a) => a.trim()).filter(Boolean)) {
      params.append('amenity', entry);
    }

    if (maxRate.trim()) params.set('max_rate', maxRate.trim());

    if (fromInstant && toInstant) {
      params.set('from', fromInstant);
      params.set('to', toInstant);
    }

    startTransition(() => router.push(`/search?${params.toString()}`));
  }

  return (
    <form
      onSubmit={submit}
      className="rounded border border-line bg-surface"
      aria-label="Room filters"
    >
      <div className="grid gap-4 p-4 md:grid-cols-2 xl:grid-cols-4">
        <LabelledField label="City" htmlFor="city">
          <Input
            id="city"
            list="atrium-cities"
            value={city}
            onChange={(event) => setCity(event.target.value)}
            placeholder="Any city"
          />
          <datalist id="atrium-cities">
            {SEEDED_CITIES.map((entry) => (
              <option key={entry} value={entry} />
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
            value={minCapacity}
            onChange={(event) => setMinCapacity(event.target.value)}
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
            value={maxRate}
            onChange={(event) => setMaxRate(event.target.value)}
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
            value={amenity}
            onChange={(event) => setAmenity(event.target.value)}
            placeholder="wifi, blackout"
            className="font-mono text-data"
          />
          <datalist id="atrium-amenities">
            {SEEDED_AMENITIES.map((entry) => (
              <option key={entry} value={entry} />
            ))}
          </datalist>
        </LabelledField>

        <DateTimeField
          id="from"
          label="Available from"
          value={from}
          onChange={setFrom}
          disabled={pending}
        />
        <DateTimeField
          id="to"
          label="Available to"
          hint="Your local clock. Sent to the API as an instant."
          value={to}
          onChange={setTo}
          disabled={pending}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3">
        <Button
          type="submit"
          variant="primary"
          disabled={pending || windowIncomplete || windowBackwards}
        >
          {pending ? 'Searching…' : 'Search'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={pending}
          onClick={() => {
            setCity('');
            setMinCapacity('');
            setAmenity('');
            setMaxRate('');
            setFrom({});
            setTo({});
            startTransition(() => router.push('/search'));
          }}
        >
          Clear
        </Button>

        {windowIncomplete ? (
          <p className="text-sm text-ink-muted">
            The availability window needs a date and a time at both ends — the API
            rejects half of one.
          </p>
        ) : null}
        {windowBackwards ? (
          <p className="text-sm text-ink-muted">
            The end of the window must be after its start.
          </p>
        ) : null}
        {!windowIncomplete && !windowBackwards && fromInstant && toInstant ? (
          <p className="font-mono text-xs text-ink-muted">
            {fromInstant} → {toInstant}
          </p>
        ) : null}
      </div>
    </form>
  );
}
