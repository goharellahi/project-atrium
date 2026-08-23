import { z } from 'zod';

/**
 * Cancellation policy — data, not code.
 *
 * The brief states tiers and then requires that a venue override them through
 * the API with no deploy. That rules out the obvious implementation, a
 * percentage table in TypeScript, because the moment a venue can override it
 * there are two places the answer could come from and the winner depends on
 * whether a row happens to exist. So the tiers live in `cancellation_policies`
 * — the platform default is the row with `venue_id IS NULL`, seeded by
 * migration 0003 — and this file only knows how to READ them.
 *
 * Nothing here touches the database, the clock, or a request. It is a pure
 * function of (tiers, amounts, two timestamps), which is why every tier
 * boundary can be tested without standing up a stack.
 */

export const TierSchema = z.object({
  /** Inclusive lower bound in hours before start. The ladder is descending. */
  min_hours_before: z.number().min(0),
  room_refund_pct: z.number().int().min(0).max(100),
  equipment_refund_pct: z.number().int().min(0).max(100),
});

export type Tier = z.infer<typeof TierSchema>;

/**
 * A policy must be TOTAL: sorted descending and bottoming out at zero hours.
 *
 * Without the `min_hours_before: 0` rung a lookup can fall off the end of the
 * ladder, and there is no sensible thing to do at that point — refunding
 * nothing and refunding everything are both defensible and both wrong to pick
 * silently. Refusing the policy at the point it is WRITTEN, instead, means the
 * cancellation path has no unreachable branch to get wrong.
 */
export const TiersSchema = z
  .array(TierSchema)
  .min(1)
  .refine(
    (tiers) => tiers.every((t, i) => i === 0 || t.min_hours_before < tiers[i - 1]!.min_hours_before),
    { message: 'tiers must be ordered strictly descending by min_hours_before' },
  )
  .refine((tiers) => tiers[tiers.length - 1]!.min_hours_before === 0, {
    message: 'the last tier must have min_hours_before: 0 so every cancellation matches one',
  });

/**
 * What is frozen onto `bookings.policy_snapshot` at the moment of confirmation.
 *
 * Cancellation reads THIS and never the live policy. A venue that tightens its
 * terms on Tuesday must not retroactively change what a booking confirmed on
 * Monday is worth — the customer agreed to Monday's terms. `policy_id` and
 * `resolved_from` are carried so a dispute can be traced back to the exact row.
 */
export interface PolicySnapshot {
  tiers: Tier[];
  policy_id: string;
  resolved_from: 'venue' | 'platform';
  snapshot_at: string;
}

export const PolicySnapshotSchema = z.object({
  tiers: TiersSchema,
  policy_id: z.string(),
  resolved_from: z.enum(['venue', 'platform']),
  snapshot_at: z.string(),
});

export function parseSnapshot(value: unknown): PolicySnapshot | null {
  const parsed = PolicySnapshotSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The first tier whose threshold the lead time clears. */
export function selectTier(tiers: Tier[], hoursBefore: number): Tier {
  for (const tier of tiers) {
    if (hoursBefore >= tier.min_hours_before) return tier;
  }
  // Unreachable for a policy that passed TiersSchema — the last rung is 0 and
  // hoursBefore is clamped at 0 below. Kept as a throw rather than a silent
  // fallback so a policy that somehow bypassed validation fails loudly.
  throw new Error('policy has no tier for the requested lead time');
}

export interface RefundInput {
  /** The room's share of the booking total, in minor units. */
  roomMinor: bigint;
  /** The equipment line items' share, in minor units. */
  equipmentMinor: bigint;
  tiers: Tier[];
  startsAt: Date;
  /** When the cancellation is being made. Passed in, never read from a clock. */
  at: Date;
}

export interface RefundBreakdown {
  hours_before: number;
  tier: Tier;
  room_refund_minor: bigint;
  equipment_refund_minor: bigint;
  total_refund_minor: bigint;
}

/**
 * What a cancellation is worth.
 *
 * Two rounding decisions, both deliberate:
 *
 *   - The arithmetic is BigInt on minor units throughout. No amount in this
 *     system ever passes through a float, so 50% of 4501 is 2250, not
 *     2250.4999999999995.
 *   - Integer division truncates, which rounds DOWN, which favours the venue by
 *     at most one minor unit per component. The alternative rounds up and can
 *     refund more than was captured on a 100% tier if the two components are
 *     computed separately — and INV-5 would then be unable to reconcile the
 *     difference. Losing half a paisa is preferable to inventing one.
 *
 * `hours_before` is clamped at zero: cancelling after the booking has started
 * is a real thing a customer does, and a negative lead time must land on the
 * bottom rung rather than fail to match any tier.
 */
export function computeRefund(input: RefundInput): RefundBreakdown {
  const hoursBefore = Math.max(
    0,
    (input.startsAt.getTime() - input.at.getTime()) / 3_600_000,
  );

  const tier = selectTier(input.tiers, hoursBefore);

  const roomRefund = (input.roomMinor * BigInt(tier.room_refund_pct)) / 100n;
  const equipmentRefund = (input.equipmentMinor * BigInt(tier.equipment_refund_pct)) / 100n;

  return {
    hours_before: hoursBefore,
    tier,
    room_refund_minor: roomRefund,
    equipment_refund_minor: equipmentRefund,
    total_refund_minor: roomRefund + equipmentRefund,
  };
}
