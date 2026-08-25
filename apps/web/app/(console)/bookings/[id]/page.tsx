import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHeader } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Panel, PanelBody, PanelHeader, PanelTitle } from '@/components/ui/panel';
import { Status } from '@/components/ui/status';
import { Table, TableScroll, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { api, ApiError, ApiUnreachableError } from '@/lib/api';
import { durationHours, money, shortId, utc } from '@/lib/format';
import type { Booking } from '@/lib/types';
import { CancelPanel } from './cancel-panel';

export const metadata: Metadata = { title: 'Booking · Atrium' };

/**
 * One booking, and the cancellation decision.
 *
 * The policy tiers are printed in full rather than summarised. They are the
 * terms the customer is being held to and they were frozen onto this booking at
 * confirmation — a venue that tightens its terms next week cannot retroactively
 * change what this one is worth, and showing the frozen ladder is how that
 * promise becomes visible instead of merely true.
 */
export default async function BookingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let booking: Booking;
  try {
    booking = await api<Booking>(`/bookings/${id}`);
  } catch (err: unknown) {
    return <BookingFailure error={err} />;
  }

  const live = booking.status === 'HELD' || booking.status === 'PENDING_PAYMENT';

  return (
    <>
      <PageHeader
        title={`Booking ${shortId(booking.id)}`}
        description={`${utc(booking.starts_at)} · ${durationHours(booking.starts_at, booking.ends_at)}`}
        actions={
          <>
            {live ? (
              <Button variant="primary" asChild>
                <Link href={`/checkout/${booking.id}`}>Go to checkout</Link>
              </Button>
            ) : null}
            <Button variant="ghost" asChild>
              <Link href="/bookings">All bookings</Link>
            </Button>
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_360px] lg:items-start">
        <div className="flex flex-col gap-6">
          <Panel>
            <PanelHeader>
              <PanelTitle>Record</PanelTitle>
              <Status status={booking.status} />
            </PanelHeader>
            <PanelBody>
              <dl className="grid gap-4 sm:grid-cols-2">
                <Pair label="Booking id" value={booking.id} />
                <Pair label="Room id" value={booking.room_id} />
                <Pair label="Venue id" value={booking.venue_id} />
                <Pair label="Starts" value={utc(booking.starts_at)} />
                <Pair label="Ends" value={utc(booking.ends_at)} />
                <Pair
                  label="Hold expires"
                  value={booking.expires_at ? utc(booking.expires_at) : '—'}
                />
                <Pair label="Created" value={utc(booking.created_at)} />
                <Pair label="Last updated" value={utc(booking.updated_at)} />
              </dl>

              <div className="mt-4 flex items-baseline justify-between border-t border-line pt-4">
                <span className="text-xs uppercase tracking-wide text-ink-muted">
                  Total
                </span>
                <span className="font-mono text-md text-ink">
                  {money(booking.total_minor, booking.currency)}
                </span>
              </div>
            </PanelBody>
          </Panel>

          {booking.line_items.length > 0 ? (
            <Panel>
              <PanelHeader>
                <PanelTitle>Equipment</PanelTitle>
                <span className="font-mono text-xs text-ink-muted">
                  {booking.line_items.length} line items
                </span>
              </PanelHeader>
              <TableScroll>
                <Table>
                  <colgroup>
                    <col style={{ width: '46%' }} />
                    <col style={{ width: '24%' }} />
                    <col style={{ width: '15%' }} />
                    <col style={{ width: '15%' }} />
                  </colgroup>
                  <THead>
                    <TR className="hover:bg-raised">
                      <TH>Type</TH>
                      <TH>Id</TH>
                      <TH numeric>Qty</TH>
                      <TH numeric>Rate / hr</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {booking.line_items.map((item) => (
                      <TR key={item.equipment_type_id}>
                        <TD>{item.name ?? '—'}</TD>
                        <TD mono className="text-ink-muted">
                          {shortId(item.equipment_type_id)}
                        </TD>
                        <TD numeric>{item.quantity}</TD>
                        <TD numeric>{money(item.rate_minor, booking.currency)}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </TableScroll>
            </Panel>
          ) : null}

          <Panel>
            <PanelHeader>
              <PanelTitle>Cancellation terms</PanelTitle>
              {booking.policy_snapshot ? (
                <span className="font-mono text-xs text-ink-muted">
                  {booking.policy_snapshot.resolved_from} ·{' '}
                  {shortId(booking.policy_snapshot.policy_id)}
                </span>
              ) : null}
            </PanelHeader>

            {booking.policy_snapshot ? (
              <>
                <TableScroll>
                  <Table>
                    <colgroup>
                      <col style={{ width: '44%' }} />
                      <col style={{ width: '28%' }} />
                      <col style={{ width: '28%' }} />
                    </colgroup>
                    <THead>
                      <TR className="hover:bg-raised">
                        <TH>Cancelling at least</TH>
                        <TH numeric>Room refunded</TH>
                        <TH numeric>Equipment refunded</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {booking.policy_snapshot.tiers.map((tier) => (
                        <TR key={tier.min_hours_before}>
                          <TD>
                            {tier.min_hours_before === 0
                              ? 'Less than the tier above'
                              : `${tier.min_hours_before} hours before start`}
                          </TD>
                          <TD numeric>{tier.room_refund_pct}%</TD>
                          <TD numeric>{tier.equipment_refund_pct}%</TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </TableScroll>
                <p className="border-t border-line px-4 py-3 text-xs text-ink-muted">
                  Frozen onto this booking at{' '}
                  {utc(booking.policy_snapshot.snapshot_at)}. A later change to the
                  venue&apos;s policy does not reach back to it.
                </p>
              </>
            ) : (
              <PanelBody>
                <p className="text-sm text-ink-muted">
                  No terms are frozen onto this booking. The snapshot is written when a
                  booking is confirmed, so a hold that was never paid for has none — and
                  cancelling one moves no money.
                </p>
              </PanelBody>
            )}
          </Panel>
        </div>

        <Panel className="lg:sticky lg:top-[72px]">
          <CancelPanel booking={booking} />
        </Panel>
      </div>
    </>
  );
}

function Pair({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs uppercase tracking-wide text-ink-muted">{label}</dt>
      <dd className="truncate font-mono text-data text-ink">{value}</dd>
    </div>
  );
}

function BookingFailure({ error }: { error: unknown }) {
  if (error instanceof ApiUnreachableError) {
    return (
      <Panel>
        <PanelBody>
          <Callout tone="warn" title={error.message}>
            The API sleeps after 15 idle minutes on its free tier. Reload.
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
              ? 'No booking with that id belongs to this account. The API answers 404 rather than 403 for another tenant’s row, so a valid id cannot be used to confirm one exists.'
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
