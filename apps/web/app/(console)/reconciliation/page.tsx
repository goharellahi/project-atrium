import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { PageHeader } from '@/components/app-shell';
import { Callout } from '@/components/ui/callout';
import { Empty } from '@/components/ui/empty';
import { Panel, PanelBody, PanelHeader, PanelTitle } from '@/components/ui/panel';
import { Table, TableScroll, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { api, ApiError, ApiUnreachableError, qs } from '@/lib/api';
import { money, shortId, utc } from '@/lib/format';
import { requireUser } from '@/lib/session';
import { DateField } from '@/components/ui/datetime-field';
import { Button } from '@/components/ui/button';

export const metadata: Metadata = { title: 'Reconciliation · Atrium' };

/**
 * INV-5, on a screen.
 *
 * ## Why this exists
 *
 * `GET /admin/reconciliation` is the endpoint that proves money is never
 * silently lost, it is PLATFORM_ADMIN only, and until P8 the console offered no
 * way to reach it — so the one role that can call it had a navigation
 * indistinguishable from a venue admin's, including a "Venue" item for a venue
 * it does not have. The report was reachable by curl and by nothing else.
 *
 * ## Why zero is the interesting number
 *
 * Every other screen in this console is more useful when it has rows. This one
 * is the opposite: an empty table is the claim being upheld. So the headline is
 * the count and the seven checks are named whether or not any of them fired —
 * a report that renders nothing when nothing is wrong is indistinguishable from
 * a report that is broken, and this one exists precisely to be trusted.
 *
 * The dates are read from the querystring and submitted as a plain GET form, so
 * a window is a URL somebody can paste into a bug report. No client state, no
 * action, nothing to get out of step.
 */

interface Reconciliation {
  from: string;
  to: string;
  grace_seconds: number;
  discrepancy_count: number;
  returned: number;
  truncated: boolean;
  by_kind: Record<string, number>;
  discrepancies: {
    kind: string;
    booking_id: string | null;
    charge_id: string | null;
    amount_minor: string | null;
    detail: string;
    observed_at: string;
  }[];
  totals: Record<string, string>;
}

/**
 * The seven checks, in the order the service documents them.
 *
 * Listed here rather than derived from `by_kind`, deliberately: `by_kind` only
 * carries the kinds that fired, so a screen built from it would show nothing on
 * a healthy platform and could never say "all seven checks ran and found
 * nothing". The one thing this page must be able to say is exactly that.
 */
const CHECKS: { kind: string; label: string; means: string }[] = [
  {
    kind: 'capture_without_confirmation',
    label: 'Captured, not confirmed',
    means: 'Money taken for a booking that is neither confirmed nor refunded — INV-4 failing to fire.',
  },
  {
    kind: 'confirmation_without_capture',
    label: 'Confirmed, not captured',
    means: 'A room given away for free. The mirror failure a payments-only report never sees.',
  },
  {
    kind: 'double_capture',
    label: 'Double capture',
    means: 'Two settled payments for one booking — INV-3 failing. The UNIQUE key should make it impossible.',
  },
  {
    kind: 'refund_without_capture',
    label: 'Refund without capture',
    means: 'Money leaving with nothing to have paid for it.',
  },
  {
    kind: 'refund_initiated_not_settled',
    label: 'Refund initiated, never sent',
    means: 'A refund key was minted and the provider was never reached.',
  },
  {
    kind: 'refund_accepted_not_settled',
    label: 'Refund accepted, never settled',
    means: 'The provider took the refund and never reported it. This is what a lost webhook looks like.',
  },
  {
    kind: 'over_refunded',
    label: 'Over refunded',
    means: 'More went back than came in.',
  },
  {
    kind: 'unmatched_delivery',
    label: 'Unmatched delivery',
    means: 'A signed delivery this system never managed to apply, including a charge it has never heard of.',
  },
];

export default async function ReconciliationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const user = await requireUser('/reconciliation');

  // The API refuses everyone else with a 403 anyway. Redirecting rather than
  // rendering an error page is the same choice `/venue` makes for a customer:
  // typing a URL you cannot use is not an attack worth a red screen.
  if (user.role !== 'PLATFORM_ADMIN') redirect('/bookings');

  const query = await searchParams;
  const range = resolveRange(query);

  let report: Reconciliation;
  try {
    report = await api<Reconciliation>(
      `/admin/reconciliation${qs({
        from: `${range.from}T00:00:00.000Z`,
        to: `${range.to}T23:59:59.999Z`,
        grace_seconds: range.grace,
      })}`,
    );
  } catch (err: unknown) {
    return <ReportFailure error={err} />;
  }

  const clean = report.discrepancy_count === 0;

  return (
    <>
      <PageHeader
        title="Reconciliation"
        description="INV-5 — every captured charge maps to one confirmed booking or one refund."
      />

      <Panel className="mb-6">
        <PanelBody>
          <form method="GET" className="flex flex-wrap items-end gap-4">
            <div className="w-[168px]">
              <label
                htmlFor="recon-from"
                className="text-xs uppercase tracking-wide text-ink-muted"
              >
                From
              </label>
              <div className="mt-1">
                <DateField id="recon-from" name="from" defaultValue={range.from} />
              </div>
            </div>
            <div className="w-[168px]">
              <label
                htmlFor="recon-to"
                className="text-xs uppercase tracking-wide text-ink-muted"
              >
                To
              </label>
              <div className="mt-1">
                <DateField id="recon-to" name="to" defaultValue={range.to} />
              </div>
            </div>
            <Button type="submit">Run</Button>
          </form>
          <p className="mt-2 text-xs text-ink-muted">
            {report.grace_seconds}s grace. A charge accepted a moment ago whose webhook
            has not arrived is work in flight, not lost money — the grace window is what
            keeps the report from reporting its own latency.
          </p>
        </PanelBody>
      </Panel>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Metric
          label="Discrepancies"
          value={String(report.discrepancy_count)}
          tone={clean ? 'good' : 'bad'}
        />
        <Metric label="Captured" value={money(report.totals.captured_minor ?? '0')} />
        <Metric label="Refunded" value={money(report.totals.refunded_minor ?? '0')} />
        <Metric
          label="Settled payments"
          value={report.totals.settled_payments ?? '0'}
        />
      </div>

      {clean ? (
        <Callout tone="info" title="Zero discrepancies in this window.">
          All eight checks ran and none fired. That is the claim INV-5 makes, and an
          empty table is what upholding it looks like — the checks below say what each
          one was looking for.
        </Callout>
      ) : null}

      <Panel className="mt-6">
        <PanelHeader>
          <PanelTitle>Checks</PanelTitle>
          <span className="font-mono text-xs text-ink-muted">
            {CHECKS.length} run · {Object.keys(report.by_kind).length} fired
          </span>
        </PanelHeader>
        <TableScroll>
          <Table>
            <colgroup>
              <col style={{ width: '26%' }} />
              <col style={{ width: '10%' }} />
              <col style={{ width: '64%' }} />
            </colgroup>
            <THead>
              <TR className="hover:bg-raised">
                <TH>Check</TH>
                <TH numeric>Found</TH>
                <TH>What it looks for</TH>
              </TR>
            </THead>
            <TBody>
              {CHECKS.map((check) => {
                const found = report.by_kind[check.kind] ?? 0;
                return (
                  <TR key={check.kind}>
                    <TD>{check.label}</TD>
                    <TD numeric mono>{found}</TD>
                    <TD className="text-ink-muted">{check.means}</TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </TableScroll>
      </Panel>

      <Panel className="mt-6">
        <PanelHeader>
          <PanelTitle>Discrepancies</PanelTitle>
          {report.truncated ? (
            <span className="font-mono text-xs text-ink-muted">
              showing {report.returned} of {report.discrepancy_count}
            </span>
          ) : null}
        </PanelHeader>
        {report.discrepancies.length === 0 ? (
          <Empty
            title="Nothing to account for."
            hint="Every captured charge in this window maps to exactly one confirmed booking or exactly one refund."
          />
        ) : (
          <TableScroll>
            <Table>
              <THead>
                <TR className="hover:bg-raised">
                  <TH>Kind</TH>
                  <TH>Booking</TH>
                  <TH>Charge</TH>
                  <TH numeric>Amount</TH>
                  <TH>Observed</TH>
                  <TH>Detail</TH>
                </TR>
              </THead>
              <TBody>
                {report.discrepancies.map((row, index) => (
                  <TR key={`${row.kind}-${row.booking_id ?? row.charge_id ?? index}`}>
                    <TD>{row.kind}</TD>
                    <TD mono className="text-ink-muted">
                      {row.booking_id ? shortId(row.booking_id) : '—'}
                    </TD>
                    <TD mono className="text-ink-muted">
                      {row.charge_id ?? '—'}
                    </TD>
                    <TD numeric mono>
                      {row.amount_minor ? money(row.amount_minor) : '—'}
                    </TD>
                    <TD mono className="text-ink-muted">
                      {utc(row.observed_at)}
                    </TD>
                    <TD className="text-ink-muted">{row.detail}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableScroll>
        )}
        <p className="border-t border-line px-4 py-3 text-xs text-ink-muted">
          Timestamps here are UTC and labelled as such. This is the one screen with no
          venue in scope — a delivery that matched no payment has no venue to have a
          local clock in.
        </p>
      </Panel>
    </>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'good' | 'bad';
}) {
  return (
    <div className="rounded border border-line bg-surface px-4 py-3">
      <p className="text-xs uppercase tracking-wide text-ink-muted">{label}</p>
      <p
        className={
          tone === 'bad'
            ? 'mt-1 font-mono text-md text-danger'
            : 'mt-1 font-mono text-md text-ink'
        }
      >
        {value}
      </p>
    </div>
  );
}

/** Thirty days back through today, unless the URL says otherwise. */
function resolveRange(query: Record<string, string | undefined>): {
  from: string;
  to: string;
  grace: number;
} {
  const today = new Date();
  const defaultTo = today.toISOString().slice(0, 10);
  const defaultFrom = new Date(today.getTime() - 30 * 86_400_000)
    .toISOString()
    .slice(0, 10);

  return {
    from: isDate(query.from) ? query.from : defaultFrom,
    to: isDate(query.to) ? query.to : defaultTo,
    grace: Number.isInteger(Number(query.grace_seconds)) ? Number(query.grace_seconds) : 60,
  };
}

function isDate(value: string | undefined): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function ReportFailure({ error }: { error: unknown }) {
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
        <PanelBody>
          <Callout tone={error.status === 403 ? 'info' : 'danger'} title={error.message}>
            {error.status === 403
              ? 'This report is PLATFORM_ADMIN only. A venue admin is refused rather than given a venue-scoped slice, because the discrepancies that matter most — a delivery matching no payment at all — have no venue to be scoped to.'
              : null}
          </Callout>
        </PanelBody>
      </Panel>
    );
  }

  throw error;
}
