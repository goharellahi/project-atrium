import { Module } from '@nestjs/common';
import { ReconciliationController } from './reconciliation.controller';
import { ReconciliationService } from './reconciliation.service';
import { DB } from '../app.tokens';
import type { Db } from '../db/client';

@Module({
  controllers: [ReconciliationController],
  providers: [
    {
      provide: ReconciliationService,
      inject: [DB],
      useFactory: (db: Db) => new ReconciliationService(db),
    },
  ],
})
export class AdminModule {}
