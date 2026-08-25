'use client';

import { useActionState, useMemo, useState } from 'react';
import { createHold } from './actions';
import { EMPTY_HOLD_STATE } from './hold-state';
import { Button } from '@/components/ui/button';
import { Callout, IssueList } from '@/components/ui/callout';
import { Input, Label } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { PanelBody, PanelHeader, PanelTitle } from '@/components/ui/panel';
import { amount, dayIn, timeIn, zoneLabel } from '@/lib/format';
import type { EquipmentShortfall, EquipmentType, FreeSlot } from '@/lib/types';

/**
 * The right-hand column: what is selected, what it will cost, and the one
 * primary action on this screen.
 *
 * ## The equipment problem, now solved rather than stated
 *
 * P7 shipped this panel with a field for pasting an equipment type UUID and a
 * sentence explaining that `GET /equipment-types` answers a customer 403. That
 * was honest and useless: a customer has no way to obtain a UUID, so "hold, pay
 * and confirm with equipment line items" — a Tier 1 requirement — could not be
 * exercised through the UI by the only role that books.
 *
 * `GET /rooms/:id/equipment-types` is the customer-readable catalogue, scoped
 * to the room's venue by the API rather than filtered here. Every role now gets
 * the same picker, showing name, hourly rate and how many the venue owns, and
 * the three access branches are gone with the field they existed to explain.
 *
 * ## The 409 is the API's sentence, not a paraphrase
 *
 * When equipment is oversold the hold path returns a 409 naming what was asked
 * for, what was already reserved at peak, and the ceiling the venue's fleet and
 * buffer produce. "Not available" is not something a customer can act on;
 * "2 of 3 already reserved at peak, short by 1" is — they can drop a camera or
 * pick another hour. So the shortfalls are rendered as the API computed them.
 */

export interface LineItemDraft {
  equipment_type_id: string;
  quantity: number;
  /** Local to the picker. Never sent to the API, which prices from its own rows. */
  name: string;
  rate_minor: string;
}

