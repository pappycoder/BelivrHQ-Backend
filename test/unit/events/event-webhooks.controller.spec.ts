import { BadRequestException } from '@nestjs/common';
import { EventWebhooksController } from '../../../src/events/event-webhooks.controller';

describe('Event payment callback routing', () => {
  const handleWebhook = jest.fn();
  const controller = new EventWebhooksController({ handleWebhook } as never);
  beforeEach(() => jest.resetAllMocks());
  it.each(['charge.success', 'refund.processed', 'charge.dispute.create'])(
    'routes %s through the common historical-account verifier',
    async (event) => {
      const raw = JSON.stringify({ event, data: { reference: 'payment' } });
      await controller.handlePaystackWebhook('untrusted-id', { 'x-paystack-signature': 'signed' }, {
        rawBody: Buffer.from(raw),
      } as never);
      expect(handleWebhook).toHaveBeenCalledWith(raw, 'signed', 'paystack');
    },
  );
  it('uses the modern signature when both headers are present', async () => {
    await controller.handlePaystackWebhook(
      'id',
      { 'paystack-signature': 'modern', 'x-paystack-signature': 'legacy' },
      { rawBody: Buffer.from('{}') } as never,
    );
    expect(handleWebhook).toHaveBeenCalledWith('{}', 'modern', 'paystack');
  });
  it('rejects missing raw payload', async () => {
    await expect(controller.handlePaystackWebhook('id', {}, {} as never)).rejects.toThrow(
      BadRequestException,
    );
  });
  it('propagates processing failures so the provider retries', async () => {
    handleWebhook.mockRejectedValue(new Error('retry'));
    await expect(
      controller.handlePaystackWebhook('id', {}, { rawBody: Buffer.from('{}') } as never),
    ).rejects.toThrow('retry');
  });
});
