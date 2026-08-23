import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';

/**
 * Liveness only, for now.
 *
 * The brief (Tier 2) asks for "a health endpoint that actually checks its
 * dependencies". The database indicator is wired in P1, once the Drizzle pool
 * exists. Until then this reports process liveness and nothing more, and it
 * says so — a health check that claims more than it verifies is worse than none.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthCheckService) {}

  @Get()
  @HealthCheck()
  check() {
    return this.health.check([]);
  }
}
