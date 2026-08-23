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

  // Bind dual-stack, not '0.0.0.0'.
  //
  // Docker's embedded DNS returns AAAA records for the api1/api2/api3 service
  // names, so nginx will happily connect over IPv6. A server bound only to
  // 0.0.0.0 refuses those connections, which surfaces as intermittent 502s that
  // look like the application crashing under load. Under the concurrency proof
  // that would be indistinguishable from a real failure.
  //
  // '::' accepts IPv4-mapped connections too, so the IPv4 healthcheck on
  // 127.0.0.1 still works.
  await app.listen(env.API_PORT, '::');

  logger.info(
    { port: env.API_PORT, replica: env.REPLICA_ID, nodeEnv: env.NODE_ENV },
    'atrium-api listening',
  );
}

void bootstrap().catch((err: unknown) => {
  logger.fatal({ err: err instanceof Error ? err.message : String(err) }, 'boot failed');
  process.exit(1);
});
