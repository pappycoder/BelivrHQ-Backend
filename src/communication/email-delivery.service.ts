/**
 * @file email-delivery.service.ts
 * @description Church email delivery through provider accounts; organization email through Resend.
 *
 * Provides a sendEmail() method that sends HTML emails via Resend and
 * logs church-owned outbound messages to the Prisma Message model with
 * channel: 'email'. This ensures all communications are tracked
 * in the unified message history.
 *
 * Church sends require an enabled provider account. Organization authentication
 * emails have no tenant Message row.
 *
 * @module communication/email-delivery.service
 * @since 1.0.0
 */

import { IntegrationAccountsService } from '../integrations/integration-accounts.service';
import { ConfigService } from '@nestjs/config';
import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { INTEGRATION_ALERT_SERVICE_TOKEN } from '../notifications/notification-tokens';

interface EmailAttachment {
  filename: string;
  content: Buffer;
}

@Injectable()
export class EmailDeliveryService {
  private readonly logger = new Logger(EmailDeliveryService.name);
  private alertService?: {
    notify(
      churchId: string,
      integration: string,
      title: string,
      message: string,
      data?: Record<string, unknown>,
    ): Promise<void>;
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly moduleRef: ModuleRef,
    private readonly config: ConfigService,
    private readonly accounts: IntegrationAccountsService,
  ) {}

  /**
   * Lazily resolves the integration alert service and raises a bell alert to
   * the church's admins. Failures are swallowed so alerting can never break
   * the underlying email send.
   */
  private async notifyFailure(churchId: string, subject: string, message: string): Promise<void> {
    try {
      this.alertService ??= this.moduleRef.get(INTEGRATION_ALERT_SERVICE_TOKEN, {
        strict: false,
      });
      if (!this.alertService) return;
      await this.alertService.notify(
        churchId,
        'resend',
        'Resend email delivery failed',
        `${subject}. ${message}`,
      );
    } catch (err) {
      this.logger.warn(`Resend failure alert skipped: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Sends an HTML email via Resend and logs it to the Message table.
   *
   * @param to - Recipient email address
   * @param subject - Email subject line
   * @param html - HTML email body
   * @param churchId - Church ID for tenant scoping and message logging
   * @returns The created Message record ID
   * @throws InternalServerErrorException if Resend API is not configured or send fails
   */
  async sendEmail(
    to: string,
    subject: string,
    html: string,
    churchId: string,
    attachment?: EmailAttachment,
    organizationOptions?: { text?: string; from?: string; idempotencyKey?: string },
  ): Promise<string> {
    if (churchId) {
      const integration = await this.accounts.resolve(churchId, 'email');
      if (!integration)
        throw new InternalServerErrorException('Configure a church email account first');
      const id = await this.accounts.deliver(integration, 'email', {
        ...integration.settings,
        from: integration.settings.from,
        to,
        subject,
        text: organizationOptions?.text ?? subject,
        ...(organizationOptions?.text ? { plainText: organizationOptions.text } : {}),
        html,
        attachment,
      });
      const message = await this.prisma.message.create({
        data: {
          church_id: churchId,
          phone: to,
          direction: 'outbound',
          channel: 'email',
          content: subject,
          status: 'sent',
          metadata: {
            provider: integration.provider,
            provider_id: id,
            integration_account_id: integration.accountId,
          },
        },
      });
      return message.id;
    }
    const apiKey = this.config.get<string>('RESEND_API_KEY', '');
    const fromAddress = this.config.get<string>('RESEND_FROM', 'noreply@churchos.app');

    if (!apiKey) {
      await this.notifyFailure(churchId, 'Email not delivered', 'Resend API not configured.');
      throw new InternalServerErrorException('Resend API not configured');
    }

    try {
      const payload: Record<string, unknown> = {
        from: organizationOptions?.from ?? fromAddress,
        to: [to],
        subject,
        html,
        ...(organizationOptions?.text ? { text: organizationOptions.text } : {}),
      };

      if (attachment) {
        payload.attachments = [
          {
            filename: attachment.filename,
            content: attachment.content.toString('base64'),
          },
        ];
      }

      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          ...(organizationOptions?.idempotencyKey
            ? { 'Idempotency-Key': organizationOptions.idempotencyKey }
            : {}),
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        this.logger.error(`Resend API error: ${response.status}`);
        await this.notifyFailure(churchId, 'Email not delivered', `HTTP ${response.status}.`);
        throw new InternalServerErrorException('Failed to send email');
      }

      const result = (await response.json()) as { id: string };

      if (!result.id)
        throw new InternalServerErrorException('Resend did not confirm message acceptance');
      // Organization authentication messages have no church-owned log row.
      return result.id;
    } catch (err) {
      if (err instanceof InternalServerErrorException) throw err;
      this.logger.error(`Email send error: provider request failed`);
      await this.notifyFailure(churchId, 'Email not delivered', 'Provider request failed.');
      throw new InternalServerErrorException('Failed to send email');
    }
  }
}
