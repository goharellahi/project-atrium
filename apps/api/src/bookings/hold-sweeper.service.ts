import { Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import type { Env } from '../config/env';
import { logger } from '../common/logger';
import { BookingStateMachine } from './booking-state-machine.service';

/**
 * A Postgres advisory lock key. Any 64-bit integer; this one is arbitrary but
 * fixed, and must not collide with another advisory lock in the same database.
 */
const SWEEPER_LOCK_KEY = 0x4154_5249_554d_01n;

/** Never flip more than this in one pass, so a long outage cannot stall a tick. */
const BATCH_SIZE = 500;

/**
 * Background expiry of lapsed holds.
 *
 * ## Why a sweeper is needed at all
 *
 * `no_room_overlap` is a partial exclusion constraint predicated on
 * `status IN ('HELD','PENDING_PAYMENT','CONFIRMED')`. It cannot also say "and
 * not expired", because a constraint predicate must be immutable and `now()` is
 * not. So a hold that lapsed at 14:08 still blocks its slot at 14:09 unless
 * something changes its status.
 *
 * ## Why the sweeper alone is not enough
 *
 * It runs on an interval, so between ticks there is always a window in which a
 * lapsed hold is still blocking. The hold path therefore ALSO expires stale
 * holds for the room it is about to book, inside the same transaction as the
 * insert. Two halves of one mechanism: the sweeper bounds how long a lapsed row
 * survives platform-wide, the in-transaction expiry guarantees it is gone for
 * the room that needs it right now.
 *
 * ## Why an advisory lock and not an environment flag
 *
 * Three replicas run this identical image. A `SWEEPER_ENABLED=true` on one of
 * them would work until that replica is the one that crashes, at which point
 * nothing sweeps and nobody notices — the failure is silent and the symptom
 * (bookings rejected for slots that look free) appears somewhere else entirely.
 *
 * `pg_try_advisory_xact_lock` puts the election in the database instead: all
 * three replicas try every tick, exactly one wins, and if the winner dies the
 * next tick simply elects another. It is a TRANSACTION-scoped lock, not a
 * session one, which matters with a connection pool — a session lock would be
 * pinned to whichever pooled connection happened to take it and would leak if
 * that connection were recycled before the unlock.
 *
 * `try` rather than plain `pg_advisory_xact_lock`: a replica that loses the
 * election should do nothing and go back to sleep, not queue up behind the
 * winner and then run a redundant sweep the moment it commits.
 */
@Injectable()
export class HoldSweeper implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly db: Db,
    private readonly sm: BookingStateMachine,
    private readonly env: Env,
  ) {}

  onApplicationBootstrap(): void {
    const intervalMs = this.env.HOLD_SWEEPER_INTERVAL_SECONDS * 1000;

    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);

    // Do not hold the process open. Without this, `docker compose down` waits
    // for a timer that will never stop firing.
    this.timer.unref?.();

    logger.info(
      { intervalSeconds: this.env.HOLD_SWEEPER_INTERVAL_SECONDS },
      'hold sweeper started',
    );
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One sweep. Public so a test can drive it deterministically rather than
   * waiting on wall-clock time.
   */
  async tick(): Promise<number> {
    // A slow sweep must not overlap itself on the same replica. The advisory
    // lock prevents two REPLICAS colliding; this prevents one replica stacking
    // ticks on top of a pass that has not finished.
    if (this.running) return 0;
    this.running = true;

    try {
      return await this.db.transaction(async (tx) => {
        const held = await tx.execute<{ locked: boolean }>(
          sql`SELECT pg_try_advisory_xact_lock(${SWEEPER_LOCK_KEY.toString()}::bigint) AS locked`,
        );

        if (held.rows[0]?.locked !== true) return 0;

        const ids = await this.sm.expireStaleHolds(tx, BATCH_SIZE);

        if (ids.length > 0) {
          logger.info(
            { expired: ids.length, replica: this.env.REPLICA_ID },
            'hold sweeper expired lapsed holds',
          );
        }

        return ids.length;
      });
    } catch (err: unknown) {
      // A failed sweep must never take the replica down. The next tick retries,
      // and the in-transaction expiry in the hold path keeps correctness intact
      // in the meantime.
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'hold sweeper tick failed',
      );
      return 0;
    } finally {
      this.running = false;
    }
  }
}
