/**
 * @file sms-outbound.processor.ts
 * @description BullMQ processor for outbound SMS messages.
 *
 * Handles jobs from the 'sms-outbound' queue. Each job contains
 * a recipient phone number, message content, and church ID.
 * Delegates to MessagingDeliveryService for delivery via the Termii API.
 *
 * Retry policy: 3 attempts with exponential backoff (5s base).
 *
 * @module queues/processors/sms-outbound.processor
 * @since 1.0.0
 */

import { Processor, OnWorkerEvent, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { MessagingDeliveryService } from '../../communication/messaging-delivery.service';

@Processor('sms-outbound', { concurrency: 1 })
export class SmsOutboundProcessor extends WorkerHost {
  private readonly logger = new Logger(SmsOutboundProcessor.name);

  constructor(private readonly termiiService: MessagingDeliveryService) {
    super();
  }

  /**
   * Processes a single outbound SMS message job.
   *
   * Delegates to MessagingDeliveryService.sendSms() which handles Termii API
   * communication and persists the outbound message to the Message table.
   *
   * @param job - BullMQ job containing recipient phone, message content, and church ID
   * @returns Void — SMS sent via MessagingDeliveryService (Termii API)
   * @throws Error if Termii API is not configured or send fails (triggers retry)
   */
  async process(job: Job<{ to: string; message: string; churchId: string }>): Promise<void> {
    const { to, message, churchId } = job.data;
    this.logger.log(`Processing SMS (job ${job.id})`);

    await this.termiiService.sendSms(to, message, churchId);

    this.logger.log(`SMS sent (job ${job.id})`);
  }

  /**
   * Handles job completion for observability logging.
   *
   * @param job - The completed BullMQ job
   */
  @OnWorkerEvent('completed')
  onCompleted(job: Job): void {
    this.logger.log(`SMS job ${job.id} completed`);
  }

  /**
   * Handles job failure with attempt tracking.
   *
   * @param job - The failed BullMQ job
   * @param error - The error that caused the failure
   */
  @OnWorkerEvent('failed')
  onFailed(job: Job, _error: Error): void {
    this.logger.error(
      `SMS job ${job.id} failed (attempt ${job.attemptsMade}/${job.opts.attempts})`,
    );
  }
}
