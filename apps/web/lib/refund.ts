/**
 * The refund preview shown before a customer confirms a cancellation.
 *
 * ## Why this arithmetic exists twice
 *
 * The API computes the real refund in `apps/api/src/payments/refund-policy.ts`
 * and does it inside the cancellation transaction, which is the only place it
 * can be authoritative. But it is computed *during* the cancel, and the brief
 * requires the customer to see the amount *before* they commit — and there is no
 * preview endpoint. Everything the calculation needs is already on the booking:
 * `policy_snapshot` carries the tiers frozen at confirmation, and the line items
 * carry the equipment split.
 *
 * So this is a deliberate second implementation, and it is written to be
 * line-for-line the same arithmetic rather than a convenient approximation:
 * BigInt on minor units, truncating division, `hours_before` clamped at zero.
 * If the two ever disagree the customer was quoted a number the venue did not
 * honour, which is worse than showing nothing — so the preview is labelled as an
 * estimate against the clock, and the screen shows the API's own breakdown once
 * the cancellation returns.
 *
 * A `/bookings/:id/refund-preview` endpoint would delete this file. It is an
 * `apps/api` change and this phase does not touch `apps/api`; it is recorded in
 * PLAN.md as the follow-up.
 */

import type { Booking, Tier } from './types';

export interface RefundPreview {
  hours_before: number;
  tier: Tier;
  room_minor: bigint;
  equipment_minor: bigint;
  room_refund_minor: bigint;
  equipment_refund_minor: bigint;
  total_refund_minor: bigint;
  forfeited_minor: bigint;
}

/** The first tier whose threshold the lead time clears. Descending ladder. */
function selectTier(tiers: Tier[], hoursBefore: number): Tier | null {
  for (const tier of tiers) {
    if (hoursBefore >= tier.min_hours_before) return tier;
  }
  return null;
}

/**
 * Split the total into its room and equipment halves.
 *
 * Mirrors `splitTotals` in the API: each line item is billed per half hour, so
 * the equipment share is `half_hours * rate * quantity / 2`, and the room is
 * whatever the total has left. The room share is floored at zero for the same
 * reason it is there — a rounding artefact must not produce a negative.
 */
export function splitTotals(booking: Booking): { roomMinor: bigint; equipmentMinor: bigint } {
  const halfHours = BigInt(
    Math.round(
      ((new Date(booking.ends_at).getTime() - new Date(booking.starts_at).getTime()) /
        3_600_000) *
        2,
    ),
  );

  const equipmentMinor = booking.line_items.reduce(
    (sum, item) => sum + (halfHours * BigInt(item.rate_minor) * BigInt(item.quantity)) / 2n,
    0n,
  );

  const total = BigInt(booking.total_minor);
  const roomMinor = total - equipmentMinor;
  return { roomMinor: roomMinor < 0n ? 0n : roomMinor, equipmentMinor };
}

/**
 * What cancelling right now would be worth.
 *
 * `null` when there is nothing to quote: no policy was frozen onto the booking,
 * or the tiers do not cover the lead time. Both mean the same thing to the
 * screen — do not put a number in front of the customer — and neither is a
 * reason to block the cancellation itself.
 */
export function previewRefund(booking: Booking, at: Date): RefundPreview | null {
  const tiers = booking.policy_snapshot?.tiers;
  if (!tiers || tiers.length === 0) return null;

  const hoursBefore = Math.max(
    0,
    (new Date(booking.starts_at).getTime() - at.getTime()) / 3_600_000,
  );

  const tier = selectTier(tiers, hoursBefore);
  if (!tier) return null;

  const { roomMinor, equipmentMinor } = splitTotals(booking);

  // Integer division truncates, which rounds down, which favours the venue by
  // at most one minor unit per component — the same choice the API makes, and
  // for the same reason: refunding more than was captured cannot be reconciled.
  const roomRefund = (roomMinor * BigInt(tier.room_refund_pct)) / 100n;
  const equipmentRefund = (equipmentMinor * BigInt(tier.equipment_refund_pct)) / 100n;
  const total = roomRefund + equipmentRefund;

  return {
    hours_before: hoursBefore,
    tier,
    room_minor: roomMinor,
    equipment_minor: equipmentMinor,
    room_refund_minor: roomRefund,
    equipment_refund_minor: equipmentRefund,
    total_refund_minor: total,
    forfeited_minor: BigInt(booking.total_minor) - total,
  };
}

/**
 * Whether a cancellation would move money at all.
 *
 * A hold that was never paid for has nothing to refund, and the API returns
 * `refund: null` for exactly that case. Saying "no refund" there would read as
 * a penalty; the screen says "nothing was charged" instead.
 */
export function wasCharged(status: Booking['status']): boolean {
  return status === 'CONFIRMED' || status === 'COMPLETED';
}
