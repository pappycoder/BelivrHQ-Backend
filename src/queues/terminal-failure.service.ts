import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { DiscoveryService, ModuleRef } from '@nestjs/core';
import { InjectQueue, WorkerHost, getQueueToken } from '@nestjs/bullmq';
import { Cron } from '@nestjs/schedule';
import { Job, Queue, Worker } from 'bullmq';
import { createHash } from 'node:crypto';
import * as Sentry from '@sentry/nestjs';
import { PrismaService } from '../prisma/prisma.service';
import { WORKER_QUEUES } from './worker-status.service';
import { workersEnabled } from './workers-enabled';

@Injectable()
export class TerminalFailureService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(TerminalFailureService.name);
  private readonly removeListeners: (() => void)[] = [];
  private readonly cursors = new Map<string, number>();
  private readonly lastAlert = new Map<string, number>();
  private scanning = false;
  private stopped = false;
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly modules: ModuleRef,
    private readonly prisma: PrismaService,
    @InjectQueue('dead-letter') private readonly deadLetters: Queue,
  ) {}

  onApplicationBootstrap() {
    for (const provider of this.discovery.getProviders()) {
      if (!(provider.instance instanceof WorkerHost)) continue;
      const worker: Worker = provider.instance.worker;
      if (worker.name === 'dead-letter') continue;
      const failed = (job: Job | undefined) => {
        if (job)
          void this.record(worker.name, job).catch(() =>
            this.logger.warn('Failure review recording deferred'),
          );
      };
      const unavailable = () => {
        const now = Date.now();
        if (now - (this.lastAlert.get(worker.name) ?? 0) < 60000) return;
        this.lastAlert.set(worker.name, now);
        Sentry.captureMessage('Queue worker connection unavailable', {
          level: 'error',
          tags: { queue: worker.name },
        });
      };
      worker.on('failed', failed);
      worker.on('error', unavailable);
      this.removeListeners.push(() => {
        worker.off('failed', failed);
        worker.off('error', unavailable);
      });
    }
  }

  async record(queue: string, job: Job<unknown>): Promise<void> {
    if (
      this.stopped ||
      queue === 'dead-letter' ||
      !WORKER_QUEUES.some((name) => name === queue) ||
      !job.id
    )
      return;
    if ((await job.getState()) !== 'failed') return;
    const data =
      job.data && typeof job.data === 'object' ? (job.data as Record<string, unknown>) : {};
    let churchId = typeof data.churchId === 'string' ? data.churchId : undefined;
    if (queue === 'webhook-delivery' && typeof data.deliveryId === 'string') {
      const delivery = await this.prisma.webhookDelivery.findUnique({
        where: { id: data.deliveryId },
        select: { subscription_id: true },
      });
      const subscription = delivery
        ? await this.prisma.webhookSubscription.findUnique({
            where: { id: delivery.subscription_id },
            select: { church_id: true },
          })
        : null;
      churchId = subscription?.church_id;
    }
    const digest = createHash('sha256')
      .update(`${queue}\0${job.id}\0${job.attemptsMade}`)
      .digest('hex');
    await this.deadLetters.add(
      'review',
      {
        version: 1,
        queue,
        jobId: job.id,
        churchId,
        ...(queue === 'webhook-delivery' && typeof data.deliveryId === 'string'
          ? { deliveryId: data.deliveryId }
          : {}),
        attempts: job.attemptsMade,
        failedAt: Date.now(),
        reason: 'attempts_exhausted',
        reviewOnly: queue !== 'webhook-delivery',
      },
      {
        jobId: `failure-${digest}`,
        removeOnComplete: { age: 30 * 86400, count: 10000 },
        removeOnFail: { age: 30 * 86400, count: 10000 },
      },
    );
  }

  @Cron('*/30 * * * * *')
  async recoverMissedFailures() {
    if (!workersEnabled() || this.stopped || this.scanning) return;
    this.scanning = true;
    try {
      for (const name of WORKER_QUEUES.filter((queue) => queue !== 'dead-letter')) {
        const queue = this.modules.get<Queue>(getQueueToken(name), { strict: false });
        const start = this.cursors.get(name) ?? 0;
        const jobs = await queue.getFailed(start, start + 49);
        for (const job of jobs) await this.record(name, job);
        this.cursors.set(name, jobs.length === 50 ? start + 50 : 0);
      }
    } catch {
      this.logger.warn('Failure review recovery unavailable; it will retry');
    } finally {
      this.scanning = false;
    }
  }

  onModuleDestroy() {
    this.stopped = true;
    for (const remove of this.removeListeners) remove();
  }
}
