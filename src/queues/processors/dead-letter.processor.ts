import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import * as Sentry from '@sentry/nestjs';
import { WORKER_QUEUES } from '../worker-status.service';

@Processor('dead-letter', { concurrency: 1 })
export class DeadLetterProcessor extends WorkerHost {
  private readonly logger = new Logger(DeadLetterProcessor.name);

  constructor() {
    super();
  }

  async process(
    job: Job<{ version?: number; queue?: string; attempts?: number; reviewOnly?: boolean }>,
  ): Promise<void> {
    const { queue, attempts, version } = job.data;
    if (
      version !== 1 ||
      !WORKER_QUEUES.some((name) => name === queue) ||
      !Number.isInteger(attempts) ||
      Number(attempts) < 0
    ) {
      this.logger.warn('Legacy or malformed failure record retained for operator review');
      return;
    }
    this.logger.warn(`Queue failure requires operator review: queue=${queue} attempts=${attempts}`);
    Sentry.captureMessage('Background queue job requires operator review', {
      level: 'error',
      tags: { queue: queue! },
      extra: { attempts },
    });
  }
}
