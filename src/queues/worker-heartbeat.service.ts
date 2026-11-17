import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { WorkerHost } from '@nestjs/bullmq';
import { randomUUID } from 'node:crypto';
import { RedisService } from '../redis/redis.service';
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TTL_SECONDS,
  heartbeatKey,
  WORKER_QUEUES,
} from './worker-status.service';

@Injectable()
export class WorkerHeartbeatService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(WorkerHeartbeatService.name);
  private readonly instanceId = randomUUID();
  private timer?: ReturnType<typeof setInterval>;
  private publishing = false;
  private stopped = false;

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly redis: RedisService,
  ) {}

  onApplicationBootstrap() {
    // Do not block bootstrap waiting for Redis: missing heartbeats mean not ready.
    void this.publish();
    this.timer = setInterval(() => void this.publish(), HEARTBEAT_INTERVAL_MS);
    this.timer.unref();
  }

  async publish() {
    if (this.publishing || this.stopped) return;
    this.publishing = true;
    try {
      const hosts = this.discovery
        .getProviders()
        .map((entry) => entry.instance)
        .filter((instance): instance is WorkerHost => instance instanceof WorkerHost);
      const results = await Promise.allSettled(
        hosts.map(async (host) => {
          const worker = host.worker;
          if (
            !WORKER_QUEUES.some((name) => name === worker.name) ||
            !worker.isRunning() ||
            worker.isPaused()
          )
            return;
          // Check the actual queue connection before claiming consumer readiness.
          await (await worker.client).get(worker.toKey('id'));
          if (this.stopped || !worker.isRunning() || worker.isPaused()) return;
          await this.redis.set(
            heartbeatKey(worker.name),
            {
              version: 1,
              kind: 'queue-worker',
              instanceId: this.instanceId,
              timestamp: Date.now(),
            },
            HEARTBEAT_TTL_SECONDS,
          );
        }),
      );
      if (results.some((result) => result.status === 'rejected')) throw new Error();
    } catch {
      this.logger.warn('Worker heartbeat unavailable; readiness will expire');
    } finally {
      this.publishing = false;
    }
  }

  onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    // Let leases expire; deleting a shared heartbeat could erase another worker.
  }
}
