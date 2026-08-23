import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module';

// Scaffolding only. Feature modules (auth, venues, availability, bookings,
// payments, audit) are added in P2 onward — see PLAN.md.
@Module({
  imports: [HealthModule],
})
export class AppModule {}
