'use client';

import { useActionState, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Input, LabelledField } from '@/components/ui/input';
import { PanelBody, PanelHeader, PanelTitle } from '@/components/ui/panel';
import { money } from '@/lib/format';
import { previewRefund, wasCharged, type RefundPreview } from '@/lib/refund';
import type { Booking } from '@/lib/types';
import { cancelBooking } from '../actions';
import { EMPTY_CANCEL_STATE } from '../cancel-state';

/**
 * Cancel, with the refund quoted before the customer commits.
 *
 * ## Why the number is computed here
 *
 * The API computes the real refund inside the cancellation transaction, which is
 * the only place it can be authoritative — and it computes it *during* the
 * cancel, which is after the point where the customer needed to see it. There
 * is no preview endpoint. Everything the calculation needs is already on the
 * booking: `policy_snapshot` carries the tiers frozen at confirmation, and the
 * line items carry the equipment split.
 *
 * So the quote is computed on this side with the same arithmetic — BigInt on
 * minor units, truncating division, lead time clamped at zero — and it is
 * labelled as a quote against the clock rather than as a promise. The tier
 * boundary it sits near is shown too, because "cancel in the next 40 minutes and
 * you keep 50%" is the actual decision in front of the customer. Once the
 * cancellation returns, the API's own breakdown replaces it.
 *
 * The preview recomputes every ten seconds. A booking sitting one minute from a
 * tier boundary must not quote yesterday's number because the tab was left open.
 */
export function CancelPanel({ booking }: { booking: Booking }) {
  const [state, cancel, cancelling] = useActionState(cancelBooking, EMPTY_CANCEL_STATE);
  const [preview, setPreview] = useState<RefundPreview | null>(() =>
    previewRefund(booking, new Date()),
  );
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    setPreview(previewRefund(booking, new Date()));
    const timer = window.setInterval(
      () => setPreview(previewRefund(booking, new Date())),
      10_000,
    );
    return () => window.clearInterval(timer);
  }, [booking]);

  const cancellable = ['HELD', 'PENDING_PAYMENT', 'CONFIRMED'].includes(booking.status);
  const charged = wasCharged(booking.status);

  if (state.status === 'done') {
    return (
      <>
        <PanelHeader>
          <PanelTitle>Cancelled</PanelTitle>
        </PanelHeader>
        <PanelBody className="flex flex-col gap-4">
          <Callout
            tone="info"
            title={`The booking is now ${state.result?.status ?? 'cancelled'}.`}
          >
            The slot was released first and the money moved second. That order is
            deliberate: a refund that fails must not leave a room held.
          </Callout>

          {state.result?.refund ? (
            <dl className="flex flex-col gap-2 border-t border-line pt-4">
              <Line
                label="Room refunded"
                value={money(state.result.refund.room_refund_minor, booking.currency)}
              />
              <Line
                label="Equipment refunded"
                value={money(state.result.refund.equipment_refund_minor, booking.currency)}
              />
              <Line
                label="Total refunded"
                value={money(state.result.refund.total_refund_minor, booking.currency)}
                strong
              />
              <p className="text-xs text-ink-muted">
                Tier: {state.result.refund.tier.room_refund_pct}% room,{' '}
                {state.result.refund.tier.equipment_refund_pct}% equipment, at{' '}
                {state.result.refund.hours_before.toFixed(1)} hours before start.
              </p>
            </dl>
          ) : (
            <p className="text-sm text-ink-muted">
              No refund, because nothing had been captured against this booking — a hold
              that was never paid for, or one that had already been refunded.
            </p>
          )}
        </PanelBody>
      </>
    );
  }

  return (
    <form action={cancel}>
      <input type="hidden" name="booking_id" value={booking.id} />

      <PanelHeader>
        <PanelTitle>Cancel</PanelTitle>
      </PanelHeader>

      <PanelBody className="flex flex-col gap-4">
        {!cancellable ? (
          <p className="text-sm text-ink-muted">
            A booking in{' '}
            <span className="font-mono text-data text-ink">{booking.status}</span> cannot
            be cancelled. The state machine answers an illegal transition with a 409, not
            a 500 — being asked for one is the normal case, not a surprise.
          </p>
        ) : (
          <>
            {charged && preview ? (
              <div className="flex flex-col gap-2">
                <div className="flex items-baseline justify-between">
                  <span className="text-xs uppercase tracking-wide text-ink-muted">
                    You would get back
                  </span>
                  <span className="font-mono text-lg text-ink">
                    {money(preview.total_refund_minor, booking.currency)}
                  </span>
                </div>
                <dl className="flex flex-col gap-1 border-t border-line pt-2">
                  <Line
                    label={`Room · ${preview.tier.room_refund_pct}%`}
                    value={money(preview.room_refund_minor, booking.currency)}
                  />
                  <Line
                    label={`Equipment · ${preview.tier.equipment_refund_pct}%`}
                    value={money(preview.equipment_refund_minor, booking.currency)}
                  />
                  <Line
                    label="Forfeited"
                    value={money(preview.forfeited_minor, booking.currency)}
                  />
                </dl>
                <p className="text-xs text-ink-muted">
                  Quoted against the clock — {preview.hours_before.toFixed(1)} hours
                  before this booking starts, under the tiers frozen onto it when it was
                  confirmed. The API recomputes it at the moment you cancel; if the
                  cancellation crosses a tier boundary between now and then, its number
                  wins.
                </p>
              </div>
            ) : charged ? (
              <p className="text-sm text-ink-muted">
                No cancellation terms were frozen onto this booking, so there is no
                number to quote in advance. The API will compute the refund when the
                cancellation runs.
              </p>
            ) : (
              <p className="text-sm text-ink-muted">
                Nothing has been charged for this booking, so cancelling it moves no
                money. The slot is released immediately.
              </p>
            )}

            <LabelledField
              label="Reason"
              htmlFor="cancel-reason"
              hint="Written to the audit trail. Left blank, the API records customer.cancelled."
            >
              <Input
                id="cancel-reason"
                name="reason"
                maxLength={500}
                placeholder="customer.cancelled"
              />
            </LabelledField>

            {state.status === 'conflict' ? (
              <Callout tone="info" title={state.message ?? 'That is not a legal transition.'}>
                The booking is not in a state this can be applied to. Reload to see where
                it actually is.
              </Callout>
            ) : null}

            {state.status === 'unreachable' ? (
              <Callout tone="warn" title={state.message ?? 'The API did not answer.'}>
                Nothing was cancelled. Try again.
              </Callout>
            ) : null}

            {state.status === 'error' && state.message ? (
              <Callout tone="danger" title={state.message} />
            ) : null}

            {confirming ? (
              <div className="flex items-center gap-2">
                <Button type="submit" variant="danger" disabled={cancelling}>
                  {cancelling ? 'Cancelling…' : 'Yes, cancel it'}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={cancelling}
                  onClick={() => setConfirming(false)}
                >
                  Keep it
                </Button>
              </div>
            ) : (
              <Button type="button" variant="danger" onClick={() => setConfirming(true)}>
                Cancel this booking
              </Button>
            )}
          </>
        )}
      </PanelBody>
    </form>
  );
}

function Line({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-sm text-ink-muted">{label}</dt>
      <dd
        className={
          strong ? 'font-mono text-data font-medium text-ink' : 'font-mono text-data text-ink'
        }
      >
        {value}
      </dd>
    </div>
  );
}
