'use client';

import { useActionState, useMemo, useState } from 'react';
import { createHold } from './actions';
import { EMPTY_HOLD_STATE } from './hold-state';
import { Button } from '@/components/ui/button';
import { Callout, IssueList } from '@/components/ui/callout';
import { Input, Label } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { PanelBody, PanelHeader, PanelTitle } from '@/components/ui/panel';
import { amount, dayIn, timeIn } from '@/lib/format';
import type { EquipmentType, FreeSlot } from '@/lib/types';
import type { EquipmentAccess } from './hold-state';

/**
 * The right-hand column: what is selected, what it will cost, and the one
 * primary action on this screen.
 *
 * ## The equipment problem, stated rather than hidden
 *
 * `GET /equipment-types` is gated to VENUE_ADMIN, VENUE_STAFF and
 * PLATFORM_ADMIN — verified against the deployed API, which answers a CUSTOMER
 * token with 403 "Insufficient role". `POST /bookings/hold` accepts line items
 * from anyone. So a customer can book equipment but cannot discover it.
 *
 * That is an API gap, not a UI one, and this panel does not paper over it. Staff
 * get a picker off the real inventory. Everyone else gets a field for an
 * equipment type id and a sentence saying why there is no list — which is
 * honest, usable by a reviewer with an id in hand, and leaves the gap visible
 * instead of quietly dropping half a requirement. The fix is a
 * customer-readable catalogue endpoint; it is an `apps/api` change and is
 * recorded in PLAN.md.
 *
 * `other_venue` is the third case and it exists because collapsing it into an
 * empty picker tells a venue admin looking at another venue's room that the
 * venue owns no equipment. It owns plenty. This account simply cannot see it,
 * which is INV-6 working, not an empty inventory.
 */

export interface LineItemDraft {
  equipment_type_id: string;
  quantity: number;
  /** Present only when the picker knew the name. Never sent to the API. */
  name?: string;
  rate_minor?: string;
}

export function BookingPanel({
  roomId,
  slot,
  timezone,
  hourlyRateMinor,
  equipment,
  equipmentAccess,
}: {
  roomId: string;
  slot: FreeSlot | null;
  timezone: string;
  hourlyRateMinor: string | null;
  equipment: EquipmentType[];
  equipmentAccess: EquipmentAccess;
}) {
  const [items, setItems] = useState<LineItemDraft[]>([]);
  const [manualId, setManualId] = useState('');
  const [manualQuantity, setManualQuantity] = useState('1');
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
      if (!item.rate_minor) return null; // An unknown rate makes the estimate a lie.
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
            <span className="text-xs text-ink-muted">Venue local time ({timezone})</span>
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

          {equipmentAccess === 'unreadable' ? (
            <p className="text-sm text-ink-muted">
              This API exposes the equipment catalogue to venue staff only — a customer
              token gets 403. Enter a type id directly if you have one; the hold path
              accepts line items from any signed-in user.
            </p>
          ) : equipmentAccess === 'other_venue' ? (
            <p className="text-sm text-ink-muted">
              This room belongs to a different venue from the one on your token, so its
              equipment is not yours to list. That is the tenant boundary holding, not an
              empty inventory. A type id entered directly still works.
            </p>
          ) : equipment.length === 0 ? (
            <p className="text-sm text-ink-muted">
              This venue has no equipment types on record.
            </p>
          ) : (
            <EquipmentPicker equipment={equipment} onAdd={addItem} />
          )}

          {equipmentAccess !== 'available' ? (
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Label htmlFor="manual-equipment">Equipment type id</Label>
                <Input
                  id="manual-equipment"
                  value={manualId}
                  onChange={(event) => setManualId(event.target.value)}
                  placeholder="00000000-0000-0000-0000-000000000000"
                  className="mt-1 font-mono text-data"
                />
              </div>
              <div className="w-[72px]">
                <Label htmlFor="manual-quantity">Qty</Label>
                <Input
                  id="manual-quantity"
                  type="number"
                  min={1}
                  value={manualQuantity}
                  onChange={(event) => setManualQuantity(event.target.value)}
                  className="mt-1 font-mono text-data"
                />
              </div>
              <Button
                type="button"
                disabled={manualId.trim().length < 8}
                onClick={() => {
                  addItem({
                    equipment_type_id: manualId.trim(),
                    quantity: Math.max(1, Number(manualQuantity) || 1),
                  });
                  setManualId('');
                  setManualQuantity('1');
                }}
              >
                Add
              </Button>
            </div>
          ) : null}

          {items.length > 0 ? (
            <ul className="flex flex-col divide-y divide-line rounded border border-line">
              {items.map((item) => (
                <li
                  key={item.equipment_type_id}
                  className="flex items-center gap-3 px-3 py-2"
                >
                  <span className="flex-1 truncate text-sm text-ink">
                    {item.name ?? (
                      <code className="font-mono text-data">{item.equipment_type_id}</code>
                    )}
                  </span>
                  <span className="font-mono text-data text-ink-muted">×{item.quantity}</span>
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
          <Callout tone="info" title={state.message ?? 'That slot is no longer free.'}>
            Somebody else holds it now. Under concurrent load this is the expected answer
            for every request but the first — refresh the slots and pick another.
            {typeof state.detail.reason === 'string' ? (
              <span className="mt-1 block font-mono text-xs">
                reason: {state.detail.reason}
              </span>
            ) : null}
          </Callout>
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

function EquipmentPicker({
  equipment,
  onAdd,
}: {
  equipment: EquipmentType[];
  onAdd: (draft: LineItemDraft) => void;
}) {
  const [selected, setSelected] = useState(equipment[0]?.id ?? '');
  const [quantity, setQuantity] = useState('1');

  return (
    <div className="flex items-end gap-2">
      <div className="min-w-0 flex-1">
        <Label htmlFor="equipment-type">Type</Label>
        <div className="mt-1">
          <Select
            ariaLabel="Equipment type"
            value={selected}
            options={equipment.map((type) => ({
              value: type.id,
              label: `${type.name} — ${type.units_owned} owned`,
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
          value={quantity}
          onChange={(event) => setQuantity(event.target.value)}
          className="mt-1 font-mono text-data"
        />
      </div>
      <Button
        type="button"
        disabled={!selected}
        onClick={() => {
          const type = equipment.find((candidate) => candidate.id === selected);
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
  );
}
