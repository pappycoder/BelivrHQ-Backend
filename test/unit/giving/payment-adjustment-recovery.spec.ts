import { ConfigService } from '@nestjs/config';
import { PaystackService } from '../../../src/giving/services/paystack.service';
import { FlutterwaveService } from '../../../src/giving/services/flutterwave.service';

describe('missed refund/dispute recovery', () => {
  afterEach(() => jest.restoreAllMocks());
  const payment = {
    reference: 'original',
    providerTransactionId: '42',
    providerReference: 'FLW-original',
    currency: 'NGN',
    createdAt: new Date('2026-11-01'),
  };
  it('reads Paystack adjustments for the original provider transaction and rejects unrelated returned rows', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(
      async (input) =>
        new Response(
          JSON.stringify({
            status: true,
            data: String(input).includes('/refund?')
              ? [
                  {
                    id: 1,
                    transaction: { id: 42, reference: 'original' },
                    amount: 5000,
                    currency: 'NGN',
                    status: 'processed',
                  },
                  {
                    id: 2,
                    transaction: { id: 99, reference: 'unrelated' },
                    amount: 9000,
                    status: 'processed',
                  },
                ]
              : [{ id: 3, transaction: 42, status: 'awaiting-merchant-feedback' }],
            meta: { pageCount: 1 },
          }),
        ),
    );
    const provider = new PaystackService(new ConfigService({ PAYSTACK_SECRET_KEY: 'test' }));
    expect(await provider.listAdjustments(payment)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: '1', kind: 'refund', state: 'completed', amount: 50 }),
        expect.objectContaining({ id: '3', kind: 'dispute', state: 'open' }),
      ]),
    );
    expect(fetch.mock.calls.every((call) => String(call[0]).includes('transaction=42'))).toBe(true);
    expect((await provider.listAdjustments(payment)).some((item) => item.id === '2')).toBe(false);
  });
  it('matches Flutterwave refunds by original transaction ID rather than refund ID or reference', async () => {
    jest.spyOn(globalThis, 'fetch').mockImplementation(
      async (input) =>
        new Response(
          JSON.stringify({
            status: 'success',
            data: String(input).includes('/refunds?')
              ? [
                  {
                    id: 5,
                    tx_id: 42,
                    flw_ref: 'refund-reference',
                    amount_refunded: 50,
                    status: 'completed-mpgs',
                  },
                  { id: 42, tx_id: 99, amount_refunded: 100, status: 'completed-mpgs' },
                ]
              : [{ id: 7, flw_ref: 'FLW-original', transaction_id: 42, status: 'won' }],
            meta: { page_info: { total_pages: 1 } },
          }),
        ),
    );
    const provider = new FlutterwaveService(new ConfigService({ FLUTTERWAVE_SECRET_KEY: 'test' }));
    const recovered = await provider.listAdjustments(payment);
    expect(recovered).toHaveLength(2);
    expect(recovered).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: '5', state: 'completed', amount: 50 }),
        expect.objectContaining({ id: '7', state: 'won' }),
      ]),
    );
  });
  it('keeps existing adjustment facts when a provider history request fails', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ status: false, data: null }), { status: 503 }),
      );
    const provider = new PaystackService(new ConfigService({ PAYSTACK_SECRET_KEY: 'test' }));
    await expect(provider.listAdjustments(payment)).rejects.toThrow('unavailable');
  });
});
