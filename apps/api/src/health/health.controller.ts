import { Controller, Get, Inject } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  HealthIndicatorService,
} from '@nestjs/terminus';
import type { Pool } from 'pg';
import { PG_POOL } from '../app.tokens';
import { Public } from '../common/decorators/roles.decorator';

/**
 * A health endpoint that actually checks its dependencies.
 *
 * The P0 version reported liveness only and said so. This one runs a real query
 * against Postgres, because the failure this must catch is "the process is up
 * but its pool cannot reach the database" — which is precisely the state a
 * liveness-only check reports as healthy, and precisely when the load balancer
 * should stop sending traffic to this replica.
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly indicator: HealthIndicatorService,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  @Public()
  @Get()
  @HealthCheck()
  check() {
    return this.health.check([() => this.checkDatabase()]);
  }

  private async checkDatabase() {
    const check = this.indicator.check('postgres');
    const startedAt = Date.now();

    try {
      // SELECT 1 proves the pool can acquire a connection and the server
      // answers. It deliberately does not touch application tables: a health
      // check that depends on schema state fails for reasons that are not
      // health.
      await this.pool.query('SELECT 1');
      return check.up({ replica: process.env.REPLICA_ID ?? 'unknown', latencyMs: Date.now() - startedAt });
    } catch (err: unknown) {
      return check.down({
        replica: process.env.REPLICA_ID ?? 'unknown',
        latencyMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
