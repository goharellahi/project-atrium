import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const port = Number(process.env.API_PORT ?? 3001);
  await app.listen(port, '0.0.0.0');
  // Replica identity is logged so the concurrency proof can show that the 200
  // requests really did land across all three replicas, not one.
  process.stdout.write(
    `atrium-api replica=${process.env.REPLICA_ID ?? 'unknown'} listening on :${port}\n`,
  );
}

void bootstrap();
