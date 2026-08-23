import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { WebhookProcessor } from './webhook-processor.service';
import { PaygateClient } from './paygate.client';
import {
  PAYMENT_PROVIDER,
  UnimplementedPaymentProvider,
  type PaymentProvider,
} from './payment-provider';
import { StateMachineModule } from '../bookings/state-machine.module';
import { BookingStateMachine } from '../bookings/booking-state-machine.service';
import { DB, ENV_TOKEN } from '../app.tokens';
import type { Db } from '../db/client';
import type { Env } from '../config/env';
import { logger } from '../common/logger';

@Module({
  imports: [StateMachineModule],
  controllers: [PaymentsController],
  providers: [
    {
      /**
       * The real client when a provider is configured, the loud stub otherwise.
       *
       * Falling back rather than refusing to boot is deliberate: the API is
       * deployed on a free tier where Paygate is not always reachable, and a
       * booking core that cannot start because payments are unconfigured trades
       * a working half of the system for an unusable whole one. The stub throws
       * on the first call, so nothing silently no-ops.
       */
      provide: PAYMENT_PROVIDER,
      inject: [ENV_TOKEN],
      useFactory: (env: Env): PaymentProvider => {
        if (!env.PAYGATE_BASE_URL) {
          logger.warn('PAYGATE_BASE_URL is not set — payments will refuse every call');
          return new UnimplementedPaymentProvider();
        }
        return new PaygateClient(env);
      },
    },
    {
      provide: PaymentsService,
      inject: [DB, BookingStateMachine, ENV_TOKEN, PAYMENT_PROVIDER],
      useFactory: (db: Db, sm: BookingStateMachine, env: Env, provider: PaymentProvider) =>
        new PaymentsService(db, sm, env, provider),
    },
    {
      provide: WebhookProcessor,
      inject: [DB, PaymentsService, ENV_TOKEN],
      useFactory: (db: Db, payments: PaymentsService, env: Env) =>
        new WebhookProcessor(db, payments, env),
    },
  ],
  exports: [PaymentsService, PAYMENT_PROVIDER],
})
export class PaymentsModule {}
