'use server';

import { revalidatePath } from 'next/cache';
import { api, ApiError, ApiUnreachableError } from '@/lib/api';
import type { CancelResponse } from '@/lib/types';
import type { CancelState } from './cancel-state';

/**
 * Cancel a booking.
 *
 * The API does two things in one call and they commit in a deliberate order:
 * the state transition first, the money second. A refund that fails must not
 * leave the booking un-cancelled — the customer asked to cancel, the slot has
 * to be released to somebody else immediately, and an unsettled refund is a
 * discrepancy the reconciliation report surfaces rather than a reason to keep a
 * room held.
 *
 * So a `refund: null` in the response is not a failure and this action does not
 * treat it as one. It means there was nothing to give back: a hold that was
 * never paid for, or a booking already refunded. The screen says which.
 */

export async function cancelBooking(
  _previous: CancelState,
  formData: FormData,
): Promise<CancelState> {
  const id = String(formData.get('booking_id') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();

  if (!id) {
    return { status: 'error', message: 'No booking to cancel.', result: null };
  }

  try {
    const result = await api<CancelResponse>(`/bookings/${id}/cancel`, {
      method: 'POST',
      // The API defaults this to `customer.cancelled` and requires a non-empty
      // string when it is sent, so an untouched field must be omitted rather
      // than sent as ''. The reason lands in the audit trail either way.
      body: reason === '' ? {} : { reason },
    });

    revalidatePath('/bookings');
    revalidatePath(`/bookings/${id}`);
    return { status: 'done', message: null, result };
  } catch (err: unknown) {
    if (err instanceof ApiUnreachableError) {
      return { status: 'unreachable', message: err.message, result: null };
    }
    if (err instanceof ApiError) {
      revalidatePath(`/bookings/${id}`);
      return {
        // 409 is the state machine refusing an illegal transition — a booking
        // already cancelled, or one that was never cancellable. Information,
        // not a fault, and the API says which state it is actually in.
        status: err.status === 409 ? 'conflict' : 'error',
        message: err.message,
        result: null,
      };
    }
    throw err;
  }
}
