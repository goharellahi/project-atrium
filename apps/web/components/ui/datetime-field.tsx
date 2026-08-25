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
/**
 * A date on its own, styled like the rest of the console.
 *
 * The availability range on the room screen used two raw `<input type="date">`
 * elements. They worked and they looked like nothing else on the page — a
 * native date input takes its own typography, its own height and, on Chrome, a
 * blue-tinted picker glyph that no token here reaches. Two of them sat directly
 * beside a `Select` built from the console's own primitives, which is exactly
 * where the mismatch is most visible.
 *
 * The native picker is kept deliberately. Replacing it with a hand-built
 * calendar would cost a keyboard-accessible date grid, a locale-aware first day
 * of the week, and a mobile experience strictly worse than the one the platform
 * already provides. What is replaced is the chrome around it.
 *
 * `Input` already carries the console's border, height and focus ring, so this
 * is a thin wrapper: its value is being an obvious, named place for the shared
 * class list, so the next date field on the next screen cannot drift.
 */
export function DateField({
  id,
  name,
  value,
  defaultValue,
  onValueChange,
  disabled,
  min,
  max,
}: {
  id: string;
  /** Set for a plain GET form, where the browser submits the value. */
  name?: string | undefined;
  value?: string | undefined;
  defaultValue?: string | undefined;
  onValueChange?: ((next: string) => void) | undefined;
  disabled?: boolean | undefined;
  min?: string | undefined;
  max?: string | undefined;
}) {
  // Controlled when a value and a handler are given, uncontrolled otherwise.
  // React warns loudly if both `value` and `defaultValue` reach the DOM, so the
  // two are kept mutually exclusive here rather than at every call site.
  const binding =
    value !== undefined
      ? { value, onChange: (e: React.ChangeEvent<HTMLInputElement>) => onValueChange?.(e.target.value) }
      : { defaultValue: defaultValue ?? '' };

  return (
    <Input
      id={id}
      name={name}
      type="date"
      className="w-full font-mono text-data"
      disabled={disabled}
      min={min}
      max={max}
      {...binding}
    />
  );
}

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
        <div className="flex-1">
          <DateField
            id={`${id}-date`}
            value={value.date ?? ''}
            disabled={disabled}
            onValueChange={(date) => onChange({ ...value, date })}
          />
        </div>
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
