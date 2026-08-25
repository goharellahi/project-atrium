'use client';

import { Input, Label } from './input';
import { Select } from './select';
import { halfHourGrid, type WallClock } from '@/lib/wall-clock';

/**
 * A date and a time, as two controls that match the rest of the console.
 *
 * `datetime-local` was the previous answer and it was the cheapest-looking
 * element on the page: the browser renders `mm/dd/yyyy --:-- --` in its own
 * typography, with a picker drawn by the operating system that no token here
 * reaches. It also encodes a US-centric order that reads wrong to most of the
 * world.
 *
 * A `date` input keeps the calendar affordance, which is worth having and which
 * nothing hand-built would do better. The time half becomes a select over the
 * API's own 30-minute grid — which is strictly more useful than free text,
 * because the hold endpoint rejects anything off that grid with a 422, so a
 * free-text field can only ever offer the user a way to be wrong.
 *
 * The value is carried as a `{ date, time }` wall clock and converted to an
 * instant in exactly one place, `wallClockToInstant`, which is unit tested
 * across five zones including a half-hour offset and DST.
 */
export function DateTimeField({
  id,
  label,
  hint,
  value,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  hint?: string | undefined;
  value: Partial<WallClock>;
  onChange: (next: Partial<WallClock>) => void;
  disabled?: boolean | undefined;
}) {
  const times = halfHourGrid();

  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={`${id}-date`}>{label}</Label>
      <div className="flex gap-2">
        <Input
          id={`${id}-date`}
          type="date"
          className="flex-1 font-mono text-data"
          value={value.date ?? ''}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, date: event.target.value })}
        />
        <div className="w-[104px] shrink-0">
          <Select
            ariaLabel={`${label} — time`}
            className="font-mono text-data"
            placeholder="--:--"
            disabled={disabled}
            value={value.time ?? ''}
            options={times}
            onValueChange={(time) => onChange({ ...value, time })}
          />
        </div>
      </div>
      {hint ? <p className="text-xs text-ink-muted">{hint}</p> : null}
    </div>
  );
}
