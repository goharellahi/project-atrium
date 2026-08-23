import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { logger } from './common/logger';
import { loadEnv } from './config/env';

async function bootstrap(): Promise<void> {
  // Validated before Nest starts, so a bad environment is a failed boot rather
  // than a runtime surprise on the first request.
  const env = loadEnv();

  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.enableShutdownHooks();

  await app.listen(env.API_PORT, '0.0.0.0');

  logger.info(
    { port: env.API_PORT, replica: env.REPLICA_ID, nodeEnv: env.NODE_ENV },
    'atrium-api listening',
  );
}

void bootstrap().catch((err: unknown) => {
  logger.fatal({ err: err instanceof Error ? err.message : String(err) }, 'boot failed');
  process.exit(1);
});
