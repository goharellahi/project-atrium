import { log } from './logger';
import { isTransientRollback } from './pg-errors';

/**
 * Run a database transaction, retrying it if Postgres threw it away.
 *
 * ## Why this exists
 *
 * A deadlock is not a rejection. When two hold transactions contend the same
 * slot, Postgres may report the loser as `23P01` — the exclusion constraint
 * firing, which is a real answer meaning "taken" — or as `40P01`, a deadlock,
 * which means only that it could not order the two transactions and has aborted
 * one of them. The second case carries no information about whether the slot is
 * free, so returning a 409 for it would be a guess and returning a 500 (which
 * P4 did) reports the server as surprised by something entirely routine.
 *
 * The 200-request proof surfaced this exactly once in 400 requests. The
 * invariant held — one booking existed afterwards — but one caller got a 500.
 *
 * ## Why retrying is safe here
 *
 * A transaction aborted with a class-40 error has been rolled back completely:
 * no rows, no locks, no partial audit trail. There is nothing to undo and
 * nothing to be idempotent about, which is why this wrapper is deliberately
 * restricted to that one class of error. It must never be used to retry a
 * transaction that performed an external side effect, and it must never widen
 * to cover, say, a connection error — where the transaction's fate is unknown
 * and a retry could double an effect.
 *
 * ## The backoff
 *
 * Jittered, and the jitter is the point. Two transactions that deadlocked
 * against each other and then retried in lockstep would deadlock again in the
 * same way; a random component breaks the symmetry. The delays are tens of
 * milliseconds because the contention window is a single transaction's
 * lifetime, not a network round trip.
 */
export async function withTransientRetry<T>(
  operation: string,
  run: () => Promise<T>,
  attempts = 4,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await run();
    } catch (err: unknown) {
      if (!isTransientRollback(err)) throw err;

      lastError = err;

      const willRetry = attempt < attempts;

      // Says what it is about to do, not what it usually does. With
      // TRANSIENT_RETRY_ATTEMPTS=1 the earlier version logged "retrying" and
      // then did not, which made the baseline measurement in P5 harder to read
      // than it needed to be.
      log().warn(
        { operation, attempt, attempts, willRetry },
        willRetry
          ? 'transaction rolled back by postgres (deadlock or serialization failure), retrying'
          : 'transaction rolled back by postgres (deadlock or serialization failure), no attempts left',
      );

      if (willRetry) {
        /**
         * 2-6ms, 4-12ms, 8-24ms. Deliberately tiny, and measured.
         *
         * The first version of this backed off 10-30ms and up. Under the
         * 200-request proof that was catastrophic: a retrying request holds its
         * pool connection through another contended transaction, so a 4-attempt
         * budget multiplies the queue depth on a 20-connection pool, and the
         * run went from 1 stray 500 to 170 5xx — connection timeouts and nginx
         * 504s, not deadlocks. The retry has to be shorter than the transaction
         * it is retrying, or it becomes the load.
         *
         * Jittered because two transactions that deadlocked against each other
         * and then woke together would deadlock the same way.
         */
        const base = 2 * 2 ** (attempt - 1);
        await sleep(base + Math.random() * base * 2);
      }
    }
  }

  // Out of attempts. The caller decides what this means — for the hold path it
  // is a 409, because sustained deadlocking on one slot IS contention, and that
  // is the honest thing to tell a client. It is rethrown rather than translated
  // here so this helper stays free of HTTP semantics.
  log().error({ operation, attempts }, 'transaction still deadlocking after every retry');
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
