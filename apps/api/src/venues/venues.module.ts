import { Module } from '@nestjs/common';
import { VenuesAdminController } from './venues-admin.controller';
import { VenuesAdminService } from './venues-admin.service';
import { DB } from '../app.tokens';
import type { Db } from '../db/client';

@Module({
  controllers: [VenuesAdminController],
  providers: [
    {
      provide: VenuesAdminService,
      inject: [DB],
      useFactory: (db: Db) => new VenuesAdminService(db),
    },
  ],
})
export class VenuesModule {}
