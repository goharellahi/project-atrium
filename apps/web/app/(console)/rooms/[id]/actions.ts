'use server';

import { redirect } from 'next/navigation';
import { api, ApiError, ApiUnreachableError } from '@/lib/api';
import type { HoldResponse } from '@/lib/types';
import type { HoldState } from './hold-state';

/**
 * Create a hold.
 *
 * The three answers this can give are all first-class, and the reason they are
 * separated here rather than collapsed into `error: string` is that they are
 * three different things to say to a person:
 *
 *   409 — somebody else took the slot while this one was being decided on, or
 *         the room is contended. Under concurrency that is the expected answer
 *         for every request but the first. It is information: the slot list is
 *         stale, refresh it. Not a failure.
 *   422 — the request could never have been valid. Outside operating hours, off
 *         the 30-minute grid, a duration the room does not take. The API names
 *         the field and the console prints the API's words.
 *   503 — the API itself did not answer. Nothing was created.
 */

export async function createHold(
  _previous: HoldState,
  formData: FormData,
): Promise<HoldState> {
  const roomId = String(formData.get('room_id') ?? '');
  const startsAt = String(formData.get('starts_at') ?? '');
  const endsAt = String(formData.get('ends_at') ?? '');

  if (!roomId || !startsAt || !endsAt) {
    return {
      status: 'invalid',
      message: 'Pick a slot before holding it.',
      issues: [],
      detail: {},
    };
  }

  // `line_items` arrives as one JSON string rather than as repeated form
  // fields. The API rejects a duplicated equipment_type_id with a 422 and the
  // picker already collapses duplicates, so shipping the array the picker
  // actually holds keeps one representation instead of encoding and reparsing
  // a second one out of form keys.
  let lineItems: { equipment_type_id: string; quantity: number }[] = [];
  const rawItems = formData.get('line_items');
  if (typeof rawItems === 'string' && rawItems.trim() !== '') {
    try {
      lineItems = JSON.parse(rawItems) as typeof lineItems;
    } catch {
      return {
        status: 'invalid',
        message: 'The equipment selection could not be read. Remove the line items and retry.',
        issues: [],
        detail: {},
      };
    }
  }

  let hold: HoldResponse;
  try {
    hold = await api<HoldResponse>('/bookings/hold', {
      method: 'POST',
      body: {
        room_id: roomId,
        starts_at: startsAt,
        ends_at: endsAt,
        ...(lineItems.length > 0 ? { line_items: lineItems } : {}),
      },
    });
  } catch (err: unknown) {
    if (err instanceof ApiUnreachableError) {
      return {
        status: 'unreachable',
        message: `${err.message} Nothing was held — no request reached the booking path.`,
        issues: [],
        detail: {},
      };
    }
    if (err instanceof ApiError) {
      return {
        status:
          err.status === 409
            ? 'conflict'
            : err.status === 422
              ? 'invalid'
              : err.status === 401
                ? 'error'
                : 'error',
        message: err.message,
        issues: err.issues,
        detail: err.body,
      };
    }
    throw err;
  }

  // Outside the try: `redirect` throws by design.
  redirect(`/checkout/${hold.id}`);
}
