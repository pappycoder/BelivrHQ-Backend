import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Cron } from '@nestjs/schedule';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { workersEnabled } from '../queues/workers-enabled';
import { churchEntitlements } from '../billing/entitlements';

/** The persisted pending delivery is the outbox; next_retry_at is its dispatch lease. */
@Injectable()
export class WebhookDispatchService {
  private readonly logger = new Logger(WebhookDispatchService.name);
  private scanning = false;
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('webhook-delivery') private readonly queue: Queue,
  ) {}

  async jobState(id: string, generation = 0) {
    const job = await this.queue.getJob(this.jobId(id, generation));
    return job ? job.getState() : undefined;
  }

  private jobId(id: string, generation: number) {
    return generation ? `webhook-${id}-${generation}` : `webhook-${id}`;
  }

  async dispatch(id: string): Promise<boolean> {
    const now = new Date();
    const lease = new Date(now.getTime() + 120000);
    try {
      const claim = await this.prisma.webhookDelivery.updateMany({
        where: {
          id,
          status: 'pending',
          OR: [{ next_retry_at: null }, { next_retry_at: { lte: now } }],
        },
        data: { next_retry_at: lease },
      });
      if (!claim.count) return false;
      const delivery = await this.prisma.webhookDelivery.findUnique({ where: { id } });
      if (!delivery || delivery.status !== 'pending') return false;
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
          where: { id, status: 'pending', next_retry_at: lease },
          data: {
            status: 'failed',
            next_retry_at: null,
            response_body: 'Webhook subscription is unavailable on the current plan.',
          },
        });
        return false;
      }
      const generation = delivery.dispatch_generation ?? 0;
      const jobId = this.jobId(id, generation);
      const existing = await this.queue.getJob(jobId);
      if (existing && (await existing.getState()) === 'failed') {
        await this.prisma.webhookDelivery.updateMany({
          where: { id, status: 'pending', next_retry_at: lease },
          data: {
            status: 'failed',
            next_retry_at: null,
            response_body: 'Delivery attempts exhausted; operator review required.',
          },
        });
        return false;
      }
      await this.queue.add(
        'deliver',
        { deliveryId: id, subscriptionId: subscription.id, generation },
        {
          jobId,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: { age: 86400 },
          removeOnFail: { age: 604800 },
        },
      );
      // Keep inspecting pending intent even if Redis loses a previously accepted job.
      await this.prisma.webhookDelivery.updateMany({
        where: { id, status: 'pending', next_retry_at: lease },
        data: { next_retry_at: new Date(Date.now() + 300000) },
      });
      return true;
    } catch {
      // Retain the lease after ambiguous acceptance/crash; stable IDs deduplicate recovery.
      this.logger.warn('Webhook dispatch deferred; persisted delivery will be recovered');
      return false;
    }
  }

  @Cron('*/30 * * * * *')
  async recoverPending(): Promise<void> {
    if (!workersEnabled() || this.scanning) return;
    this.scanning = true;
    try {
      const rows = await this.prisma.webhookDelivery.findMany({
        where: {
          status: 'pending',
          OR: [{ next_retry_at: null }, { next_retry_at: { lte: new Date() } }],
        },
        orderBy: [{ next_retry_at: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
        take: 100,
        select: { id: true },
      });
      for (const row of rows) await this.dispatch(row.id);
    } catch {
      this.logger.warn('Webhook recovery scan unavailable; it will retry');
    } finally {
      this.scanning = false;
    }
  }
}
