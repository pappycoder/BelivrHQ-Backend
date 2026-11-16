import { ForbiddenException, ConflictException, NotFoundException } from '@nestjs/common';
import { WebhooksService } from '../../../src/webhooks/webhooks.service';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RetryWebhookDeliveryDto } from '../../../src/webhooks/dto/retry-webhook-delivery.dto';

describe('Authorized and audited webhook recovery', () => {
  let prisma: {
    profile: Record<string, jest.Mock>;
    $queryRaw: jest.Mock;
    $transaction: jest.Mock;
    webhookDelivery: Record<string, jest.Mock>;
    webhookSubscription: Record<string, jest.Mock>;
    platformSubscription: Record<string, jest.Mock>;
    auditLog: Record<string, jest.Mock>;
  };
  let dispatch: { dispatch: jest.Mock; jobState: jest.Mock };
  let service: WebhooksService;
  beforeEach(() => {
    prisma = {
      $transaction: jest.fn(),
      profile: { findFirst: jest.fn().mockResolvedValue({ id: 'actor' }) },
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'delivery' }]),
      webhookDelivery: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          status: 'failed',
          subscription_id: 'sub-1',
          dispatch_generation: 0,
        }),
        update: jest.fn().mockResolvedValue({ dispatch_generation: 1 }),
      },
      webhookSubscription: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({ is_active: true, archived_at: null }),
      },
      platformSubscription: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ plan: 'network', paid_until: new Date(Date.now() + 86400000) }),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    prisma.$transaction = jest.fn((operation) => operation(prisma));
    dispatch = {
      dispatch: jest.fn().mockResolvedValue(true),
      jobState: jest.fn().mockResolvedValue('failed'),
    };
    service = new WebhooksService(prisma as never, {} as never, dispatch as never);
  });
  it('rechecks the operator role and tenant instead of trusting a client claim', async () => {
    prisma.profile.findFirst.mockResolvedValue(null);
    await expect(
      service.retryDelivery('delivery', 'church', 'actor', 'Reviewed provider failure'),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.profile.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          user_id: 'actor',
          church_id: 'church',
          role: { has: 'super_admin' },
          status: 'active',
          archived_at: null,
        }),
      }),
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('does not disclose another tenant delivery', async () => {
    prisma.$queryRaw.mockResolvedValue([]);
    await expect(
      service.retryDelivery('delivery', 'church', 'actor', 'Reviewed provider failure'),
    ).rejects.toThrow(NotFoundException);
    expect(dispatch.dispatch).not.toHaveBeenCalled();
  });
  it.each(['pending', 'success'])('rejects %s delivery replays', async (status) => {
    prisma.webhookDelivery.findUniqueOrThrow.mockResolvedValue({ status });
    await expect(
      service.retryDelivery('delivery', 'church', 'actor', 'Reviewed provider failure'),
    ).rejects.toThrow(ConflictException);
  });
  it.each(['active', 'waiting', 'delayed'])(
    'rejects review while a queue job is %s',
    async (state) => {
      dispatch.jobState.mockResolvedValue(state);
      await expect(
        service.retryDelivery('delivery', 'church', 'actor', 'Reviewed provider failure'),
      ).rejects.toThrow(ConflictException);
      expect(prisma.webhookDelivery.update).not.toHaveBeenCalled();
    },
  );
  it('checks current endpoint/plan eligibility', async () => {
    prisma.webhookSubscription.findUniqueOrThrow.mockResolvedValue({ is_active: false });
    await expect(
      service.retryDelivery('delivery', 'church', 'actor', 'Reviewed provider failure'),
    ).rejects.toThrow(ConflictException);
  });
  it('commits the review with a new generation before dispatching', async () => {
    expect(
      await service.retryDelivery('delivery', 'church', 'actor', '  Reviewed provider failure  '),
    ).toEqual({ deliveryId: 'delivery', generation: 1, queued: true });
    expect(prisma.webhookDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: 'pending', next_retry_at: null, dispatch_generation: { increment: 1 } },
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          user_id: 'actor',
          church_id: 'church',
          entity_id: 'delivery',
          new_values: { decision: 'retry', reason: 'Reviewed provider failure', generation: 1 },
        }),
      }),
    );
    expect(prisma.auditLog.create.mock.invocationCallOrder[0]).toBeLessThan(
      dispatch.dispatch.mock.invocationCallOrder[0],
    );
  });
  it('does not dispatch if the transactional audit fails', async () => {
    prisma.auditLog.create.mockRejectedValue(new Error('audit unavailable'));
    await expect(
      service.retryDelivery('delivery', 'church', 'actor', 'Reviewed provider failure'),
    ).rejects.toThrow('audit unavailable');
    expect(dispatch.dispatch).not.toHaveBeenCalled();
  });
  it.each(['short', ' '.repeat(20), 'x'.repeat(501)])(
    'validates the operator reason: %j',
    async (reason) => {
      expect(
        (await validate(plainToInstance(RetryWebhookDeliveryDto, { reason }))).length,
      ).toBeGreaterThan(0);
      await expect(service.retryDelivery('delivery', 'church', 'actor', reason)).rejects.toThrow();
    },
  );
});
