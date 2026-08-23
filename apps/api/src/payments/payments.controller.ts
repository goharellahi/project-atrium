import {
  Controller,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import type { Request } from 'express';
import { PaymentsService } from './payments.service';
import { WebhookProcessor } from './webhook-processor.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/roles.decorator';
import type { AuthPrincipal } from '../common/context/request-context';

/**
 * The payment surface: one authenticated route out, one unauthenticated route
 * in.
 *
 * There is no `venue_id` anywhere on it. The pay route derives scope from the
 * token like every other booking route; the webhook route has no principal at
 * all and is authenticated by HMAC over the raw body instead.
 */
@Controller()
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly processor: WebhookProcessor,
  ) {}

  /**
   * Pay for a held booking.
   *
   * No idempotency key is accepted from the client, deliberately. The key is
   * derived from the booking id, so a client that retries — with a fresh key, a
   * stale key, or no key at all — still cannot be charged twice. Trusting a
   * client-supplied key would make INV-3 depend on the client getting it right.
   */
  @Post('bookings/:id/pay')
  @HttpCode(200)
  pay(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.payments.pay(id, principal);
  }

  /**
   * Paygate's webhook.
   *
   * `@Public()` because there is no bearer token here: the signature IS the
   * authentication. The body is read from `req.rawBody`, the exact bytes the
   * provider signed — NestJS parses and discards the raw body by default, and
   * verifying an HMAC against a re-serialised object fails intermittently for
   * reasons (key order, number formatting) that look nothing like a signature
   * problem. `rawBody: true` in main.ts is what makes this available.
   *
   * The handler returns as soon as the delivery is recorded. Applying it is the
   * processor's job — see WebhookProcessor for why that separation is load
   * bearing rather than tidy.
   */
  @Public()
  @Post('webhooks/paygate')
  @HttpCode(200)
  async webhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-paygate-signature') signature: string | undefined,
    @Headers('x-paygate-delivery') deliveryId: string | undefined,
  ) {
    const raw = req.rawBody ?? Buffer.alloc(0);

    // Throws 401 on a bad signature, after recording it. Never processed.
    const result = await this.payments.ingest(raw, signature, deliveryId);

    if (result.deliveryRowId) this.processor.kick(result.deliveryRowId);

    return { received: true, status: result.status };
  }
}
