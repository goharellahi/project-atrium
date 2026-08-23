import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { DB } from '../app.tokens';
import type { Db } from '../db/client';

/**
 * `Db` is a plain value, not a class, so the service is built by a factory —
 * the same shape every other module here uses, and for the same reason: it
 * keeps the service free of Nest parameter metadata and therefore testable
 * against a bare handle.
 */
@Module({
  controllers: [ReportsController],
  providers: [
    {
      provide: ReportsService,
      inject: [DB],
      useFactory: (db: Db) => new ReportsService(db),
    },
  ],
  exports: [ReportsService],
})
export class ReportsModule {}
