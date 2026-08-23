import { Module } from '@nestjs/common';
import { PoliciesController } from './policies.controller';
import { PoliciesService } from './policies.service';
import { PaymentsModule } from '../payments/payments.module';
import { PaymentsService } from '../payments/payments.service';
import { DB } from '../app.tokens';
import type { Db } from '../db/client';

/**
 * Policy resolution lives in PaymentsService because the payment path is what
 * consumes it — the snapshot is frozen at confirmation. This module is only the
 * read/write surface over the same rule, so there is one resolution order in
 * the codebase rather than two that can drift.
 */
@Module({
  imports: [PaymentsModule],
  controllers: [PoliciesController],
  providers: [
    {
      provide: PoliciesService,
      inject: [DB, PaymentsService],
      useFactory: (db: Db, payments: PaymentsService) => new PoliciesService(db, payments),
    },
  ],
})
export class PoliciesModule {}
