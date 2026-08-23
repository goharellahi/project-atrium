import {
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client';
import { webhookDeliveries } from '../db/schema';
import { logger } from '../common/logger';
import type { Env } from '../config/env';
import { PaymentsService } from './payments.service';

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
 * The controller kicks the delivery immediately after recording it, so the
 * common case has no added latency. The interval sweep is the safety net for
 * whatever that kick missed — a crash, a lost race, a delivery that landed
 * before the payments row it belongs to.
 *
 * All three replicas drain. There is no election, and `tick` explains why the
 * one P4 had was doing nothing.
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
      /**
       * No advisory-lock election here, and its removal is deliberate.
       *
       * P4 wrapped this SELECT in `pg_try_advisory_xact_lock`, copying the hold
       * sweeper. It did not do what the comment claimed. The lock is
       * transaction-scoped and the transaction only ran a SELECT, so it was
       * released within a millisecond — and since all three replicas tick on
       * the same interval, all three simply won the election in turn and then
       * processed the identical batch. The P5 logs show exactly that: the same
       * six delivery ids failing on api1, api2 and api3 within 20ms.
       *
       * Electing a single drainer properly would need the lock held across the
       * whole drain, which means either a session-scoped lock (unsafe behind a
       * connection pool — it pins to whichever pooled connection took it) or a
       * claim column. Neither is worth it, because the guard that actually
       * matters is one layer down: `applyInTransaction` takes `FOR UPDATE` on
       * the delivery row and returns immediately if `processed_at` is set. A
       * second replica therefore blocks, sees the work is done, and stops.
       *
       * So the cost of concurrent drainers is a little duplicated reading, not
       * duplicated effect, and this now says so instead of implying a guarantee
       * it never provided.
       */
      const elected = await this.db
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

      /**
       * The pull half of the payment channel.
       *
       * Draining the queue only ever applies messages that arrived. A delivery
       * whose signature Paygate corrupted is rejected and never resent, so the
       * settlement it carried is lost for good — the P5 soak lost six refunds
       * that way, all of which the provider had genuinely completed. This asks
       * the provider directly about anything accepted-but-unsettled.
       *
       * The delay before asking is deliberate: a refund accepted two seconds
       * ago is not late, it is in flight, and polling it would be asking the
       * provider to confirm what its own webhook is about to say.
       */
      const [charges, refunds] = [
        await this.payments.settleAcceptedCharges(this.env.CHARGE_POLL_AFTER_SECONDS),
        await this.payments.settleAcceptedRefunds(this.env.REFUND_POLL_AFTER_SECONDS),
      ];

      if (charges > 0 || refunds > 0) {
        logger.warn(
          { charges, refunds, replica: this.env.REPLICA_ID },
          'settled by polling the provider — these webhooks never arrived',
        );
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
