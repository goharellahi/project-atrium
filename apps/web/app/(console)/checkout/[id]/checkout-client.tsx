'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useActionState, useCallback, useEffect, useRef, useState } from 'react';
import { Countdown } from '@/components/countdown';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Panel, PanelBody, PanelHeader, PanelTitle } from '@/components/ui/panel';
import { Status } from '@/components/ui/status';
import { money, venueTime } from '@/lib/format';
import type { Booking } from '@/lib/types';
import { extendHold, payForBooking } from './actions';
import { EMPTY_EXTEND_STATE, EMPTY_PAY_STATE, type PayState } from './pay-state';

/**
 * Checkout: the hold, the clock, the charge, and the terminal states.
 *
 * ## The pending state is the point of this screen
 *
 * `POST /bookings/:id/pay` returns as soon as Paygate accepts the charge. The
 * booking is not CONFIRMED at that moment and may not be for a minute — the
 * webhook is asynchronous, and about one delivery in twenty is deliberately
 * parked for 60 to 90 seconds. So there is a real, load-bearing pending state
 * here, and it resolves by asking again rather than by spinning.
 *
 * The polling has a ceiling. It asks every two seconds and stops after three
 * minutes, because a progress indicator that never stops is a lie about what
 * the application knows. Stopping is not giving up: the copy at that point says
 * the webhook will still land and the booking will still confirm, which is true
 * — exactly-once settlement is a property of the API, not of whether this tab
 * is open.
 */

const POLL_INTERVAL_MS = 2_000;
const POLL_CEILING_MS = 180_000;

/** Nothing polls past one of these. */
const TERMINAL = new Set([
  'CONFIRMED',
  'COMPLETED',
  'FAILED',
  'EXPIRED',
  'CANCELLED',
  'REFUNDED',
]);

