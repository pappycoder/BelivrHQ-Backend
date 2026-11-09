import { churchEntitlements } from '../billing/entitlements';
/**
 * @file webhook-delivery.processor.ts
 * @description BullMQ processor for outbound webhook delivery.
 *
 * Signs payloads with HMAC-SHA256 and delivers via HTTP POST.
 * Updates WebhookDelivery record with result.
 *
 * @module webhooks/webhook-delivery.processor
 * @since 1.0.0
 */

import { Processor, OnWorkerEvent, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { sendWebhook } from './safe-webhook-request';
import { createHmac } from 'crypto';

interface WebhookDeliveryJob {
  deliveryId: string;
  subscriptionId: string;
  url: string;
  secret: string;
  event: string;
  payload: Record<string, unknown>;
}

@Processor('webhook-delivery', { concurrency: 2 })
export class WebhookDeliveryProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhookDeliveryProcessor.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(job: Job<WebhookDeliveryJob>): Promise<void> {
    const { deliveryId, url, secret, event, payload } = job.data;

    const subscription = await this.prisma.webhookSubscription.findUnique({
      where: { id: job.data.subscriptionId },
    });
    const entitlement = subscription
      ? await churchEntitlements(this.prisma, subscription.church_id)
      : null;
    if (
      !subscription ||
      !subscription.is_active ||
      subscription.archived_at ||
      !entitlement?.active ||
      !entitlement.features.includes('webhooks')
    ) {
      await this.prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          status: 'failed',
          response_body: 'Webhook subscription is unavailable on the current plan.',
        },
      });
      return;
    }
    await this.prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: { attempts: { increment: 1 } },
    });

    const body = JSON.stringify({ event, payload, timestamp: new Date().toISOString() });
    const signature = createHmac('sha256', secret).update(body).digest('hex');

    const response = await sendWebhook(url, body, {
      'Content-Type': 'application/json',
      'X-Webhook-Signature': `sha256=${signature}`,
      'X-Webhook-Event': event,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Webhook delivery failed: HTTP ${response.status}`);
    }
    await this.prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'success',
        response_status: response.status,
        response_body: response.body,
      },
    });
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<WebhookDeliveryJob>, error: Error): Promise<void> {
    this.logger.error(`Webhook delivery failed: ${job.data.deliveryId}: ${error.message}`);

    await this.prisma.webhookDelivery
      .update({
        where: { id: job.data.deliveryId },
        data: {
          status: 'failed',
          response_body: error.message.slice(0, 2000),
        },
      })
      .catch((err) => this.logger.error(`Failed to update delivery status: ${err.message}`));
  }

  @OnWorkerEvent('completed')
  async onCompleted(job: Job<WebhookDeliveryJob>): Promise<void> {
    this.logger.log(`Webhook delivered: ${job.data.event} → ${job.data.url}`);
  }
}
