'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { BookingPanel } from './booking-panel';
import { Button } from '@/components/ui/button';
import { Empty } from '@/components/ui/empty';
import { Input, Label } from '@/components/ui/input';
import { LabelledField } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Panel, PanelBody, PanelHeader, PanelTitle } from '@/components/ui/panel';
import { cn } from '@/lib/cn';
import { dayIn, timeIn } from '@/lib/format';
import type { Availability, EquipmentType, FreeSlot } from '@/lib/types';
import type { EquipmentAccess } from './hold-state';

/**
 * Room availability, and the slot the customer picks out of it.
 *
 * The API is explicit that this endpoint is advisory: it reports what was free
 * when it ran, and the hold path does not consult it. This screen says the same
 * thing in one line under the grid rather than presenting the slots as a
 * reservation — a customer who reads "available" and then gets a 409 has been
 * misled by the UI, not by the API.
 *
 * Slots are grouped by venue-local day, because "Tuesday" is the unit a person
 * picks in and a flat list of 240 half-hour instants is not a thing anybody can
 * read.
 */
export function RoomWorkspace({
  roomId,
  availability,
  hourlyRateMinor,
  equipment,
  equipmentAccess,
  range,
}: {
  roomId: string;
  availability: Availability;
  hourlyRateMinor: string | null;
  equipment: EquipmentType[];
  equipmentAccess: EquipmentAccess;
  range: { from: string; to: string; duration: number };
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<FreeSlot | null>(null);
  const [form, setForm] = useState(range);

  // A new range means a new slot list, and the previously selected slot may not
  // be in it. Clearing it here is what stops the booking panel from holding an
  // instant that is no longer on screen.
  useEffect(() => {
    setSelected(null);
    setForm(range);
  }, [range.from, range.to, range.duration]);

  const days = groupByDay(availability.free_slots, availability.timezone);

  function applyRange(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const params = new URLSearchParams(window.location.search);
    params.set('from', form.from);
    params.set('to', form.to);
    params.set('duration', String(form.duration));
    startTransition(() => router.push(`/rooms/${roomId}?${params.toString()}`));
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_360px] lg:items-start">
      <Panel>
        <PanelHeader>
          <PanelTitle>Availability</PanelTitle>
          <span className="font-mono text-xs text-ink-muted">
            {availability.free_slots.length} slots · {availability.turnaround_minutes}m
            turnaround
          </span>
        </PanelHeader>

        <PanelBody className="border-b border-line">
          {/*
            Fixed widths and one shared hint line, rather than a fluid grid with
            a hint hanging off one field. A hint under a single control makes
            that column taller than its siblings, and `items-end` then pushes
            its neighbours' labels out of line — which is the kind of two-pixel
            wrongness nobody can name and everybody notices.
          */}
          <form onSubmit={applyRange}>
            <div className="flex flex-wrap items-end gap-4">
              <LabelledField label="From" htmlFor="range-from" className="w-[168px]">
                <Input
                  id="range-from"
                  type="date"
                  value={form.from}
                  onChange={(event) => setForm({ ...form, from: event.target.value })}
                  className="font-mono text-data"
                />
              </LabelledField>
              <LabelledField label="To" htmlFor="range-to" className="w-[168px]">
                <Input
                  id="range-to"
                  type="date"
                  value={form.to}
                  onChange={(event) => setForm({ ...form, to: event.target.value })}
                  className="font-mono text-data"
                />
              </LabelledField>
              <div className="flex w-[140px] flex-col gap-1">
                <Label htmlFor="range-duration">Duration</Label>
                <Select
                  ariaLabel="Slot length"
                  value={String(form.duration)}
                  options={[60, 90, 120, 180, 240, 360, 480].map((minutes) => ({
                    value: String(minutes),
                    label: `${minutes / 60} ${minutes === 60 ? 'hour' : 'hours'}`,
                  }))}
                  onValueChange={(next) => setForm({ ...form, duration: Number(next) })}
                />
              </div>
              <Button type="submit" disabled={pending}>
                {pending ? 'Loading…' : 'Apply'}
              </Button>
            </div>
            <p className="mt-2 text-xs text-ink-muted">
              A range of at most 31 days. Slot length is what gets enumerated, and the
              room takes bookings between 1 and 8 hours.
            </p>
          </form>
        </PanelBody>

        {days.length === 0 ? (
          <Empty
            title="No free slots in this range."
            hint="Every start time is either booked, outside the venue's operating hours, or too close to now — the API requires an hour of lead time. Try a later week or a shorter duration."
          />
        ) : (
          <div className="flex flex-col divide-y divide-line">
            {days.map((day) => (
              <div key={day.key} className="flex gap-4 px-4 py-3">
                <span className="w-[104px] shrink-0 pt-1 font-mono text-xs uppercase tracking-wide text-ink-muted">
                  {day.label}
                </span>
                <div className="flex flex-wrap gap-2">
                  {day.slots.map((slot) => {
                    const active = selected?.starts_at === slot.starts_at;
                    return (
                      <button
                        key={slot.starts_at}
                        type="button"
                        aria-pressed={active}
                        onClick={() => setSelected(active ? null : slot)}
                        className={cn(
                          'h-7 rounded border px-2 font-mono text-xs transition-quiet',
                          active
                            ? 'border-ink bg-ink text-ink-inverse'
                            : 'border-line-strong bg-surface text-ink hover:bg-raised',
                        )}
                      >
                        {timeIn(slot.starts_at, availability.timezone)}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        <p className="border-t border-line px-4 py-3 text-xs text-ink-muted">
          Advisory. This is what was free when the list was built — the hold path does
          not consult it, and a slot can go between this page loading and you clicking.
          That is what the 409 on the right is for.
        </p>
      </Panel>

      <Panel className="lg:sticky lg:top-[72px]">
        <BookingPanel
          roomId={roomId}
          slot={selected}
          timezone={availability.timezone}
          hourlyRateMinor={hourlyRateMinor}
          equipment={equipment}
          equipmentAccess={equipmentAccess}
        />
      </Panel>
    </div>
  );
}

/** Group by venue-local day, preserving the API's ordering within each. */
function groupByDay(
  slots: FreeSlot[],
  timezone: string,
): { key: string; label: string; slots: FreeSlot[] }[] {
  const byDay = new Map<string, FreeSlot[]>();
  for (const slot of slots) {
    const key = dayIn(slot.starts_at, timezone);
    const bucket = byDay.get(key);
    if (bucket) bucket.push(slot);
    else byDay.set(key, [slot]);
  }
  return [...byDay.entries()].map(([key, daySlots]) => ({
    key,
    label: key,
    slots: daySlots,
  }));
}
