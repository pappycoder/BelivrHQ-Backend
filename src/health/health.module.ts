/**
 * @file health.module.ts
 * @description Module providing health check endpoint.
 *
 * @module health/health.module
 * @since 1.0.0
 */

import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { QueuesModule } from '../queues/queues.module';
import { WebhooksModule } from '../webhooks/webhooks.module';

@Module({
  imports: [QueuesModule, WebhooksModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
