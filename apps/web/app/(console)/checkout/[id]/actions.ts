'use server';

import { revalidatePath } from 'next/cache';
import { api, ApiError, ApiUnreachableError } from '@/lib/api';
import type { Booking, PaymentView } from '@/lib/types';
import type { ExtendState, PayState } from './pay-state';

/**
 * Pay, and extend the hold.
 *
 * ## Why a 502 is not an error state here
 *
 * Paygate runs with chaos on in production, as the brief requires. Roughly one
 * charge in ten comes back 502, and that branch is transient by construction.
 * The idempotency key is derived from the booking id and minted server-side —
 * the API refuses to accept one from a client precisely so that INV-3 does not
 * depend on the client getting it right — so pressing the button again is safe
 * and cannot produce a second charge.
 *
 * A UI that warned the customer off retrying would be wrong about the system it
 * is attached to. The 502 branch says retry, and means it.
 *
 * A 503 is the harder one: the provider did not answer at all, so the charge may
 * have been accepted and its webhook may already be in flight. Retrying is still
 * safe, for the same reason, and the copy says the charge may already have gone
 * through rather than claiming it did not.
 */

export async function payForBooking(
  _previous: PayState,
  formData: FormData,
): Promise<PayState> {
  const id = String(formData.get('booking_id') ?? '');
  if (!id) {
    return { outcome: 'error', message: 'No booking to pay for.', payment: null, detail: {} };
  }

  try {
    const payment = await api<PaymentView>(`/bookings/${id}/pay`, { method: 'POST' });
    revalidatePath(`/checkout/${id}`);
    return {
      outcome: payment.outcome === 'replayed' ? 'replayed' : 'accepted',
      message: null,
      payment,
      detail: {},
    };
  } catch (err: unknown) {
    if (err instanceof ApiUnreachableError) {
      return { outcome: 'no_answer', message: err.message, payment: null, detail: {} };
    }
    if (err instanceof ApiError) {
      // 502 — the provider rejected the request. The chaotic branch.
      // 503 — the provider never answered. The charge may nonetheless exist.
      if (err.status === 502 || err.status === 503) {
        return {
          outcome: err.status === 502 ? 'transient' : 'no_answer',
          message: err.message,
          payment: null,
          detail: err.body,
        };
      }
      if (err.status === 409) {
        revalidatePath(`/checkout/${id}`);
        return { outcome: 'conflict', message: err.message, payment: null, detail: err.body };
      }
      return { outcome: 'error', message: err.message, payment: null, detail: err.body };
    }
    throw err;
  }
}

/**
 * Re-arm the hold.
 *
 * `POST /bookings/:id/checkout` is documented in the API as "re-arm the hold on
 * reaching checkout", and the obvious implementation is to call it once when
 * this screen loads. It is deliberately not called that way. Re-arms are capped
 * — two, by default — and this screen polls; an automatic call on load would
 * spend a customer's extensions on renders they did not ask for, and would then
 * start returning 409 for a reason nobody could see.
 *
 * An explicit control instead, with the count and the cap printed beside it. The
 * 409 at the cap is the API's own sentence, shown as written.
 */
export async function extendHold(
  _previous: ExtendState,
  formData: FormData,
): Promise<ExtendState> {
  const id = String(formData.get('booking_id') ?? '');

  try {
    await api<Booking>(`/bookings/${id}/checkout`, { method: 'POST' });
    revalidatePath(`/checkout/${id}`);
    return { message: null, ok: true };
  } catch (err: unknown) {
    if (err instanceof ApiUnreachableError) return { message: err.message, ok: false };
    if (err instanceof ApiError) {
      revalidatePath(`/checkout/${id}`);
      return { message: err.message, ok: false };
    }
    throw err;
  }
}
