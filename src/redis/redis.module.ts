/**
 * @file redis.module.ts
 * @description Global module providing the Upstash Redis client.
 *
 * @module redis/redis.module
 * @since 1.0.0
 */

import { Module, Global } from '@nestjs/common';
import { RedisService } from './redis.service';
import { WorkerStatusService } from '../queues/worker-status.service';

@Global()
@Module({
  providers: [RedisService, WorkerStatusService],
  exports: [RedisService, WorkerStatusService],
})
export class RedisModule {}
