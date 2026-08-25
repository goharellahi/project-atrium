import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHeader } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Panel, PanelBody } from '@/components/ui/panel';
import { api, ApiError, ApiUnreachableError, qs } from '@/lib/api';
import { amount, zoneLabel } from '@/lib/format';
import type { Availability, EquipmentType, Room } from '@/lib/types';
import { RoomWorkspace } from './workspace';

export const metadata: Metadata = { title: 'Room · Atrium' };

/**
 * One room, its availability, and the panel that turns a slot into a hold.
 *
 * ## What changed in P8
 *
 * Both of this screen's workarounds are gone, because both endpoints now exist.
 *
 * The room's name, venue, city and rate used to arrive in the querystring,
 * carried on the link that navigated here, because `/search` cannot filter by
 * id and there was no `GET /rooms/:id`. A pasted or shared URL therefore
 * rendered a bare UUID. It now loads the room.
 *
 * Equipment used to be staff-only — `GET /equipment-types` answers a customer
 * 403 — so the only role that books was given a field to paste a UUID into and
 * a sentence explaining why there was no list. `GET /rooms/:id/equipment-types`
 * is the customer-readable catalogue scoped to this room's venue, so the picker
 * is now the same picker for everybody and the UUID field is gone.
 *
 * Query parameters are still read for the availability range, which is what
 * they are for: a range is state about this view, not a fact about the room.
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

  // The room and its calendar in one round trip rather than two sequential
  // ones. They are independent reads and the page needs both before it can
  // render anything.
  let room: Room;
  let availability: Availability;
  try {
    [room, availability] = await Promise.all([
      api<Room>(`/rooms/${id}`),
      api<Availability>(
        `/rooms/${id}/availability${qs({
          from: `${range.from}T00:00:00.000Z`,
          to: `${range.to}T00:00:00.000Z`,
          duration_minutes: range.duration,
        })}`,
      ),
    ]);
  } catch (err: unknown) {
    return <RoomFailure error={err} />;
  }

  // Scoped to the room's venue by the API, not filtered here. Readable by every
  // signed-in role, so there is no longer an access branch to render — a
  // customer, a venue admin from another venue and a platform admin all see the
  // same list, which is the same list the hold path will price.
  const equipment = await loadEquipment(id);

  return (
    <>
      <PageHeader
        title={room.name}
        description={`${room.venue_name} · ${room.city}`}
        actions={
          <Button variant="ghost" asChild>
            <Link href="/search">Back to search</Link>
          </Button>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-6 rounded border border-line bg-surface px-4 py-3">
        <Fact label="Room id" value={id} mono />
        <Fact label="Capacity" value={`${room.capacity}`} mono />
        <Fact label="Rate / hr" value={amount(room.hourly_rate_minor)} mono />
        <Fact
          label="Times shown in"
          value={`${room.timezone} (${zoneLabel(new Date().toISOString(), room.timezone)})`}
        />
        <Fact
          label="Slot length"
          value={`${availability.duration_minutes / 60}h`}
          mono
        />
        <Fact label="Grid" value={`${availability.granularity_minutes}m`} mono />
        {room.amenities.length > 0 ? (
          <Fact label="Amenities" value={room.amenities.join(', ')} />
        ) : null}
      </div>

      <RoomWorkspace
        roomId={id}
        availability={availability}
        hourlyRateMinor={room.hourly_rate_minor}
        equipment={equipment}
        range={range}
      />
    </>
  );
}

/**
 * The equipment a booker may attach to this room.
 *
 * An unreachable catalogue is not a reason to fail the whole screen: the room
 * is bookable without equipment, and a 500 here would take availability down
 * with it. It degrades to an empty list, and the panel says the venue has none
 * on record — which is the same sentence it showed before for a venue that
 * genuinely has none.
 */
async function loadEquipment(roomId: string): Promise<EquipmentType[]> {
  try {
    return (await api<{ data: EquipmentType[] }>(`/rooms/${roomId}/equipment-types`)).data;
  } catch (err: unknown) {
    if (err instanceof ApiUnreachableError || err instanceof ApiError) return [];
    throw err;
  }
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
