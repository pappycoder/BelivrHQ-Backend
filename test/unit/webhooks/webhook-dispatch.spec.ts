import { WebhookDispatchService } from '../../../src/webhooks/webhook-dispatch.service';

describe('Durable webhook dispatch', () => {
  let prisma: Record<string, Record<string, jest.Mock>>;
  let queue: { add: jest.Mock; getJob: jest.Mock };
  let service: WebhookDispatchService;
  beforeEach(() => {
    prisma = {
      webhookDelivery: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue({
          id: 'delivery',
          status: 'pending',
          subscription_id: 'subscription',
        }),
        findMany: jest.fn().mockResolvedValue([{ id: 'delivery' }]),
      },
      webhookSubscription: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'subscription',
          church_id: 'church',
          is_active: true,
          archived_at: null,
        }),
      },
      platformSubscription: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ plan: 'network', paid_until: new Date(Date.now() + 86400000) }),
      },
    };
    queue = {
      add: jest.fn().mockResolvedValue({ id: 'webhook-delivery' }),
      getJob: jest.fn().mockResolvedValue(null),
    };
    service = new WebhookDispatchService(prisma as never, queue as never);
  });
  it('uses stable job identity and never copies credentials or payloads into Redis', async () => {
    expect(await service.dispatch('delivery')).toBe(true);
    expect(queue.add).toHaveBeenCalledWith(
      'deliver',
      { deliveryId: 'delivery', subscriptionId: 'subscription', generation: 0 },
      expect.objectContaining({ jobId: 'webhook-delivery', attempts: 3 }),
    );
    expect(prisma.webhookDelivery.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'pending', next_retry_at: expect.any(Date) }),
        data: { next_retry_at: expect.any(Date) },
      }),
    );
  });
  it('does not dispatch a row claimed by another process', async () => {
    prisma.webhookDelivery.updateMany.mockResolvedValue({ count: 0 });
    expect(await service.dispatch('delivery')).toBe(false);
    expect(queue.add).not.toHaveBeenCalled();
  });
  it.each(['missing', 'settled', 'disabled', 'archived', 'expired', 'downgraded'])(
    'does not send %s delivery intent',
    async (reason) => {
      if (reason === 'missing') prisma.webhookDelivery.findUnique.mockResolvedValue(null);
      if (reason === 'settled')
        prisma.webhookDelivery.findUnique.mockResolvedValue({ status: 'success' });
      if (reason === 'disabled')
        prisma.webhookSubscription.findUnique.mockResolvedValue({ is_active: false });
      if (reason === 'archived')
        prisma.webhookSubscription.findUnique.mockResolvedValue({
          church_id: 'church',
          is_active: true,
          archived_at: new Date(),
        });
      if (reason === 'expired') prisma.platformSubscription.findUnique.mockResolvedValue(null);
      if (reason === 'downgraded')
        prisma.platformSubscription.findUnique.mockResolvedValue({
          plan: 'essentials',
          paid_until: new Date(Date.now() + 86400000),
        });
      expect(await service.dispatch('delivery')).toBe(false);
      expect(queue.add).not.toHaveBeenCalled();
    },
  );
  it('retains pending intent when Redis accepts a job but the acknowledgement is lost', async () => {
    queue.add.mockRejectedValueOnce(new Error('ambiguous acceptance: private credential'));
    expect(await service.dispatch('delivery')).toBe(false);
    expect(prisma.webhookDelivery.updateMany).toHaveBeenCalledTimes(1);
    expect(await service.dispatch('delivery')).toBe(true);
    expect(queue.add.mock.calls.map((call) => call[2].jobId)).toEqual([
      'webhook-delivery',
      'webhook-delivery',
    ]);
  });
  it('does not automatically replay an exhausted Redis job', async () => {
    queue.getJob.mockResolvedValue({ getState: async () => 'failed' });
    expect(await service.dispatch('delivery')).toBe(false);
    expect(queue.add).not.toHaveBeenCalled();
    expect(prisma.webhookDelivery.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }),
    );
  });
  it('observes an existing non-exhausted job using the same ID', async () => {
    queue.getJob.mockResolvedValue({ getState: async () => 'active' });
    expect(await service.dispatch('delivery')).toBe(true);
    expect(queue.add.mock.calls[0][2].jobId).toBe('webhook-delivery');
  });
  it('runs recovery only in worker processes and bounds each scan', async () => {
    const original = process.env.ENABLE_QUEUE_WORKERS;
    try {
      process.env.ENABLE_QUEUE_WORKERS = 'false';
      await service.recoverPending();
      expect(prisma.webhookDelivery.findMany).not.toHaveBeenCalled();
      process.env.ENABLE_QUEUE_WORKERS = 'true';
      await service.recoverPending();
      expect(prisma.webhookDelivery.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 100,
          where: expect.objectContaining({ status: 'pending' }),
        }),
      );
      expect(queue.add).toHaveBeenCalledTimes(1);
      prisma.webhookDelivery.findMany.mockRejectedValueOnce(new Error());
      await expect(service.recoverPending()).resolves.toBeUndefined();
    } finally {
      if (original === undefined) delete process.env.ENABLE_QUEUE_WORKERS;
      else process.env.ENABLE_QUEUE_WORKERS = original;
    }
  });
});
