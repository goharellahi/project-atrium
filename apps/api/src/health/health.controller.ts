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
    return this.health.check([() => this.checkDatabase(), () => this.checkPolicy()]);
  }

  /**
   * Is the platform default cancellation policy present?
   *
   * Reported as a DETAIL of an otherwise-up indicator rather than as a failure,
   * and the choice is deliberate. Without that row no booking can be confirmed,
   * so failing the check is tempting — but nginx would then pull all three
   * replicas and the whole API would answer 502, including `/auth/login` and
   * the reconciliation report an operator needs to diagnose it. A self-inflicted
   * outage makes the problem harder to see, not easier.
   *
   * So it surfaces in three places instead: here, in the boot log, and as an
   * explicit 503 naming the remedy on the two paths that actually need it.
   *
   * P4 shipped with none of those and the row silently absent on every seeded
   * database. This exists because of that.
   */
  private async checkPolicy() {
    const check = this.indicator.check('cancellation_policy');

    try {
      const result = await this.pool.query(
        'SELECT 1 FROM cancellation_policies WHERE venue_id IS NULL LIMIT 1',
      );
      const present = result.rowCount === 1;

      return check.up({
        platform_default_present: present,
        ...(present
          ? {}
          : {
              warning:
                'MISSING — bookings cannot be confirmed. Migration 0003 inserts it; re-run migrations or re-seed.',
            }),
      });
    } catch (err: unknown) {
      return check.up({
        platform_default_present: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
