import { NextResponse } from 'next/server';
import { api, ApiError, ApiUnreachableError } from '@/lib/api';
import type { Booking } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * The one route handler in this application, and the reason it exists.
 *
 * Everything else reaches the API from a server component or a server action.
 * The checkout screen cannot: after a charge is accepted the booking becomes
 * CONFIRMED when Paygate's webhook lands, which is asynchronous by design and,
 * for 5% of deliveries, deliberately parked for 60 to 90 seconds. Something in
 * the browser has to ask again — and it cannot ask the API directly, because
 * the API sets no CORS headers and the bearer token is httpOnly precisely so
 * that client JavaScript cannot reach it.
 *
 * So: one narrow endpoint, one booking, read only. It forwards the session's
 * own token, which means the API's tenant isolation decides what comes back
 * exactly as it would for any other call. This handler carries no authority of
 * its own and cannot be used to read a booking the session could not read.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;

  try {
    const booking = await api<Booking>(`/bookings/${id}`);
    return NextResponse.json(booking, { headers: { 'cache-control': 'no-store' } });
  } catch (err: unknown) {
    if (err instanceof ApiUnreachableError) {
      return NextResponse.json({ message: err.message }, { status: 504 });
    }
    if (err instanceof ApiError) {
      return NextResponse.json({ message: err.message }, { status: err.status });
    }
    throw err;
  }
}
