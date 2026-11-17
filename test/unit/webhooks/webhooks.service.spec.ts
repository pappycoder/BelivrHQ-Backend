jest.mock('node:dns/promises', () => ({
  lookup: jest.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
}));
/**
 * @file webhooks.service.spec.ts
 * @description Unit tests for WebhooksService.
 *
 * @module test/unit/webhooks/webhooks.service.spec
 */

import { WebhooksService } from '../../../src/webhooks/webhooks.service';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { AuditLoggingService } from '../../../src/common/services/audit-logging.service';
import { CreateWebhookSubscriptionDto } from '../../../src/webhooks/dto/create-webhook-subscription.dto';
import { NotFoundException, ConflictException } from '@nestjs/common';
import { WebhookDispatchService } from '../../../src/webhooks/webhook-dispatch.service';

describe('WebhooksService', () => {
  const mockChurchId = '00000000-0000-0000-0000-000000000001';
  const mockUserId = '11111111-1111-1111-1111-111111111111';
  const mockSubId = '22222222-2222-2222-2222-222222222222';

  let prisma: {
    platformSubscription: Record<string, jest.Mock>;
    webhookSubscription: Record<string, jest.Mock>;
    webhookDelivery: Record<string, jest.Mock>;
  };
  let audit: { log: jest.Mock };
  let dispatcher: { dispatch: jest.Mock };
  let service: WebhooksService;

  beforeEach(() => {
    prisma = {
      platformSubscription: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ plan: 'network', paid_until: new Date(Date.now() + 86400000) }),
      },
      webhookSubscription: {
        create: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
      },
      webhookDelivery: {
        create: jest.fn(),
        findMany: jest.fn(),
      },
    };
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    dispatcher = { dispatch: jest.fn().mockResolvedValue(true) };

    service = new WebhooksService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditLoggingService,
      dispatcher as unknown as WebhookDispatchService,
    );
  });

  describe('createSubscription', () => {
    it('should create a subscription with a generated secret and audit log it', async () => {
      prisma.webhookSubscription.create.mockResolvedValue({
        id: mockSubId,
        url: 'https://example.com/hook',
        events: ['member.created'],
        secret: 'auto-secret',
        is_active: true,
        created_at: new Date('2026-07-22T10:00:00Z'),
      });

      const dto = {
        url: 'https://example.com/hook',
        events: ['member.created'],
      } as CreateWebhookSubscriptionDto;
      const result = await service.createSubscription(dto, mockChurchId, mockUserId);

      expect(prisma.webhookSubscription.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            church_id: mockChurchId,
            url: dto.url,
            events: dto.events,
            secret: expect.any(String),
          }),
        }),
      );
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entity: 'webhook_subscription',
          action: 'CREATE',
          entityId: mockSubId,
        }),
      );
      expect(result).toMatchObject({
        id: mockSubId,
        url: 'https://example.com/hook',
        events: ['member.created'],
        isActive: true,
      });
    });
  });

  describe('listSubscriptions', () => {
    it('should list subscriptions scoped by church', async () => {
      prisma.webhookSubscription.findMany.mockResolvedValue([
        {
          id: mockSubId,
          url: 'https://example.com/hook',
          events: ['member.created'],
          is_active: true,
          created_at: new Date('2026-07-22T10:00:00Z'),
        },
      ]);

      const result = await service.listSubscriptions(mockChurchId);

      expect(prisma.webhookSubscription.findMany).toHaveBeenCalledWith({
        where: { church_id: mockChurchId, archived_at: null },
        orderBy: { created_at: 'desc' },
      });
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ id: mockSubId, isActive: true });
    });

    it('should exclude archived subscriptions by default', async () => {
      prisma.webhookSubscription.findMany.mockResolvedValue([]);

      await service.listSubscriptions(mockChurchId);

      expect(prisma.webhookSubscription.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ archived_at: null }) }),
      );
    });

    it('should list only archived subscriptions when archived=true', async () => {
      prisma.webhookSubscription.findMany.mockResolvedValue([
        {
          id: mockSubId,
          url: 'https://example.com/hook',
          events: ['member.created'],
          is_active: true,
          archived_at: new Date('2026-08-28T10:00:00.000Z'),
          created_at: new Date('2026-07-22T10:00:00Z'),
        },
      ]);

      const result = await service.listSubscriptions(mockChurchId, true);

      expect(prisma.webhookSubscription.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ archived_at: { not: null } }) }),
      );
      expect(result[0].archivedAt).toBe('2026-08-28T10:00:00.000Z');
    });
  });

  describe('deactivateSubscription', () => {
    it('should deactivate and audit', async () => {
      prisma.webhookSubscription.findFirst.mockResolvedValue({ id: mockSubId, is_active: true });
      prisma.webhookSubscription.update.mockResolvedValue({ id: mockSubId, is_active: false });

      const result = await service.deactivateSubscription(mockSubId, mockChurchId, mockUserId);

      expect(result).toEqual({ deactivated: true });
      expect(prisma.webhookSubscription.update).toHaveBeenCalledWith({
        where: { id: mockSubId },
        data: { is_active: false },
      });
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ entityId: mockSubId, action: 'UPDATE' }),
      );
    });

    it('should throw NotFound when subscription does not belong to the church', async () => {
      prisma.webhookSubscription.findFirst.mockResolvedValue(null);

      await expect(
        service.deactivateSubscription(mockSubId, mockChurchId, mockUserId),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFound when deactivating an archived subscription', async () => {
      prisma.webhookSubscription.findFirst.mockResolvedValue({
        id: mockSubId,
        is_active: true,
        archived_at: new Date(),
      });

      await expect(
        service.deactivateSubscription(mockSubId, mockChurchId, mockUserId),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('listDeliveries', () => {
    it('should return delivery history for a church-owned subscription', async () => {
      prisma.webhookSubscription.findFirst.mockResolvedValue({ id: mockSubId });
      prisma.webhookDelivery.findMany.mockResolvedValue([
        {
          id: 'dlv-1',
          event: 'member.created',
          status: 'success',
          response_status: 200,
          attempts: 1,
          created_at: new Date('2026-07-22T10:00:00Z'),
        },
      ]);

      const result = await service.listDeliveries(mockSubId, mockChurchId, 20);

      expect(prisma.webhookDelivery.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { subscription_id: mockSubId }, take: 20 }),
      );
      expect(result[0]).toMatchObject({
        id: 'dlv-1',
        event: 'member.created',
        status: 'success',
        responseStatus: 200,
      });
    });
  });

  describe('testDelivery', () => {
    it('should create a pending delivery and enqueue it', async () => {
      prisma.webhookSubscription.findFirst.mockResolvedValue({
        id: mockSubId,
        url: 'https://example.com/hook',
        secret: 'secret',
      });
      prisma.webhookDelivery.create.mockResolvedValue({ id: 'dlv-1' });

      const result = await service.testDelivery(mockSubId, mockChurchId);

      expect(result).toEqual({ deliveryId: 'dlv-1' });
      expect(dispatcher.dispatch).toHaveBeenCalledWith('dlv-1');
    });

    it('should throw NotFound for inactive subscriptions', async () => {
      prisma.webhookSubscription.findFirst.mockResolvedValue(null);

      await expect(service.testDelivery(mockSubId, mockChurchId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('notifySubscribers', () => {
    it('should queue deliveries for matching active subscriptions', async () => {
      prisma.webhookSubscription.findMany.mockResolvedValue([
        { id: mockSubId, url: 'https://example.com/hook', secret: 'secret' },
      ]);
      prisma.webhookDelivery.create.mockResolvedValue({ id: 'dlv-1' });

      const result = await service.notifySubscribers(mockChurchId, 'member.created', {
        memberId: 'm-1',
      });

      expect(result).toEqual({ queued: 1 });
      expect(prisma.webhookSubscription.findMany).toHaveBeenCalledWith({
        where: {
          church_id: mockChurchId,
          is_active: true,
          events: { has: 'member.created' },
        },
      });
      expect(dispatcher.dispatch).toHaveBeenCalledWith('dlv-1');
    });

    it('should continue on per-subscription failures', async () => {
      prisma.webhookSubscription.findMany.mockResolvedValue([
        { id: mockSubId, url: 'https://example.com/hook', secret: 'secret' },
      ]);
      prisma.webhookDelivery.create.mockRejectedValue(new Error('db down'));

      const result = await service.notifySubscribers(mockChurchId, 'member.created', {});

      expect(result).toEqual({ queued: 0 });
      expect(dispatcher.dispatch).not.toHaveBeenCalled();
    });
  });

  describe('archiveSubscription', () => {
    it('should set archived_at and audit ARCHIVE', async () => {
      prisma.webhookSubscription.findFirst.mockResolvedValue({
        id: mockSubId,
        url: 'https://example.com/hook',
        events: ['member.created'],
        is_active: true,
        created_at: new Date('2026-07-22T10:00:00Z'),
      });
      prisma.webhookSubscription.update.mockResolvedValue({
        id: mockSubId,
        url: 'https://example.com/hook',
        events: ['member.created'],
        is_active: true,
        archived_at: new Date('2026-08-28T12:00:00.000Z'),
        created_at: new Date('2026-07-22T10:00:00Z'),
      });

      const result = await service.archiveSubscription(mockSubId, mockChurchId, mockUserId);

      expect(prisma.webhookSubscription.update).toHaveBeenCalledWith({
        where: { id: mockSubId },
        data: { archived_at: expect.any(Date) },
      });
      expect(result.archivedAt).toBe('2026-08-28T12:00:00.000Z');
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'ARCHIVE', entity: 'webhook_subscription' }),
      );
    });

    it('should throw ConflictException when already archived', async () => {
      prisma.webhookSubscription.findFirst.mockResolvedValue({
        id: mockSubId,
        archived_at: new Date(),
      });

      await expect(
        service.archiveSubscription(mockSubId, mockChurchId, mockUserId),
      ).rejects.toThrow(ConflictException);
    });

    it('should throw NotFoundException when missing', async () => {
      prisma.webhookSubscription.findFirst.mockResolvedValue(null);

      await expect(
        service.archiveSubscription(mockSubId, mockChurchId, mockUserId),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('restoreSubscription', () => {
    it('should clear archived_at and audit RESTORE', async () => {
      prisma.webhookSubscription.findFirst.mockResolvedValue({
        id: mockSubId,
        url: 'https://example.com/hook',
        events: ['member.created'],
        is_active: true,
        archived_at: new Date('2026-08-27T12:00:00.000Z'),
        created_at: new Date('2026-07-22T10:00:00Z'),
      });
      prisma.webhookSubscription.update.mockResolvedValue({
        id: mockSubId,
        url: 'https://example.com/hook',
        events: ['member.created'],
        is_active: true,
        created_at: new Date('2026-07-22T10:00:00Z'),
      });

      const result = await service.restoreSubscription(mockSubId, mockChurchId, mockUserId);

      expect(prisma.webhookSubscription.update).toHaveBeenCalledWith({
        where: { id: mockSubId },
        data: { archived_at: null },
      });
      expect(result.archivedAt).toBeUndefined();
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'RESTORE', entity: 'webhook_subscription' }),
      );
    });

    it('should throw ConflictException when not archived', async () => {
      prisma.webhookSubscription.findFirst.mockResolvedValue({
        id: mockSubId,
        is_active: true,
      });

      await expect(
        service.restoreSubscription(mockSubId, mockChurchId, mockUserId),
      ).rejects.toThrow(ConflictException);
    });

    it('should throw NotFoundException when missing', async () => {
      prisma.webhookSubscription.findFirst.mockResolvedValue(null);

      await expect(
        service.restoreSubscription(mockSubId, mockChurchId, mockUserId),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
