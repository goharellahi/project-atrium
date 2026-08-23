import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { BookingsService } from './bookings.service';
import {
  CancelSchema,
  HoldSchema,
  ListBookingsSchema,
  type CancelInput,
  type HoldInput,
  type ListBookingsQuery,
} from './bookings.schemas';
import { zodBody } from '../common/pipes/zod-validation.pipe';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PaymentsService } from '../payments/payments.service';
import type { AuthPrincipal } from '../common/context/request-context';

/**
 * Every route here is authenticated — the guards are global and nothing opts
 * out. Note what is absent: there is no `venue_id` path or body parameter
 * anywhere on this controller. Scope is derived from the token inside the
 * service (CLAUDE.md hard rule 4), so there is no value for a caller to tamper
 * with in the first place.
 */
@Controller('bookings')
export class BookingsController {
  constructor(
    private readonly bookings: BookingsService,
    private readonly payments: PaymentsService,
  ) {}

  /**
   * Create a hold.
   *
   * 201 on success. 422 if the request could never be valid. 409 if the room or
   * the equipment says no — which under concurrent load is the normal, expected
   * answer for every request but the first, not an error condition.
   */
  @Post('hold')
  @HttpCode(201)
  async hold(
    @Body(zodBody(HoldSchema)) body: HoldInput,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    const result = await this.bookings.hold(body, principal);

    return {
      id: result.booking.id,
      status: result.booking.status,
      room_id: result.booking.roomId,
      venue_id: result.booking.venueId,
      starts_at: result.booking.startsAt.toISOString(),
      ends_at: result.booking.endsAt.toISOString(),
      expires_at: result.booking.expiresAt?.toISOString() ?? null,
      total_minor: result.booking.totalMinor.toString(),
      currency: result.booking.currency,
      line_items: result.lineItems,
    };
  }

  /** Re-arm the hold on reaching checkout. See ARCHITECTURE.md Assumption 1. */
  @Post(':id/checkout')
  @HttpCode(200)
  async checkout(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    const booking = await this.bookings.checkout(id, principal);
    return {
      id: booking.id,
      status: booking.status,
      expires_at: booking.expiresAt?.toISOString() ?? null,
      rearm_count: booking.rearmCount,
      total_minor: booking.totalMinor.toString(),
      currency: booking.currency,
    };
  }

  @Post(':id/cancel')
  @HttpCode(200)
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(CancelSchema)) body: CancelInput,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    const booking = await this.bookings.cancel(id, body, principal);

    // The state transition commits first, then the money moves. Ordered this
    // way because a refund that fails must not leave the booking un-cancelled:
    // the customer asked to cancel, the slot must be released to someone else
    // immediately, and an unsettled refund is a discrepancy the reconciliation
    // report will surface rather than a reason to keep the room held.
    //
    // Idempotent by construction. The refund key is derived from the charge id,
    // so a double-clicked cancel — the second click getting a 409 from the
    // state machine and never reaching here — and a retry that does reach here
    // both converge on one refund at the provider.
    const refund = await this.payments.settleCancellation(booking.id);

    return {
      id: booking.id,
      status: booking.status,
      // Null when there is nothing to give back: a hold that was never paid
      // for, or a booking already refunded.
      refund,
    };
  }

  @Get()
  list(
    @Query(zodBody(ListBookingsSchema)) query: ListBookingsQuery,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.bookings.list(query, principal);
  }

  @Get(':id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.bookings.findOne(id, principal);
  }
}
