import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { DbModule } from './db/db.module';
import { AuthModule } from './auth/auth.module';
import { HealthModule } from './health/health.module';
import { BookingsModule } from './bookings/bookings.module';
import { PaymentsModule } from './payments/payments.module';
import { PoliciesModule } from './policies/policies.module';
import { EquipmentModule } from './equipment/equipment.module';
import { AdminModule } from './admin/admin.module';
import { ReportsModule } from './reports/reports.module';
import { VenuesModule } from './venues/venues.module';
import { CorrelationMiddleware } from './common/context/correlation.middleware';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { VenueScopeGuard } from './common/guards/venue-scope.guard';

/**
 * Guards are registered globally and routes opt OUT with @Public(), rather than
 * opting in with @UseGuards(). A new endpoint is therefore authenticated by
 * default; forgetting the decorator fails closed instead of open.
 *
 * Order matters: JwtAuthGuard establishes the principal, RolesGuard checks the
 * coarse role, VenueScopeGuard puts the tenant scope where the repository layer
 * can find it.
 */
@Module({
  imports: [
    DbModule,
    AuthModule,
    HealthModule,
    BookingsModule,
    PaymentsModule,
    PoliciesModule,
    EquipmentModule,
    AdminModule,
    ReportsModule,
    VenuesModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: VenueScopeGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('*');
  }
}
