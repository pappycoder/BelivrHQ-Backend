/**
 * @file recurring-giving.processor.ts
 * @description BullMQ processor for automated recurring giving charges.
 *
 * Handles jobs from the 'recurring-giving' queue. Each job contains
 * a RecurringGiving record ID and church ID. The processor charges
 * the member's saved payment authorization via the configured gateway
 * (currently Paystack only). Failed charges increment the attempt counter.
 *
 * @module queues/processors/recurring-giving.processor
 * @since 1.0.0
 */

import { Processor, OnWorkerEvent, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { GivingService } from '../../giving/giving.service';

@Processor('recurring-giving', { concurrency: 1 })
export class RecurringGivingProcessor extends WorkerHost {
  private readonly logger = new Logger(RecurringGivingProcessor.name);

  constructor(private readonly givingService: GivingService) {
    super();
  }

  /**
   * Processes a single recurring giving charge job.
   *
   * Delegates to GivingService.processRecurringCharge() which handles
   * gateway charging, transaction creation, and schedule updates.
   *
   * @param job - BullMQ job containing RecurringGiving ID and church ID
   * @returns Whether the charge was successful
   */
  async process(job: Job<{ recurringGivingId: string; churchId: string }>): Promise<boolean> {
    const { recurringGivingId, churchId } = job.data;
    this.logger.log(`Processing recurring charge for ${recurringGivingId}`);

    const success = await this.givingService.processRecurringCharge(recurringGivingId, churchId);

    this.logger.log(`Recurring charge ${success ? 'succeeded' : 'failed'}: ${recurringGivingId}`);

    return success;
  }

  /**
   * Handles job failure with logging.
   *
   * @param job - The failed BullMQ job
   * @param error - The error that caused the failure
   */
  @OnWorkerEvent('failed')
  onFailed(job: Job, _error: Error): void {
    this.logger.error(
      `Recurring giving job ${job.id} failed (attempt ${job.attemptsMade}/${job.opts.attempts})`,
    );
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job, result: boolean): void {
    this.logger.log(
      `Recurring giving job ${job.id} completed: ${result ? 'success' : 'charge returned false'}`,
    );
  }
}
