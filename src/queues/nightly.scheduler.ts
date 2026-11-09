/**
 * @file nightly.scheduler.ts
 * @description Cron scheduler that triggers nightly maintenance jobs.
 *
 * Runs at 2:00 AM daily (Africa/Lagos timezone) and dispatches a job
 * to the nightly-jobs queue for each church. The actual work is done
 * by NightlyJobsProcessor.
 *
 * @module queues/nightly.scheduler
 * @since 1.0.0
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class NightlyScheduler {
  private readonly logger = new Logger(NightlyScheduler.name);

  constructor(
    @InjectQueue('nightly-jobs') private readonly nightlyQueue: Queue,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Triggers nightly maintenance jobs for all active churches.
   * Runs at 2:00 AM daily in Africa/Lagos timezone.
   */
  @Cron('0 2 * * *', { timeZone: 'Africa/Lagos' })
  async handleNightlyTrigger(): Promise<void> {
    this.logger.log('Nightly cron triggered: dispatching jobs for all churches');

    const churches = await this.prisma.church.findMany({
      select: { id: true },
    });

    let dispatched = 0;

    for (const church of churches) {
      try {
        await this.nightlyQueue.add(
          'run',
          { churchId: church.id },
          {
            jobId: `nightly-${church.id}-${new Date().toISOString().split('T')[0]}`,
          },
        );
        dispatched++;
      } catch (err) {
        this.logger.error(
          `Failed to dispatch nightly job for church ${church.id}: ${(err as Error).message}`,
        );
      }
    }

    this.logger.log(`Nightly cron complete: dispatched ${dispatched}/${churches.length} jobs`);
  }
}
