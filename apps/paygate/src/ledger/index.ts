import type { PaygateConfig } from '../config.js';
import { MemoryLedger } from './memory.js';
import { PostgresLedger } from './postgres.js';
import type { Ledger } from './ledger.js';

export * from './ledger.js';
export { MemoryLedger } from './memory.js';
export { PostgresLedger } from './postgres.js';

/**
 * Pick a ledger from the configuration.
 *
 * Postgres is the default and memory is the opt-out, which is the reverse of
 * where this started. `config.ts` refuses `postgres` without a database URL
 * rather than falling back — a provider that silently forgets is precisely the
 * failure this replaced, and choosing it by accident is how it would come back.
 */
export function createLedger(cfg: PaygateConfig, log: (msg: string) => void): Ledger {
  if (cfg.store === 'memory') return new MemoryLedger();
  return new PostgresLedger(cfg.databaseUrl!, log);
}
