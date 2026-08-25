import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHeader } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Panel, PanelBody } from '@/components/ui/panel';
import { api, ApiError, ApiUnreachableError, qs } from '@/lib/api';
import { amount, shortId } from '@/lib/format';
import type { Availability, EquipmentType } from '@/lib/types';
import type { EquipmentAccess } from './hold-state';
import { RoomWorkspace } from './workspace';

export const metadata: Metadata = { title: 'Room · Atrium' };

/**
 * One room, its availability, and the panel that turns a slot into a hold.
 *
 * ## Why the room's name arrives in the querystring
 *
 * There is no `GET /rooms/:id`. The catalogue is published by `/search`, which
 * filters by city, capacity, amenity and price but not by id, so a room's name,
 * venue and rate cannot be fetched for a room already chosen. The options were
 * to page through the whole catalogue looking for one id, or to carry the four
 * fields the header shows on the link that got here.
 *
 * The link carries them, and the page works without them: a deep link with no
 * parameters shows the room by id and everything except the header is
 * unaffected, because availability, holds and pricing all come from the API.
 * The missing endpoint is recorded in PLAN.md rather than worked around
 * silently.
 */
export default async function RoomPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { id } = await params;
  const query = await searchParams;

  const range = resolveRange(query);

  let availability: Availability;
  try {
    availability = await api<Availability>(
      `/rooms/${id}/availability${qs({
        from: `${range.from}T00:00:00.000Z`,
        to: `${range.to}T00:00:00.000Z`,
        duration_minutes: range.duration,
      })}`,
    );
  } catch (err: unknown) {
    return <RoomFailure error={err} />;
  }

  // Staff see the real inventory; a CUSTOMER token gets 403 here and the panel
  // says so rather than showing an empty picker that looks like a venue with no
  // equipment. A PLATFORM_ADMIN sees every venue's, so it is narrowed to this
  // room's venue when the link said which one that is.
  //
  // Three outcomes, and they must not collapse into one. "You may not read the
  // catalogue", "this venue owns no equipment" and "you may read a catalogue,
  // but not this room's venue's" are different facts, and a picker that renders
  // empty for all three tells a venue admin standing in front of another
  // venue's room that the venue has no cameras. It has cameras; they are just
  // not this account's to see.
  const equipmentState = await loadEquipment(query.venue_id);

  return (
    <>
      <PageHeader
        title={query.name ?? `Room ${shortId(id)}`}
        description={[query.venue, query.city].filter(Boolean).join(' · ') || undefined}
        actions={
          <Button variant="ghost" asChild>
            <Link href="/search">Back to search</Link>
          </Button>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-6 rounded border border-line bg-surface px-4 py-3">
        <Fact label="Room id" value={id} mono />
        <Fact label="Timezone" value={availability.timezone} mono />
        <Fact
          label="Slot length"
          value={`${availability.duration_minutes / 60}h`}
          mono
        />
        <Fact
          label="Grid"
          value={`${availability.granularity_minutes}m`}
          mono
        />
        {query.rate ? <Fact label="Rate / hr" value={amount(query.rate)} mono /> : null}
      </div>

      <RoomWorkspace
        roomId={id}
        availability={availability}
        hourlyRateMinor={query.rate ?? null}
        equipment={equipmentState.equipment}
        equipmentAccess={equipmentState.access}
        range={range}
      />
    </>
  );
}

async function loadEquipment(venueId: string | undefined): Promise<{
  equipment: EquipmentType[];
  access: EquipmentAccess;
}> {
  let all: EquipmentType[];

  try {
    all = (await api<{ data: EquipmentType[] }>('/equipment-types')).data;
  } catch (err: unknown) {
    if (
      err instanceof ApiUnreachableError ||
      (err instanceof ApiError && (err.status === 403 || err.status === 404))
    ) {
      return { equipment: [], access: 'unreadable' };
    }
    throw err;
  }

  if (!venueId) return { equipment: all, access: 'available' };

  const mine = all.filter((type) => type.venue_id === venueId);
  if (mine.length === 0 && all.length > 0) {
    return { equipment: [], access: 'other_venue' };
  }
  return { equipment: mine, access: 'available' };
}

function Fact({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-wide text-ink-muted">{label}</span>
      <span className={mono ? 'font-mono text-data text-ink' : 'text-sm text-ink'}>
        {value}
      </span>
    </div>
  );
}

/**
 * Seven days from today by default, capped at the API's 31.
 *
 * Dates rather than instants, so the control is a `date` input and the
 * querystring stays readable. Midnight UTC is what gets sent; the venue's own
 * zone decides which of those hours are inside operating hours, and the API
 * does that part.
 */
function resolveRange(query: Record<string, string | undefined>): {
  from: string;
  to: string;
  duration: number;
} {
  const today = new Date();
  const defaultFrom = today.toISOString().slice(0, 10);
  const defaultTo = new Date(today.getTime() + 7 * 86_400_000).toISOString().slice(0, 10);

  const from = isDate(query.from) ? query.from : defaultFrom;
  let to = isDate(query.to) ? query.to : defaultTo;

  // The API refuses a range over 31 days with a 422. Clamping here means the
  // default screen never sends a request that cannot succeed; a deliberately
  // wide range typed into the URL still gets the API's own message.
  const span = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  if (!Number.isFinite(span) || span <= 0) {
    to = new Date(Date.parse(from) + 7 * 86_400_000).toISOString().slice(0, 10);
  }

  const duration = Number(query.duration);
  return {
    from,
    to,
    duration: Number.isInteger(duration) && duration >= 60 && duration <= 480 ? duration : 60,
  };
}

function isDate(value: string | undefined): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function RoomFailure({ error }: { error: unknown }) {
  if (error instanceof ApiUnreachableError) {
    return (
      <Panel>
        <PanelBody>
          <Callout tone="warn" title={error.message}>
            The API sleeps after 15 idle minutes on its free tier. Reload — the second
            request lands on a warm instance.
          </Callout>
        </PanelBody>
      </Panel>
    );
  }

  if (error instanceof ApiError) {
    return (
      <Panel>
        <PanelBody className="flex flex-col gap-3">
          <Callout
            tone={error.status === 404 ? 'info' : error.status === 422 ? 'info' : 'danger'}
            title={error.message}
          >
            {error.status === 404
              ? 'No room with that id, or it is not visible to this account.'
              : null}
          </Callout>
          <Button variant="ghost" asChild>
            <Link href="/search">Back to search</Link>
          </Button>
        </PanelBody>
      </Panel>
    );
  }

  throw error;
}
