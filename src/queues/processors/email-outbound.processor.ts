/**
 * @file email-outbound.processor.ts
 * @description BullMQ processor for outbound emails.
 *
 * Handles jobs from the 'email-outbound' queue. Each job contains
 * a recipient email, subject, HTML body, and church ID.
 * Delegates to EmailDeliveryService for delivery via the Resend API.
 *
 * Retry policy: 3 attempts with exponential backoff (5s base).
 *
 * @module queues/processors/email-outbound.processor
 * @since 1.0.0
 */

import { Processor, OnWorkerEvent, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { EmailDeliveryService } from '../../communication/email-delivery.service';

@Processor('email-outbound', { concurrency: 1 })
export class EmailOutboundProcessor extends WorkerHost {
  private readonly logger = new Logger(EmailOutboundProcessor.name);

  constructor(private readonly resendService: EmailDeliveryService) {
    super();
  }

  /**
   * Processes a single outbound email job.
   *
   * Delegates to EmailDeliveryService.sendEmail() which handles Resend API
   * communication and persists the outbound message to the Message table.
   *
   * @param job - BullMQ job containing recipient email, subject, HTML body, and church ID
   * @returns Void — email sent via EmailDeliveryService (Resend API)
   * @throws Error if Resend API is not configured or send fails (triggers retry)
   */
  async process(
    job: Job<{ to: string; subject: string; html: string; churchId: string }>,
  ): Promise<void> {
    const { to, subject, html, churchId } = job.data;
    this.logger.log(`Processing email (job ${job.id})`);

    await this.resendService.sendEmail(to, subject, html, churchId);

    this.logger.log(`Email sent (job ${job.id})`);
  }

  /**
   * Handles job completion for observability logging.
   *
   * @param job - The completed BullMQ job
   */
  @OnWorkerEvent('completed')
  onCompleted(job: Job): void {
    this.logger.log(`Email job ${job.id} completed`);
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
      `Email job ${job.id} failed (attempt ${job.attemptsMade}/${job.opts.attempts})`,
    );
  }
}
