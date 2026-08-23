import { Global, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { Pool } from 'pg';
import { createDb, createPool, type Db } from './client';
import { DB, ENV_TOKEN, PG_POOL } from '../app.tokens';
import { loadEnv, type Env } from '../config/env';
import { logger } from '../common/logger';

/**
 * Global so that repositories can inject DB without every feature module
 * re-importing it. The pool is closed on shutdown so `docker compose down` does
 * not leave connections hanging on a 200-connection limit shared by three
 * replicas.
 */
@Global()
@Module({
  providers: [
    { provide: ENV_TOKEN, useFactory: (): Env => loadEnv() },
    {
      provide: PG_POOL,
      inject: [ENV_TOKEN],
      useFactory: (env: Env): Pool => createPool(env.DATABASE_URL),
    },
    {
      provide: DB,
      inject: [PG_POOL],
      useFactory: (pool: Pool): Db => createDb(pool),
    },
  ],
  exports: [DB, PG_POOL, ENV_TOKEN],
})
export class DbModule implements OnApplicationShutdown {
  constructor() {}

  async onApplicationShutdown(): Promise<void> {
    logger.info('shutting down');
  }
}
