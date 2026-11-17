/**
 * @file broadcast.processor.ts
 * @description BullMQ processor for broadcast campaigns.
 *
 * Handles jobs from the 'broadcast' queue. Each job contains a broadcast ID
 * and church ID. The processor delegates to BroadcastService to enqueue
 * individual messages to channel-specific outbound queues.
 *
 * @module queues/processors/broadcast.processor
 * @since 1.0.0
 */

import { Processor, OnWorkerEvent, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { BroadcastService } from '../../broadcast/broadcast.service';

@Processor('broadcast', { concurrency: 1 })
export class BroadcastProcessor extends WorkerHost {
  private readonly logger = new Logger(BroadcastProcessor.name);

  constructor(private readonly broadcastService: BroadcastService) {
    super();
  }

  /**
   * Processes a single broadcast job.
   *
   * Delegates to BroadcastService.processBroadcast() which enqueues
   * messages for each recipient via the appropriate outbound queue.
   *
   * @param job - BullMQ job containing broadcast ID and church ID
   */
  async process(job: Job<{ broadcastId: string; churchId: string }>): Promise<void> {
    const { broadcastId, churchId } = job.data;
    this.logger.log(`Processing broadcast ${broadcastId}`);

    await this.broadcastService.processBroadcast(broadcastId, churchId);

    this.logger.log(`Broadcast ${broadcastId} processed`);
  }

  /**
   * Handles job completion for observability logging.
   */
  @OnWorkerEvent('completed')
  onCompleted(job: Job): void {
    this.logger.log(`Broadcast job ${job.id} completed`);
  }

  /**
   * Handles job failure with logging.
   */
  @OnWorkerEvent('failed')
  onFailed(job: Job, _error: Error): void {
    this.logger.error(
      `Broadcast job ${job.id} failed (attempt ${job.attemptsMade}/${job.opts.attempts})`,
    );
  }
}
