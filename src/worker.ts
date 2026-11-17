import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { installWorkerShutdownDeadline } from './queues/shutdown-deadline';

async function bootstrap() {
  process.env.ENABLE_QUEUE_WORKERS = 'true';
  const { env } = await import('./config/env.validation');
  const { initializeTelemetry } = await import('./config/telemetry');
  initializeTelemetry(env);
  // Load module metadata after opting into persistent processors.
  const { AppModule } = await import('./app.module');
  const app = await NestFactory.createApplicationContext(AppModule);
  installWorkerShutdownDeadline();
  app.enableShutdownHooks();
}
void bootstrap().catch(() => {
  console.error(
    'Worker startup failed. Check configuration and dependencies; values were not logged.',
  );
  process.exit(1);
});
