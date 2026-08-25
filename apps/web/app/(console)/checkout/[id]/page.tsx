import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHeader } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Panel, PanelBody } from '@/components/ui/panel';
import { api, ApiError, ApiUnreachableError } from '@/lib/api';
import type { Booking } from '@/lib/types';
import { CheckoutClient } from './checkout-client';

export const metadata: Metadata = { title: 'Checkout · Atrium' };

/**
 * Checkout for one booking.
 *
 * Rendered on the server so the first paint already has the booking, the total
 * and the deadline in it — the countdown must not start from a guess, and a
 * client fetch here would mean a beat where the most important number on the
 * screen is missing.
 *
 * `HOLD_TTL_SECONDS` and `MAX_HOLD_REARMS` are the API's own settings and it
 * does not publish them. They are read from the environment with the API's
 * defaults as fallbacks, and they drive two cosmetic things — the denominator
 * of the progress bar and the sentence next to the extend button. Nothing
 * behavioural depends on them: if they are wrong, the bar starts part-full and
 * the API still decides everything, which is the right way round for a number
 * this side cannot know.
 */
export default async function CheckoutPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let booking: Booking;
  try {
    booking = await api<Booking>(`/bookings/${id}`);
  } catch (err: unknown) {
    return <CheckoutFailure error={err} />;
  }

  const holdTtlSeconds = positiveEnv(process.env.NEXT_PUBLIC_HOLD_TTL_SECONDS, 480);
  const maxRearms = positiveEnv(process.env.NEXT_PUBLIC_MAX_HOLD_REARMS, 2);

  return (
    <>
      <PageHeader
        title="Checkout"
        description="Nothing is charged until you pay, and nothing is confirmed until the provider calls back."
        actions={
          <Button variant="ghost" asChild>
            <Link href="/bookings">My bookings</Link>
          </Button>
        }
      />

      <CheckoutClient
        initial={booking}
        holdTtlMs={holdTtlSeconds * 1000}
        maxRearms={maxRearms}
      />
    </>
  );
}

function positiveEnv(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function CheckoutFailure({ error }: { error: unknown }) {
  if (error instanceof ApiUnreachableError) {
    return (
      <Panel>
        <PanelBody>
          <Callout tone="warn" title={error.message}>
            The booking still exists — this is the API being asleep, not the booking
            being gone. Reload.
          </Callout>
        </PanelBody>
      </Panel>
    );
  }

  if (error instanceof ApiError) {
    return (
      <Panel>
        <PanelBody className="flex flex-col gap-3">
          <Callout tone={error.status === 404 ? 'info' : 'danger'} title={error.message}>
            {error.status === 404
              ? 'No booking with that id belongs to this account. The API answers 404 rather than 403 for another tenant’s row, so a valid id cannot be used to confirm that one exists.'
              : null}
          </Callout>
          <Button variant="ghost" asChild>
            <Link href="/bookings">Back to my bookings</Link>
          </Button>
        </PanelBody>
      </Panel>
    );
  }

  throw error;
}
