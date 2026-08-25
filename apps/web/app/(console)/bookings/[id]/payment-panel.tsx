import { Panel, PanelBody, PanelHeader, PanelTitle } from '@/components/ui/panel';
import { money, shortId, utc } from '@/lib/format';
import type { BookingPayment } from '@/lib/types';

/**
 * The payment as it currently stands, not as the provider first described it.
 *
 * ## The defect this closes
 *
 * A CONFIRMED booking on the deployed instance showed PAYMENT: PENDING with a
 * charge id beside it. The database was right and the screen was stale:
 * `payments.status` is advanced to SUCCEEDED in the same transaction that
 * confirms the booking, but the only thing the console had ever seen was the
 * provider's 202 — the answer to `POST /bookings/:id/pay`, which describes the
 * charge at the moment it was ACCEPTED and by construction never changes.
 *
 * `GET /bookings/:id` now carries the settled row, which is the same row the
 * reconciliation report reads. So this panel and INV-5 cannot disagree.
 *
 * ## Why the two are still shown separately at checkout
 *
 * The checkout screen keeps showing the acceptance receipt as well, labelled as
 * such. "Accepted, awaiting the webhook" is a real and interesting state — it
 * is the whole shape of an at-least-once payment channel — and collapsing it
 * into the settled status would hide the gap the system is built to survive.
 * What was wrong was showing only the first and calling it the current state.
 */
export function PaymentPanel({
  payment,
  currency,
}: {
  payment: BookingPayment | null;
  currency: string;
}) {
  if (!payment) {
    return (
      <Panel>
        <PanelHeader>
          <PanelTitle>Payment</PanelTitle>
        </PanelHeader>
        <PanelBody>
          <p className="text-sm text-ink-muted">
            No charge has been attempted for this booking. A hold moves no money until
            it is paid for.
          </p>
        </PanelBody>
      </Panel>
    );
  }

  const refunded = BigInt(payment.refunded_minor || '0') > 0n;

  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>Payment</PanelTitle>
        <span className="font-mono text-xs text-ink-muted">{payment.status}</span>
      </PanelHeader>
      <PanelBody>
        <dl className="grid gap-4 sm:grid-cols-2">
          <Pair label="Status" value={payment.status} />
          <Pair label="Charge id" value={payment.charge_id ?? '—'} />
          <Pair label="Amount" value={money(payment.amount_minor, currency)} />
          <Pair
            label="Refunded"
            value={refunded ? money(payment.refunded_minor, currency) : '—'}
          />
          {payment.refund_id ? (
            <Pair label="Refund id" value={payment.refund_id} />
          ) : null}
          <Pair label="Settled at" value={utc(payment.updated_at)} />
          <Pair label="Payment id" value={shortId(payment.payment_id)} />
        </dl>

        {payment.failure_reason ? (
          <p className="mt-4 border-t border-line pt-4 text-sm text-ink">
            {payment.failure_reason}
          </p>
        ) : null}

        <p className="mt-4 border-t border-line pt-4 text-xs text-ink-muted">
          {payment.status === 'PENDING'
            ? 'Accepted by the provider and not yet settled. The webhook is what moves this to SUCCEEDED and the booking to CONFIRMED; if it never arrives, the API asks the provider directly.'
            : 'This is the row the reconciliation report reads. A charge id with no settled status here, or a settled status with no confirmed booking, is precisely what that report exists to find.'}
        </p>
      </PanelBody>
    </Panel>
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