export function CheckoutClient({
  initial,
  holdTtlMs,
  maxRearms,
}: {
  initial: Booking;
  holdTtlMs: number;
  maxRearms: number;
}) {
  const router = useRouter();
  const [booking, setBooking] = useState(initial);
  const [expiredLocally, setExpiredLocally] = useState(false);
  const [pollGaveUp, setPollGaveUp] = useState(false);
  const [pollError, setPollError] = useState<string | null>(null);

  const [payState, pay, paying] = useActionState(payForBooking, EMPTY_PAY_STATE);
  const [extendState, extend, extending] = useActionState(extendHold, EMPTY_EXTEND_STATE);

  // A freshly server-rendered booking wins. Both actions revalidate this path,
  // so this is how an action's result reaches the copy the poll is updating.
  const startedAt = useRef<number | null>(null);

  useEffect(() => {
    setBooking(initial);
    if (!TERMINAL.has(initial.status)) {
      // A fresh server render of a booking that is still in flight restarts the
      // three-minute window as well as clearing the give-up flag. Without the
      // reset, a retry after a give-up would re-arm the poll against a clock
      // that had already run out and stop again on its first tick.
      setPollGaveUp(false);
      startedAt.current = null;
    }
  }, [initial]);

  const waiting = booking.status === 'PENDING_PAYMENT';

  const refresh = useCallback(async (): Promise<void> => {
    const response = await fetch(`/api/bookings/${booking.id}`, { cache: 'no-store' });

    if (response.status === 401) {
      router.push(`/login?next=${encodeURIComponent(`/checkout/${booking.id}`)}`);
      return;
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { message?: string };
      setPollError(
        body.message ?? `The console could not re-read the booking (${response.status}).`,
      );
      return;
    }

    setPollError(null);
    setBooking((await response.json()) as Booking);
  }, [booking.id, router]);

  useEffect(() => {
    if (!waiting || pollGaveUp) return;

    startedAt.current ??= Date.now();

    const timer = window.setInterval(() => {
      if (Date.now() - (startedAt.current ?? Date.now()) > POLL_CEILING_MS) {
        setPollGaveUp(true);
        return;
      }
      void refresh();
    }, POLL_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, [waiting, pollGaveUp, refresh]);

  const live = booking.status === 'HELD' || booking.status === 'PENDING_PAYMENT';
  const holdIsUp = expiredLocally && live;
  const extensionsLeft = Math.max(0, maxRearms - booking.rearm_count);

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_360px] lg:items-start">
      <div className="flex flex-col gap-6">
        <StateCard
          booking={booking}
          waiting={waiting}
          pollGaveUp={pollGaveUp}
          pollError={pollError}
          holdIsUp={holdIsUp}
          payState={payState}
          onRefresh={() => void refresh()}
        />

        <Panel>
          <PanelHeader>
            <PanelTitle>Booking</PanelTitle>
            <Status status={booking.status} />
          </PanelHeader>
          <PanelBody>
            <dl className="grid gap-4 sm:grid-cols-2">
              <Pair label="Booking id" value={booking.id} mono />
              <Pair label="Room" value={booking.room_name ?? booking.room_id} />
              <Pair
                label="Starts"
                value={venueTime(booking.starts_at, booking.timezone)}
                mono
              />
              <Pair
                label="Ends"
                value={venueTime(booking.ends_at, booking.timezone)}
                mono
              />
              <Pair label="Total" value={money(booking.total_minor, booking.currency)} mono />
              <Pair
                label="Extensions used"
                value={`${booking.rearm_count} of ${maxRearms}`}
                mono
              />
            </dl>

            {booking.line_items.length > 0 ? (
              <div className="mt-4 border-t border-line pt-4">
                <p className="text-xs uppercase tracking-wide text-ink-muted">Equipment</p>
                <ul className="mt-2 flex flex-col divide-y divide-line rounded border border-line">
                  {booking.line_items.map((item) => (
                    <li
                      key={item.equipment_type_id}
                      className="flex items-center gap-3 px-3 py-2"
                    >
                      <span className="flex-1 truncate text-sm text-ink">
                        {item.name ?? item.equipment_type_id}
                      </span>
                      <span className="font-mono text-data text-ink-muted">
                        &times;{item.quantity}
                      </span>
                      <span className="font-mono text-data text-ink">
                        {money(item.rate_minor, booking.currency)} / hr
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </PanelBody>
        </Panel>
      </div>

      <Panel className="lg:sticky lg:top-[72px]">
        <PanelHeader>
          <PanelTitle>Payment</PanelTitle>
        </PanelHeader>
        <PanelBody className="flex flex-col gap-4">
          {live && booking.expires_at ? (
            <Countdown
              expiresAt={booking.expires_at}
              totalMs={holdTtlMs}
              onExpire={() => setExpiredLocally(true)}
            />
          ) : null}

          <div className="flex items-baseline justify-between border-t border-line pt-4">
            <span className="text-xs uppercase tracking-wide text-ink-muted">Amount</span>
            <span className="font-mono text-md text-ink">
              {money(booking.total_minor, booking.currency)}
            </span>
          </div>

          {booking.status === 'HELD' ? (
            <>
              <form action={pay}>
                <input type="hidden" name="booking_id" value={booking.id} />
                <Button
                  type="submit"
                  variant="primary"
                  className="w-full"
                  disabled={paying || holdIsUp}
                >
                  {paying ? 'Charging…' : 'Pay now'}
                </Button>
              </form>

              <form action={extend}>
                <input type="hidden" name="booking_id" value={booking.id} />
                <Button
                  type="submit"
                  className="w-full"
                  disabled={extending || holdIsUp || extensionsLeft === 0}
                >
                  {extending ? 'Extending…' : 'Extend hold'}
                </Button>
              </form>
              <p className="-mt-2 text-xs text-ink-muted">
                {extensionsLeft === 0
                  ? `This hold has used all ${maxRearms} of its extensions.`
                  : `${extensionsLeft} extension${extensionsLeft === 1 ? '' : 's'} left, and a hold cannot outlive its 30-minute cap either way.`}
              </p>
              {extendState.message ? (
                <Callout tone="info" title={extendState.message} />
              ) : null}
            </>
          ) : null}

          {booking.status === 'PENDING_PAYMENT' ? (
            <>
              <form action={pay}>
                <input type="hidden" name="booking_id" value={booking.id} />
                <Button type="submit" className="w-full" disabled={paying}>
                  {paying ? 'Retrying…' : 'Retry the charge'}
                </Button>
              </form>
              <p className="-mt-2 text-xs text-ink-muted">
                Safe. The idempotency key comes from the booking id and is minted by the
                API, so a retry cannot produce a second charge.
              </p>
            </>
          ) : null}

          {booking.status === 'EXPIRED' || booking.status === 'FAILED' ? (
            <Button className="w-full" asChild>
              <Link href={`/rooms/${booking.room_id}`}>Find another slot</Link>
            </Button>
          ) : null}

          {booking.status === 'CONFIRMED' || booking.status === 'COMPLETED' ? (
            <Button className="w-full" asChild>
              <Link href="/bookings">Open my bookings</Link>
            </Button>
          ) : null}

          {payState.payment ? (
            <div className="border-t border-line pt-4">
              <p className="text-xs uppercase tracking-wide text-ink-muted">
                Provider record
              </p>
              <dl className="mt-2 flex flex-col gap-1">
                <PairInline label="Charge" value={payState.payment.charge_id ?? '—'} />
                <PairInline label="Accepted as" value={payState.payment.status} />
                <PairInline label="Key" value={payState.payment.idempotency_key} />
                {/*
                  The settled row, beside the acceptance receipt rather than
                  instead of it. `GET /bookings/:id` now carries the payment the
                  reconciler reads, and this screen already polls that endpoint,
                  so both states are visible and both are labelled.
                */}
                <PairInline
                  label="Settled as"
                  value={booking.payment?.status ?? 'not settled yet'}
                />
              </dl>
              {/*
                Two lines, and the difference between them is the point.
                "Accepted as" is what the provider said when it took the charge,
                and it never changes. "Settled as" is the payments row, which the
                webhook advances and which the reconciliation report reads.

                P7 showed only the first, so a CONFIRMED booking sat beside a
                payment reading PENDING and looked like a contradiction. It was
                not one — payments.status is genuinely advanced on capture — but
                a screen that can be read as one is a defect whatever the
                database says.
              */}
              <p className="mt-2 text-xs text-ink-muted">
                Accepted first, settled second. The gap between these two lines is the
                webhook in flight — which for one delivery in twenty this provider parks
                deliberately for a minute or more.
              </p>
            </div>
          ) : null}
        </PanelBody>
      </Panel>
    </div>
  );
}

/**
 * The sentence at the top that says what is going on.
 *
 * Every branch is a distinct thing that happened and none of them share copy.
 * That is the point of the screen: "your charge was accepted and the provider
 * has not called back yet", "your booking is confirmed", and "the hold ran out
 * while the payment was in flight and the money is coming back" are three
 * different situations, and an interface that renders all three as a spinner or
 * all three as an error has thrown away the only thing the customer needed.
 */
function StateCard({
  booking,
  waiting,
  pollGaveUp,
  pollError,
  holdIsUp,
  payState,
  onRefresh,
}: {
  booking: Booking;
  waiting: boolean;
  pollGaveUp: boolean;
  pollError: string | null;
  holdIsUp: boolean;
  payState: PayState;
  onRefresh: () => void;
}) {
  if (booking.status === 'CONFIRMED' || booking.status === 'COMPLETED') {
    return (
      <Callout tone="info" title="Confirmed. The room is yours.">
        The provider&apos;s webhook landed and the booking moved to{' '}
        <span className="font-mono text-data text-ink">{booking.status}</span>. The
        cancellation terms that apply to it were frozen at that moment and travel with
        the booking, so a later policy change cannot alter what it is worth.
      </Callout>
    );
  }

  if (booking.status === 'REFUNDED') {
    return (
      <Callout tone="info" title="Refunded.">
        A charge was captured against this booking and has been returned. Every captured
        charge maps to exactly one confirmed booking or exactly one refund; this one is a
        refund.
      </Callout>
    );
  }

  if (booking.status === 'CANCELLED') {
    return (
      <Callout tone="info" title="Cancelled.">
        The slot has been released. If the booking had been paid for, the refund is
        recorded against it.
      </Callout>
    );
  }

  if (booking.status === 'FAILED') {
    return (
      <Callout tone="danger" title="The charge failed.">
        The provider declined it and the booking is terminal — the slot went back into
        the pool. Nothing was captured, so there is nothing to refund. Hold another slot
        to try again.
      </Callout>
    );
  }

  if (booking.status === 'EXPIRED') {
    return (
      <Callout tone="info" title="The hold expired.">
        Holds live for a few minutes and this one ran out, so the slot was released. If a
        payment was in flight when it lapsed, the API refuses to confirm the booking and
        refunds the charge automatically — that sequence is written to the booking&apos;s
        audit trail rather than left to be noticed.
      </Callout>
    );
  }

  if (payState.outcome === 'transient') {
    return (
      <Callout
        tone="warn"
        title={payState.message ?? 'The payment provider rejected the request.'}
      >
        This is the provider&apos;s deliberate transient-failure branch — roughly one
        charge in ten. Press <strong className="font-medium text-ink">Pay now</strong>{' '}
        again. The idempotency key is derived from the booking id, so the same booking
        cannot be charged twice however many times it is retried.
      </Callout>
    );
  }

  if (payState.outcome === 'no_answer') {
    return (
      <Callout
        tone="warn"
        title={payState.message ?? 'The payment provider did not answer.'}
      >
        The charge may have been accepted anyway, and its webhook may already be on its
        way. Retrying is still safe, for the same reason — one key, one charge.
      </Callout>
    );
  }

  if (payState.outcome === 'conflict') {
    return (
      <Callout
        tone="info"
        title={payState.message ?? 'The booking is not payable in this state.'}
      >
        <button
          type="button"
          onClick={onRefresh}
          className="mt-1 text-sm text-ink underline transition-quiet hover:text-ink-muted"
        >
          Re-read the booking
        </button>
      </Callout>
    );
  }

  if (payState.outcome === 'error' && payState.message) {
    return <Callout tone="danger" title={payState.message} />;
  }

  if (waiting) {
    if (pollGaveUp) {
      return (
        <Callout tone="warn" title="Still pending after three minutes.">
          The console has stopped asking — a progress indicator that never stops is a lie
          about what it knows. The charge is accepted and the webhook will still land;
          confirmation does not depend on this tab staying open.
          <button
            type="button"
            onClick={onRefresh}
            className="mt-2 block text-sm text-ink underline transition-quiet hover:text-ink-muted"
          >
            Check again
          </button>
        </Callout>
      );
    }

    return (
      <Callout tone="warn" title="Charge accepted. Waiting for the provider's webhook.">
        The booking confirms when the webhook lands, not when the charge returns — that
        separation is what makes the effect exactly-once over an at-least-once channel.
        Most arrive in a second or two; the provider parks about one in twenty for 60 to
        90 seconds on purpose. This screen is asking every two seconds.
        {pollError ? <span className="mt-1 block text-sm text-danger">{pollError}</span> : null}
      </Callout>
    );
  }

  if (holdIsUp) {
    return (
      <Callout tone="info" title="The clock has run out on this hold.">
        The API will refuse to charge it now and will mark it expired on the next touch.
        Hold the slot again if it is still free.
      </Callout>
    );
  }

  return (
    <Callout tone="info" title="Held. Nothing has been charged yet.">
      The slot is reserved until the countdown reaches zero. Paying moves the booking to
      pending, and the provider&apos;s webhook is what confirms it.
    </Callout>
  );
}

function Pair({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs uppercase tracking-wide text-ink-muted">{label}</dt>
      <dd className={mono ? 'truncate font-mono text-data text-ink' : 'text-sm text-ink'}>
        {value}
      </dd>
    </div>
  );
}

function PairInline({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-xs uppercase tracking-wide text-ink-muted">{label}</dt>
      <dd className="truncate font-mono text-xs text-ink">{value}</dd>
    </div>
  );
}
