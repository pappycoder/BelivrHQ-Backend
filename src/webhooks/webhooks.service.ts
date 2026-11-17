import { churchEntitlements, entitlementsFromSubscription } from '../billing/entitlements';
import { resolveWebhookUrl } from './safe-webhook-request';
/**
 * @file webhooks.service.ts
 * @description Service for outbound webhook management and delivery.
 *
 * Manages webhook subscriptions, fires deliveries via BullMQ,
 * and tracks delivery status with retry support.
 *
 * @module webhooks/webhooks.service
 * @since 1.0.0
 */

import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { WebhookDispatchService } from './webhook-dispatch.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLoggingService } from '../common/services/audit-logging.service';
import { CreateWebhookSubscriptionDto } from './dto/create-webhook-subscription.dto';
import {
  WebhookSubscriptionResponseDto,
  WebhookDeliveryResponseDto,
} from './dto/webhook-response.dto';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLoggingService,
    private readonly dispatch: WebhookDispatchService,
  ) {}

  async retryDelivery(id: string, churchId: string, userId: string, reason: string) {
    if (typeof reason !== 'string' || reason.trim().length < 10 || reason.trim().length > 500)
      throw new BadRequestException('A review reason of 10 to 500 characters is required');
    const actor = await this.prisma.profile.findFirst({
      where: {
        user_id: userId,
        church_id: churchId,
        role: { has: 'super_admin' },
        status: 'active',
        archived_at: null,
      },
      select: { id: true },
    });
    if (!actor)
      throw new ForbiddenException('Only super administrators may review webhook retries');
    const generation = await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<
        { id: string }[]
      >`SELECT d.id FROM webhook_deliveries d JOIN webhook_subscriptions s ON s.id = d.subscription_id WHERE d.id = ${id} AND s.church_id = ${churchId} FOR UPDATE OF d, s`;
      if (!locked.length) throw new NotFoundException('Webhook delivery not found');
      const delivery = await tx.webhookDelivery.findUniqueOrThrow({ where: { id } });
      if (delivery.status !== 'failed')
        throw new ConflictException('Only failed deliveries can be reviewed for retry');
      const subscription = await tx.webhookSubscription.findUniqueOrThrow({
        where: { id: delivery.subscription_id },
      });
      const entitlement = entitlementsFromSubscription(
        await tx.platformSubscription.findUnique({ where: { church_id: churchId } }),
      );
      if (
        !subscription.is_active ||
        subscription.archived_at ||
        !entitlement.active ||
        !entitlement.features.includes('webhooks')
      )
        throw new ConflictException('Webhook subscription is not currently eligible');
      const state = await this.dispatch.jobState(id, delivery.dispatch_generation);
      if (state && !['completed', 'failed', 'unknown'].includes(state))
        throw new ConflictException('A delivery attempt is still in progress');
      const updated = await tx.webhookDelivery.update({
        where: { id },
        data: { status: 'pending', next_retry_at: null, dispatch_generation: { increment: 1 } },
      });
      await tx.auditLog.create({
        data: {
          church_id: churchId,
          user_id: userId,
          entity: 'webhook_delivery',
          entity_id: id,
          action: 'UPDATE',
          new_values: {
            decision: 'retry',
            reason: reason.trim(),
            generation: updated.dispatch_generation,
          },
        },
      });
      return updated.dispatch_generation;
    });
    const queued = await this.dispatch.dispatch(id);
    return { deliveryId: id, generation, queued };
  }

  /**
   * Create a webhook subscription.
   */
  async createSubscription(
    dto: CreateWebhookSubscriptionDto,
    churchId: string,
    userId: string,
  ): Promise<WebhookSubscriptionResponseDto> {
    await resolveWebhookUrl(dto.url);
    const secret = dto.secret || randomBytes(32).toString('hex');

    const subscription = await this.prisma.webhookSubscription.create({
      data: {
        church_id: churchId,
        url: dto.url,
        events: dto.events,
        secret,
      },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'webhook_subscription',
      action: 'CREATE',
      entityId: subscription.id,
      newValues: { url: dto.url, events: dto.events },
    });

    this.logger.log(`Webhook subscription created: ${subscription.id}`);

    return this.mapSubscriptionToDto(subscription);
  }

  /**
   * List all webhook subscriptions for a church.
   */
  async listSubscriptions(
    churchId: string,
    archived = false,
  ): Promise<WebhookSubscriptionResponseDto[]> {
    const subscriptions = await this.prisma.webhookSubscription.findMany({
      where: {
        church_id: churchId,
        archived_at: archived === true ? { not: null } : null,
      },
      orderBy: { created_at: 'desc' },
    });

    return subscriptions.map((s) => this.mapSubscriptionToDto(s));
  }

  /**
   * Deactivate a webhook subscription.
   */
  async deactivateSubscription(
    subscriptionId: string,
    churchId: string,
    userId: string,
  ): Promise<{ deactivated: boolean }> {
    const subscription = await this.prisma.webhookSubscription.findFirst({
      where: { id: subscriptionId, church_id: churchId },
    });

    if (!subscription) {
      throw new NotFoundException('Webhook subscription not found');
    }

    if (subscription.archived_at) {
      throw new NotFoundException('Webhook subscription not found');
    }

    await this.prisma.webhookSubscription.update({
      where: { id: subscriptionId },
      data: { is_active: false },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'webhook_subscription',
      action: 'UPDATE',
      entityId: subscriptionId,
      oldValues: { is_active: true },
      newValues: { is_active: false },
    });

    return { deactivated: true };
  }

  /**
   * List delivery history for a subscription.
   */
  async listDeliveries(
    subscriptionId: string,
    churchId: string,
    limit = 50,
  ): Promise<WebhookDeliveryResponseDto[]> {
    const subscription = await this.prisma.webhookSubscription.findFirst({
      where: { id: subscriptionId, church_id: churchId },
    });

    if (!subscription) {
      throw new NotFoundException('Webhook subscription not found');
    }

    const deliveries = await this.prisma.webhookDelivery.findMany({
      where: { subscription_id: subscriptionId },
      orderBy: { created_at: 'desc' },
      take: limit,
    });

    return deliveries.map((d) => this.mapDeliveryToDto(d));
  }

  /**
   * Fire a test delivery for a subscription.
   */
  async testDelivery(subscriptionId: string, churchId: string): Promise<{ deliveryId: string }> {
    const subscription = await this.prisma.webhookSubscription.findFirst({
      where: { id: subscriptionId, church_id: churchId, is_active: true },
    });

    if (!subscription) {
      throw new NotFoundException('Active webhook subscription not found');
    }

    const delivery = await this.prisma.webhookDelivery.create({
      data: {
        subscription_id: subscriptionId,
        event: 'test.ping',
        payload: { test: true, timestamp: new Date().toISOString() },
        status: 'pending',
      },
    });

    await this.dispatch.dispatch(delivery.id);

    this.logger.log(`Test webhook delivery persisted: ${delivery.id}`);

    return { deliveryId: delivery.id };
  }

  /**
   * Notify subscribers of an event (called by other services internally).
   */
  async notifySubscribers(
    churchId: string,
    event: string,
    payload: Record<string, unknown>,
  ): Promise<{ queued: number }> {
    const entitlement = await churchEntitlements(this.prisma, churchId);
    if (!entitlement.active || !entitlement.features.includes('webhooks')) return { queued: 0 };
    const subscriptions = await this.prisma.webhookSubscription.findMany({
      where: { church_id: churchId, is_active: true, events: { has: event } },
    });

    let queued = 0;

    for (const sub of subscriptions) {
      try {
        const delivery = await this.prisma.webhookDelivery.create({
          data: {
            subscription_id: sub.id,
            event,
            payload: payload as Prisma.InputJsonValue,
            status: 'pending',
          },
        });

        if (await this.dispatch.dispatch(delivery.id)) queued++;
      } catch {
        this.logger.warn(`Webhook event persistence failed for subscription ${sub.id}`);
      }
    }

    if (queued > 0) {
      this.logger.log(`Webhook deliveries queued: ${queued} for event ${event}`);
    }

    return { queued };
  }

  /**
   * Archives a webhook subscription by setting archived_at. Archived
   * subscriptions drop out of active lists but stay reachable and can be
   * restored or purged.
   *
   * @param subscriptionId - Subscription UUID
   * @param churchId - Church UUID for tenant scoping
   * @param userId - Acting user ID for audit logging
   * @returns Updated subscription response
   * @throws NotFoundException if the subscription is missing or not in this church
   * @throws ConflictException if the subscription is already archived
   */
  async archiveSubscription(
    subscriptionId: string,
    churchId: string,
    userId: string,
  ): Promise<WebhookSubscriptionResponseDto> {
    const subscription = await this.prisma.webhookSubscription.findFirst({
      where: { id: subscriptionId, church_id: churchId },
    });

    if (!subscription) {
      throw new NotFoundException('Webhook subscription not found');
    }

    if (subscription.archived_at) {
      throw new ConflictException('Webhook subscription is already archived');
    }

    const updated = await this.prisma.webhookSubscription.update({
      where: { id: subscriptionId },
      data: { archived_at: new Date() },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'webhook_subscription',
      action: 'ARCHIVE',
      entityId: subscriptionId,
      oldValues: { archived_at: subscription.archived_at },
      newValues: { archived_at: updated.archived_at },
    });

    this.logger.log(`Webhook subscription archived: ${subscriptionId}`);

    return this.mapSubscriptionToDto(updated);
  }

  /**
   * Restores an archived webhook subscription by clearing archived_at.
   *
   * @param subscriptionId - Subscription UUID
   * @param churchId - Church UUID for tenant scoping
   * @param userId - Acting user ID for audit logging
   * @returns Updated subscription response
   * @throws NotFoundException if the subscription is missing or not in this church
   * @throws ConflictException if the subscription is not currently archived
   */
  async restoreSubscription(
    subscriptionId: string,
    churchId: string,
    userId: string,
  ): Promise<WebhookSubscriptionResponseDto> {
    const subscription = await this.prisma.webhookSubscription.findFirst({
      where: { id: subscriptionId, church_id: churchId },
    });

    if (!subscription) {
      throw new NotFoundException('Webhook subscription not found');
    }

    if (!subscription.archived_at) {
      throw new ConflictException('Webhook subscription is not archived');
    }

    const updated = await this.prisma.webhookSubscription.update({
      where: { id: subscriptionId },
      data: { archived_at: null },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'webhook_subscription',
      action: 'RESTORE',
      entityId: subscriptionId,
      oldValues: { archived_at: subscription.archived_at },
      newValues: { archived_at: null },
    });

    this.logger.log(`Webhook subscription restored: ${subscriptionId}`);

    return this.mapSubscriptionToDto(updated);
  }

  private mapSubscriptionToDto(sub: Record<string, unknown>): WebhookSubscriptionResponseDto {
    return {
      id: sub.id as string,
      url: sub.url as string,
      events: sub.events as string[],
      isActive: sub.is_active as boolean,
      archivedAt: (sub.archived_at as Date | null | undefined)?.toISOString() ?? undefined,
      createdAt: (sub.created_at as Date).toISOString(),
    };
  }

  private mapDeliveryToDto(del: Record<string, unknown>): WebhookDeliveryResponseDto {
    return {
      id: del.id as string,
      event: del.event as string,
      status: del.status as string,
      responseStatus: del.response_status as number | undefined,
      attempts: del.attempts as number,
      createdAt: (del.created_at as Date).toISOString(),
    };
  }
}