export function BookingPanel({
  roomId,
  slot,
  timezone,
  hourlyRateMinor,
  equipment,
}: {
  roomId: string;
  slot: FreeSlot | null;
  timezone: string;
  hourlyRateMinor: string | null;
  equipment: EquipmentType[];
}) {
  const [items, setItems] = useState<LineItemDraft[]>([]);
  const [state, action, pending] = useActionState(createHold, EMPTY_HOLD_STATE);

  const hours = slot
    ? (new Date(slot.ends_at).getTime() - new Date(slot.starts_at).getTime()) / 3_600_000
    : 0;

  /**
   * An estimate, and labelled as one.
   *
   * The API is the only thing that knows the real total — it re-prices the
   * booking inside the hold transaction and the response carries the answer.
   * This number exists so the customer is not asked to commit blind, and it is
   * computed the way the API computes it: half-hour granularity, BigInt on
   * minor units, no float anywhere near money.
   */
  const estimate = useMemo(() => {
    if (!slot || hourlyRateMinor === null) return null;
    const halfHours = BigInt(Math.round(hours * 2));
    let total = (halfHours * BigInt(hourlyRateMinor)) / 2n;
    for (const item of items) {
      total += (halfHours * BigInt(item.rate_minor) * BigInt(item.quantity)) / 2n;
    }
    return total;
  }, [slot, hourlyRateMinor, hours, items]);

  function addItem(draft: LineItemDraft) {
    setItems((previous) => {
      // The API rejects a duplicated equipment_type_id with a 422 rather than
      // summing it, so the picker sums it here — asking twice for two cameras
      // means four cameras, not an error.
      const existing = previous.findIndex(
        (item) => item.equipment_type_id === draft.equipment_type_id,
      );
      if (existing === -1) return [...previous, draft];
      const next = [...previous];
      next[existing] = {
        ...next[existing]!,
        quantity: next[existing]!.quantity + draft.quantity,
      };
      return next;
    });
  }

  return (
    <form action={action} className="flex flex-col">
      <input type="hidden" name="room_id" value={roomId} />
      <input type="hidden" name="starts_at" value={slot?.starts_at ?? ''} />
      <input type="hidden" name="ends_at" value={slot?.ends_at ?? ''} />
      <input
        type="hidden"
        name="line_items"
        value={JSON.stringify(
          items.map((item) => ({
            equipment_type_id: item.equipment_type_id,
            quantity: item.quantity,
          })),
        )}
      />

      <PanelHeader>
        <PanelTitle>Booking</PanelTitle>
        {slot ? (
          <span className="font-mono text-xs text-ink-muted">{hours}h</span>
        ) : null}
      </PanelHeader>

      <PanelBody className="flex flex-col gap-4">
        {slot ? (
          <div className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-ink-muted">Slot</span>
            <span className="font-mono text-data text-ink">
              {dayIn(slot.starts_at, timezone)} · {timeIn(slot.starts_at, timezone)}–
              {timeIn(slot.ends_at, timezone)}
            </span>
            <span className="text-xs text-ink-muted">
              Venue local time · {timezone} ({zoneLabel(slot.starts_at, timezone)})
            </span>
          </div>
        ) : (
          <p className="text-sm text-ink-muted">
            Pick a slot on the left. Nothing is reserved until you hold it.
          </p>
        )}

        <div className="flex flex-col gap-2 border-t border-line pt-4">
          <div className="flex items-baseline justify-between">
            <span className="text-xs uppercase tracking-wide text-ink-muted">Equipment</span>
            <span className="text-xs text-ink-muted">Optional</span>
          </div>

          {equipment.length === 0 ? (
            <p className="text-sm text-ink-muted">
              This venue has no equipment types on record.
            </p>
          ) : (
            <EquipmentPicker equipment={equipment} onAdd={addItem} />
          )}

          {items.length > 0 ? (
            <ul className="flex flex-col divide-y divide-line rounded border border-line">
              {items.map((item) => (
                <li
                  key={item.equipment_type_id}
                  className="flex items-center gap-3 px-3 py-2"
                >
                  <span className="min-w-0 flex-1 truncate text-sm text-ink">
                    {item.name}
                  </span>
                  <span className="shrink-0 font-mono text-data text-ink-muted">
                    ×{item.quantity} · {amount(item.rate_minor)}/h
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setItems((previous) =>
                        previous.filter(
                          (candidate) =>
                            candidate.equipment_type_id !== item.equipment_type_id,
                        ),
                      )
                    }
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className="flex items-baseline justify-between border-t border-line pt-4">
          <span className="text-xs uppercase tracking-wide text-ink-muted">Estimate</span>
          <span className="font-mono text-md text-ink">
            {estimate === null ? '—' : amount(estimate)}
          </span>
        </div>
        <p className="-mt-2 text-xs text-ink-muted">
          The API prices the booking itself; the hold response carries the real total.
        </p>

        {state.status === 'conflict' ? (
          <ConflictCallout state={state} />
        ) : null}

        {state.status === 'invalid' ? (
          <Callout tone="info" title={state.message ?? 'The API rejected this request.'}>
            <IssueList issues={state.issues} />
          </Callout>
        ) : null}

        {state.status === 'unreachable' ? (
          <Callout tone="warn" title={state.message ?? 'The API did not answer.'}>
            Retrying is safe — nothing was created.
          </Callout>
        ) : null}

        {state.status === 'error' ? (
          <Callout tone="danger" title={state.message ?? 'The hold failed.'}>
            <IssueList issues={state.issues} />
          </Callout>
        ) : null}

        <Button type="submit" variant="primary" disabled={!slot || pending}>
          {pending ? 'Holding…' : 'Hold this slot'}
        </Button>
        <p className="-mt-2 text-xs text-ink-muted">
          A hold reserves the slot for a few minutes. The countdown starts on the next
          screen.
        </p>
      </PanelBody>
    </form>
  );
}

/**
 * A 409 from the hold path, told apart into its two causes.
 *
 * The room and the equipment both answer 409 and they mean opposite things. The
 * room's is "somebody else took this slot" — a lost race, expected under
 * concurrency, and the fix is to pick another time. Equipment's is "the venue
 * does not have that many at once in this window" — nobody took anything, and
 * the fix is to ask for fewer. Collapsing them into "that slot is no longer
 * free" sends a customer hunting for another hour when the hour was never the
 * problem.
 *
 * The API distinguishes them by attaching `shortfalls`, so the console does
 * too, and prints the numbers the API computed rather than inventing a summary
 * of them.
 */
function ConflictCallout({
  state,
}: {
  state: { message: string | null; detail: Record<string, unknown> };
}) {
  const shortfalls = Array.isArray(state.detail.shortfalls)
    ? (state.detail.shortfalls as EquipmentShortfall[])
    : [];

  if (shortfalls.length > 0) {
    return (
      <Callout tone="info" title="Not enough equipment free in this window.">
        <ul className="flex flex-col gap-2">
          {shortfalls.map((shortfall) => (
            <li key={shortfall.equipment_type_id} className="flex flex-col gap-0.5">
              <span className="text-ink">{shortfall.name}</span>
              <span className="font-mono text-xs">
                asked {shortfall.requested} · {shortfall.peak_in_use} already reserved at
                peak · ceiling {shortfall.ceiling} · short by {shortfall.short_by}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-2">
          The ceiling is what the venue owns, plus its overbooking buffer if it has
          one, rounded down. Peak is the most that are out at once at any instant
          inside this window — not a total over it, which is why a busy day does not
          block a booking on its own.
        </p>
      </Callout>
    );
  }

  return (
    <Callout tone="info" title={state.message ?? 'That slot is no longer free.'}>
      Somebody else holds it now. Under concurrent load this is the expected answer
      for every request but the first — refresh the slots and pick another.
      {typeof state.detail.reason === 'string' ? (
        <span className="mt-1 block font-mono text-xs">
          reason: {state.detail.reason}
        </span>
      ) : null}
    </Callout>
  );
}

/**
 * Name, rate and a quantity control — the three things a booker needs.
 *
 * `units_owned` is shown too, because it is the number the 409's ceiling is
 * derived from: seeing "3 owned" before asking for four makes the refusal
 * predictable rather than surprising. What is deliberately NOT shown is how
 * many are out right now. That is a live figure about the venue's other
 * customers, the API does not publish it, and it would be stale by the time it
 * was read anyway — the hold path answers that question inside the lock, which
 * is the only place the answer cannot go out of date.
 */
function EquipmentPicker({
  equipment,
  onAdd,
}: {
  equipment: EquipmentType[];
  onAdd: (draft: LineItemDraft) => void;
}) {
  const [selected, setSelected] = useState(equipment[0]?.id ?? '');
  const [quantity, setQuantity] = useState('1');

  const type = equipment.find((candidate) => candidate.id === selected);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <Label htmlFor="equipment-type">Type</Label>
          <div className="mt-1">
            <Select
              ariaLabel="Equipment type"
              value={selected}
              options={equipment.map((candidate) => ({
                value: candidate.id,
                label: `${candidate.name} — ${amount(candidate.hourly_rate_minor)}/h · ${candidate.units_owned} owned`,
              }))}
              onValueChange={setSelected}
            />
          </div>
        </div>
        <div className="w-[72px]">
          <Label htmlFor="equipment-quantity">Qty</Label>
          <Input
            id="equipment-quantity"
            type="number"
            min={1}
            max={type?.units_owned ?? 1000}
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
            className="mt-1 font-mono text-data"
          />
        </div>
        <Button
          type="button"
          disabled={!type}
          onClick={() => {
            if (!type) return;
            onAdd({
              equipment_type_id: type.id,
              quantity: Math.max(1, Number(quantity) || 1),
              name: type.name,
              rate_minor: type.hourly_rate_minor,
            });
            setQuantity('1');
          }}
        >
          Add
        </Button>
      </div>

      {type ? (
        <p className="text-xs text-ink-muted">
          {type.name}: {amount(type.hourly_rate_minor)} per hour, {type.units_owned}{' '}
          owned by this venue. Whether that many are free in your window is decided when
          you hold, not now.
        </p>
      ) : null}
    </div>
  );
}
