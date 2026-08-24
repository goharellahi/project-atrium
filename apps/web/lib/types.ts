/**
 * The API's wire shapes, transcribed from `apps/api/src`.
 *
 * Hand-written rather than generated. There is no shared package between the
 * two applications and inventing one for six screens would be a bigger change
 * than the screens; what matters is that these are the shapes the deployed API
 * actually returns, checked against it rather than inferred from the
 * controllers. Money is `string` everywhere it is `bigint` server-side —
 * `JSON.stringify` throws on a BigInt, so the API projects every amount to a
 * decimal string and this side must never parse one into a `number`.
 */

export type Role = 'PLATFORM_ADMIN' | 'VENUE_ADMIN' | 'VENUE_STAFF' | 'CUSTOMER';

export type BookingStatus =
  | 'DRAFT'
  | 'HELD'
  | 'PENDING_PAYMENT'
  | 'CONFIRMED'
  | 'COMPLETED'
  | 'EXPIRED'
  | 'FAILED'
  | 'CANCELLED'
  | 'REFUNDED';

export interface Me {
  id: string;
  email: string;
  role: Role;
  venueId: string | null;
  createdAt: string;
}

export interface SearchRoom {
  id: string;
  name: string;
  capacity: number;
  amenities: string[];
  hourly_rate_minor: string;
  min_duration_minutes: number;
  max_duration_minutes: number;
  venue_id: string;
  venue_name: string;
  city: string;
  timezone: string;
}

export interface SearchResult {
  data: SearchRoom[];
  page: number;
  page_size: number;
  total: number;
  filters_applied: string[];
  truncated_at_candidates?: number;
}

export interface FreeSlot {
  starts_at: string;
  ends_at: string;
}

export interface Availability {
  room_id: string;
  timezone: string;
  duration_minutes: number;
  granularity_minutes: number;
  turnaround_minutes: number;
  free_slots: FreeSlot[];
  busy: { from: string; to: string }[];
}

export interface HoldLineItem {
  equipment_type_id: string;
  name?: string;
  quantity: number;
  rate_minor: string;
}

export interface HoldResponse {
  id: string;
  status: BookingStatus;
  room_id: string;
  venue_id: string;
  starts_at: string;
  ends_at: string;
  expires_at: string | null;
  total_minor: string;
  currency: string;
  line_items: HoldLineItem[];
}

/** A policy tier, mirroring `TierSchema` in the API. */
export interface Tier {
  min_hours_before: number;
  room_refund_pct: number;
  equipment_refund_pct: number;
}

export interface PolicySnapshot {
  tiers: Tier[];
  policy_id: string;
  resolved_from: 'venue' | 'platform';
  snapshot_at: string;
}

export interface Booking {
  id: string;
  venue_id: string;
  room_id: string;
  user_id: string;
  status: BookingStatus;
  starts_at: string;
  ends_at: string;
  expires_at: string | null;
  rearm_count: number;
  policy_snapshot: PolicySnapshot | null;
  total_minor: string;
  currency: string;
  created_at: string;
  updated_at: string;
  line_items: HoldLineItem[];
}

export interface BookingRow {
  id: string;
  venue_id: string;
  room_id: string;
  room_name: string;
  user_id: string;
  starts_at: string;
  ends_at: string;
  status: BookingStatus;
  expires_at: string | null;
  rearm_count: number;
  total_minor: string;
  currency: string;
  created_at: string;
}

export interface BookingList {
  data: BookingRow[];
  page: number;
  page_size: number;
  total: number;
}

export interface PaymentView {
  payment_id: string;
  booking_id: string;
  charge_id: string | null;
  status: 'PENDING' | 'CAPTURED' | 'FAILED' | 'REFUNDED';
  amount_minor: string;
  refunded_minor: string;
  idempotency_key: string;
  outcome: 'accepted' | 'replayed';
}

export interface RefundBreakdown {
  hours_before: number;
  tier: Tier;
  room_refund_minor: string;
  equipment_refund_minor: string;
  total_refund_minor: string;
}

export interface CancelResponse {
  id: string;
  status: BookingStatus;
  refund: RefundBreakdown | null;
}

export interface EquipmentType {
  id: string;
  venue_id: string;
  name: string;
  units_owned: number;
  hourly_rate_minor: string;
}
