import {
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { webhookDeliveries } from '../db/schema';
import { logger } from '../common/logger';
import type { Env } from '../config/env';
import { PaymentsService } from './payments.service';

/** Distinct from the hold sweeper's key; the two must not elect one another. */
const DRAIN_LOCK_KEY = 0x4154_5249_554d_02n;

const BATCH_SIZE = 100;

/**
 * The asynchronous half of the webhook path.
 *
 * ## Why the work is not done inline
 *
 * Paygate retries on timeout. A handler that confirmed a booking, resolved a
 * policy and possibly issued a refund before answering would sometimes take
 * long enough to be retried — manufacturing precisely the duplicate deliveries
 * the idempotency ledger exists to absorb, and doing it under load, when the
 * system is least able to cope. `ingest` therefore verifies, records, and
 * returns 200 in a couple of round trips to Postgres.
 *
 * ## Why the queue is a table and not an array
 *
 * `webhook_deliveries.processed_at IS NULL` is the queue. An in-memory queue
 * would lose everything a replica was holding when it died, and a captured
 * charge would then never be applied to its booking — money in the provider,
 * nothing in the system, INV-5 violated with no trace of why. A row survives
 * the crash and another replica picks it up on the next tick.
 *
 * This is also what makes the `unknown_charge` case safe: a delivery that
 * arrived before its own payments row simply stays unprocessed and is retried
 * here, which is the 25% race-on-response branch resolving itself.
 *
 * ## Two triggers, and both are needed
 *
 * The controller kicks `drainOne` immediately after recording a delivery, so
 * the common case has no added latency. The interval sweep is the safety net
 * for whatever that kick missed — a crash, a lost race, a delivery that landed
 * early. Election is by advisory lock, the same mechanism and for the same
 * reason as the hold sweeper: three identical replicas, no configuration.
 */
@Injectable()
export class WebhookProcessor implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly db: Db,
    private readonly payments: PaymentsService,
    private readonly env: Env,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      void this.tick();
    }, this.env.WEBHOOK_DRAIN_INTERVAL_SECONDS * 1000);
    this.timer.unref?.();

    logger.info(
      { intervalSeconds: this.env.WEBHOOK_DRAIN_INTERVAL_SECONDS },
      'webhook processor started',
    );
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Apply one delivery now, without waiting for the sweep.
   *
   * Errors are swallowed deliberately: the caller is a webhook handler that has
   * already returned 200, and the row is still marked unprocessed, so the sweep
   * will retry it. Rethrowing here would produce an unhandled rejection and
   * gain nothing.
   */
  kick(deliveryRowId: string): void {
    setImmediate(() => {
      void this.payments.applyDelivery(deliveryRowId).catch((err: unknown) => {
        logger.error(
          { deliveryRowId, err: err instanceof Error ? err.message : String(err) },
          'webhook.apply.failed',
        );
      });
    });
  }

  /** One sweep of the backlog. Public so a test can drive it deterministically. */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;

    try {
      const elected = await this.db.transaction(async (tx) => {
        const held = await tx.execute<{ locked: boolean }>(
          sql`SELECT pg_try_advisory_xact_lock(${DRAIN_LOCK_KEY.toString()}::bigint) AS locked`,
        );
        if (held.rows[0]?.locked !== true) return [];

        return tx
          .select({ id: webhookDeliveries.id })
          .from(webhookDeliveries)
          .where(
            and(
              isNull(webhookDeliveries.processedAt),
              eq(webhookDeliveries.signatureValid, true),
            ),
          )
          .orderBy(asc(webhookDeliveries.receivedAt))
          .limit(BATCH_SIZE);
      });

      let applied = 0;
      for (const row of elected) {
        try {
          await this.payments.applyDelivery(row.id);
          applied += 1;
        } catch (err: unknown) {
          // One poisoned delivery must not stall the queue behind it.
          logger.error(
            { deliveryRowId: row.id, err: err instanceof Error ? err.message : String(err) },
            'webhook.drain.item_failed',
          );
        }
      }

      if (applied > 0) {
        logger.info({ applied, replica: this.env.REPLICA_ID }, 'webhook backlog drained');
      }
      return applied;
    } catch (err: unknown) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'webhook drain tick failed',
      );
      return 0;
    } finally {
      this.running = false;
    }
  }
}
