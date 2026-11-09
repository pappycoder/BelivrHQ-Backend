/**
 * @file whatsapp-outbound.processor.ts
 * @description BullMQ processor for outbound WhatsApp messages.
 *
 * Handles jobs from the 'whatsapp-outbound' queue. Each job contains
 * a recipient phone number, message content, and church ID for tenant scoping.
 * Delegates to WhatsAppService to send via the Termii WhatsApp API.
 * If WhatsApp delivery fails after all retries and ENABLE_SMS_FALLBACK is true,
 * the processor falls back to SMS delivery via MessagingDeliveryService.
 *
 * Retry policy: 3 attempts with exponential backoff (5s base).
 * Failed jobs are retained for 7 days for debugging.
 *
 * @module queues/processors/whatsapp-outbound.processor
 * @since 1.0.0
 */

import { Processor, OnWorkerEvent, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';
import { MessagingDeliveryService } from '../../communication/messaging-delivery.service';

type WhatsAppSendJob = Job<{
  to: string;
  message: string;
  churchId: string;
  memberId?: string;
  messageId?: string;
}>;

type WhatsAppTemplateJob = Job<{
  to: string;
  templateName: string;
  language: string;
  variables?: Record<string, string>;
  churchId: string;
  memberId?: string;
  messageId?: string;
}>;

@Processor('whatsapp-outbound', { concurrency: 1 })
export class WhatsAppOutboundProcessor extends WorkerHost {
  private readonly logger = new Logger(WhatsAppOutboundProcessor.name);

  constructor(
    private readonly whatsappService: WhatsAppService,
    private readonly config: ConfigService,
    private readonly termiiService: MessagingDeliveryService,
  ) {
    super();
  }

  /**
   * Routes each job to its handler by job name.
   *
   * @param job - The BullMQ job pulled from the queue
   */
  async process(job: Job): Promise<void> {
    switch (job.name) {
      case 'send':
        return this.handleSend(job as WhatsAppSendJob);
      case 'send-template':
        return this.handleSendTemplate(job as WhatsAppTemplateJob);
      default:
        throw new Error(`Unknown job name: ${job.name}`);
    }
  }

  /**
   * Processes a single outbound WhatsApp message job.
   *
   * Delegates to WhatsAppService.sendMessage() which handles the Termii
   * WhatsApp API communication and persists the outbound message to the
   * Message table.
   * On success, stores the created message ID in the job data for fallback linking.
   *
   * @param job - BullMQ job containing recipient phone, message content, and church ID
   * @returns Void — message sent via WhatsAppService (Termii WhatsApp API)
   * @throws Error if WhatsApp API is not configured or send fails (triggers retry)
   */
  private async handleSend(job: WhatsAppSendJob): Promise<void> {
    const { to, message, churchId, memberId } = job.data;
    this.logger.log(`Processing WhatsApp message to ${to} (job ${job.id})`);

    const result = await this.whatsappService.sendMessage(to, message, churchId, memberId);

    // Store original WhatsApp message ID for fallback linking
    if (result.messageId) {
      await job.updateData({ ...job.data, messageId: result.messageId });
    }

    this.logger.log(`WhatsApp message sent to ${to} (job ${job.id})`);
  }

  /**
   * Processes a single outbound WhatsApp template message job.
   *
   * Delegates to WhatsAppService.sendTemplateMessage(). On success, stores
   * the created message ID in the job data for fallback linking.
   */
  private async handleSendTemplate(job: WhatsAppTemplateJob): Promise<void> {
    const { to, templateName, language, variables, churchId, memberId } = job.data;
    this.logger.log(`Processing WhatsApp template message to ${to} (job ${job.id})`);

    const result = await this.whatsappService.sendTemplateMessage(
      to,
      templateName,
      language,
      variables,
      churchId,
      memberId,
    );

    if (result.messageId) {
      await job.updateData({ ...job.data, messageId: result.messageId });
    }

    this.logger.log(`WhatsApp template message sent to ${to} (job ${job.id})`);
  }

  /**
   * Handles job completion for observability logging.
   *
   * @param job - The completed BullMQ job
   */
  @OnWorkerEvent('completed')
  onCompleted(job: Job): void {
    this.logger.log(`WhatsApp job ${job.id} completed → ${job.data.to}`);
  }

  /**
   * Handles job failure with attempt tracking and optional SMS fallback.
   *
   * Logs the failure reason and current attempt number. After 3 failed attempts,
   * if ENABLE_SMS_FALLBACK is enabled, the message is retried via Termii SMS.
   *
   * @param job - The failed BullMQ job
   * @param error - The error that caused the failure
   */
  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<{
      to: string;
      message: string;
      churchId: string;
      memberId?: string;
      messageId?: string;
    }>,
    error: Error,
  ): Promise<void> {
    this.logger.error(
      `WhatsApp job ${job.id} failed (attempt ${job.attemptsMade}/${job.opts.attempts}): ${error.message}`,
    );

    const maxAttempts = job.opts.attempts ?? 1;
    const isFinalAttempt = job.attemptsMade >= maxAttempts;
    const fallback = this.config.get<boolean | string>('ENABLE_SMS_FALLBACK', false);
    const fallbackEnabled = fallback === true || fallback === 'true';

    if (isFinalAttempt && fallbackEnabled) {
      const { to, message, churchId, messageId } = job.data;

      // Template sends carry no plain-text body, so an SMS fallback can't be
      // composed from them — log and skip to avoid sending "undefined".
      if (!message) {
        this.logger.warn(
          `SMS fallback skipped for template WhatsApp job ${job.id} → ${to} (no plain-text body)`,
        );
        return;
      }

      this.logger.log(`Falling back to SMS for WhatsApp job ${job.id} → ${to}`);

      try {
        await this.termiiService.sendSms(to, message, churchId, messageId);
        this.logger.log(`SMS fallback sent for WhatsApp job ${job.id} → ${to}`);
      } catch (smsError) {
        this.logger.error(
          `SMS fallback failed for WhatsApp job ${job.id}: ${smsError instanceof Error ? smsError.message : String(smsError)}`,
        );
      }
    }
  }
}
