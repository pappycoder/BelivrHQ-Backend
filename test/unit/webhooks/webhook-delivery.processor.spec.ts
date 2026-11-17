jest.mock('../../../src/webhooks/safe-webhook-request', () => ({ sendWebhook: jest.fn() }));
import { sendWebhook } from '../../../src/webhooks/safe-webhook-request';
/**
 * @file webhook-delivery.processor.spec.ts
 * @description Unit tests for WebhookDeliveryProcessor.
 *
 * @module test/unit/webhooks/webhook-delivery.processor.spec
 */

import { createHmac } from 'crypto';
import { WebhookDeliveryProcessor } from '../../../src/webhooks/webhook-delivery.processor';
import { PrismaService } from '../../../src/prisma/prisma.service';

const deliveryId = 'dlv-11111111';
const secret = 'supersecret';

describe('WebhookDeliveryProcessor', () => {
  let prisma: {
    platformSubscription: Record<string, jest.Mock>;
    webhookSubscription: Record<string, jest.Mock>;
    webhookDelivery: Record<string, jest.Mock>;
  };
  let processor: WebhookDeliveryProcessor;
  let fetchMock: jest.Mock;

  const baseJob = {
    data: {
      deliveryId,
      subscriptionId: 'sub-1',
      url: 'https://example.com/hook',
      secret,
      event: 'member.created',
      payload: { memberId: 'm-1' },
    },
    attemptsMade: 0,
    opts: { attempts: 3 },
  };

  beforeEach(() => {
    prisma = {
      platformSubscription: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ plan: 'network', paid_until: new Date(Date.now() + 86400000) }),
      },
      webhookSubscription: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'sub-1',
          church_id: 'church',
          is_active: true,
          archived_at: null,
          url: baseJob.data.url,
          secret,
        }),
      },
      webhookDelivery: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue({
          id: deliveryId,
          status: 'pending',
          subscription_id: 'sub-1',
          event: baseJob.data.event,
          payload: baseJob.data.payload,
        }),
      },
    };
    processor = new WebhookDeliveryProcessor(prisma as unknown as PrismaService);
    fetchMock = jest.fn();
    (sendWebhook as jest.Mock).mockClear();
    (sendWebhook as jest.Mock).mockImplementation(async (url, body, headers) => {
      const response = await fetchMock(url, { body, headers });
      return { status: response.status, body: await response.text() };
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('process', () => {
    it.each(['missing', 'success', 'failed', 'mismatch'])(
      'does not contact destinations for %s queue data',
      async (state) => {
        prisma.webhookDelivery.findUnique.mockResolvedValue(
          state === 'missing'
            ? null
            : { status: state === 'mismatch' ? 'pending' : state, subscription_id: 'different' },
        );
        await processor.process(baseJob as never);
        expect(sendWebhook).not.toHaveBeenCalled();
      },
    );
    it('does not send after another actor changes the pending delivery', async () => {
      prisma.webhookDelivery.updateMany.mockResolvedValue({ count: 0 });
      await processor.process(baseJob as never);
      expect(sendWebhook).not.toHaveBeenCalled();
    });
    it('does not contact the destination after a downgrade', async () => {
      prisma.platformSubscription.findUnique.mockResolvedValue({
        plan: 'essentials',
        paid_until: new Date(Date.now() + 86400000),
      });
      await processor.process(baseJob as never);
      expect(sendWebhook).not.toHaveBeenCalled();
      expect(prisma.webhookDelivery.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }),
      );
    });

    it('should increment attempts, sign the payload, and mark the delivery successful', async () => {
      let captured: { body: string; headers: Record<string, string> } | undefined;
      fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
        captured = {
          body: init.body as string,
          headers: init.headers as Record<string, string>,
        };
        return {
          ok: true,
          status: 200,
          text: async () => '{"ok":true}',
        };
      });

      prisma.webhookDelivery.updateMany.mockResolvedValue({ count: 1 });

      await processor.process(baseJob as never);

      expect(prisma.webhookDelivery.updateMany).toHaveBeenNthCalledWith(1, {
        where: { id: deliveryId, status: 'pending', dispatch_generation: 0 },
        data: { attempts: { increment: 1 } },
      });

      expect(captured).toBeDefined();
      const expectedSig = createHmac('sha256', secret).update(captured!.body).digest('hex');
      expect(captured!.headers['X-Webhook-Signature']).toBe(`sha256=${expectedSig}`);
      expect(captured!.headers['X-Webhook-Event']).toBe('member.created');
      expect(captured!.headers['X-Webhook-Delivery-Id']).toBe(deliveryId);
      expect(captured!.body).toContain('"event":"member.created"');
      expect(captured!.body).toContain('"payload":{"memberId":"m-1"}');

      expect(prisma.webhookDelivery.updateMany).toHaveBeenNthCalledWith(2, {
        where: { id: deliveryId, status: 'pending', dispatch_generation: 0 },
        data: {
          status: 'success',
          next_retry_at: null,
          response_status: 200,
          response_body: '{"ok":true}',
        },
      });
    });

    it('should throw when the target returns a non-OK status', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'boom',
      });

      await expect(processor.process(baseJob as never)).rejects.toThrow(/HTTP 500/);
    });
  });

  describe('onFailed', () => {
    it('keeps intermediate failures pending for native retry', async () => {
      await processor.onFailed({ ...baseJob, attemptsMade: 1 } as never, new Error('private'));
      expect(prisma.webhookDelivery.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: 'pending', response_body: 'Delivery failed; retry scheduled.' },
        }),
      );
    });
    it('marks exhausted deliveries failed without storing provider error contents', async () => {
      prisma.webhookDelivery.updateMany.mockResolvedValue({ count: 1 });

      await processor.onFailed(
        { ...baseJob, id: 'job-1', attemptsMade: 3 } as never,
        new Error('connection reset'),
      );

      expect(prisma.webhookDelivery.updateMany).toHaveBeenCalledWith({
        where: { id: deliveryId, status: 'pending', dispatch_generation: 0 },
        data: {
          status: 'failed',
          response_body: 'Delivery attempts exhausted; operator review required.',
          next_retry_at: null,
        },
      });
    });
  });
});
