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
  subscriptionId?: string;
}

@Processor('webhook-delivery', { concurrency: 2 })
export class WebhookDeliveryProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhookDeliveryProcessor.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(job: Job<WebhookDeliveryJob>): Promise<void> {
    const { deliveryId } = job.data;
    const delivery = await this.prisma.webhookDelivery.findUnique({ where: { id: deliveryId } });
    if (!delivery || delivery.status !== 'pending') return;
    if (job.data.subscriptionId && delivery.subscription_id !== job.data.subscriptionId) return;
    const { event, payload } = delivery;

    const subscription = await this.prisma.webhookSubscription.findUnique({
      where: { id: delivery.subscription_id },
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
      await this.prisma.webhookDelivery.updateMany({
        where: { id: deliveryId, status: 'pending' },
        data: {
          status: 'failed',
          response_body: 'Webhook subscription is unavailable on the current plan.',
        },
      });
      return;
    }
    const claim = await this.prisma.webhookDelivery.updateMany({
      where: { id: deliveryId, status: 'pending' },
      data: { attempts: { increment: 1 } },
    });
    if (!claim.count) return;

    const body = JSON.stringify({ event, payload, timestamp: new Date().toISOString() });
    const signature = createHmac('sha256', subscription.secret).update(body).digest('hex');

    const response = await sendWebhook(subscription.url, body, {
      'Content-Type': 'application/json',
      'X-Webhook-Signature': `sha256=${signature}`,
      'X-Webhook-Event': event,
      'X-Webhook-Delivery-Id': deliveryId,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Webhook delivery failed: HTTP ${response.status}`);
    }
    await this.prisma.webhookDelivery.updateMany({
      where: { id: deliveryId, status: 'pending' },
      data: {
        status: 'success',
        next_retry_at: null,
        response_status: response.status,
        response_body: response.body,
      },
    });
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<WebhookDeliveryJob>, _error: Error): Promise<void> {
    const exhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
    this.logger.warn(`Webhook delivery attempt failed: ${job.data.deliveryId}`);
    await this.prisma.webhookDelivery
      .updateMany({
        where: { id: job.data.deliveryId, status: 'pending' },
        data: {
          status: exhausted ? 'failed' : 'pending',
          response_body: exhausted
            ? 'Delivery attempts exhausted; operator review required.'
            : 'Delivery failed; retry scheduled.',
          ...(exhausted ? { next_retry_at: null } : {}),
        },
      })
      .catch(() => this.logger.warn('Webhook delivery status update unavailable'));
  }

  @OnWorkerEvent('completed')
  async onCompleted(job: Job<WebhookDeliveryJob>): Promise<void> {
    this.logger.log(`Webhook job completed: ${job.data.deliveryId}`);
  }
}
