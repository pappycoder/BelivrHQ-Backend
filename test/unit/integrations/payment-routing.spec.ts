import { createHmac } from 'node:crypto';
import { GivingService } from '../../../src/giving/giving.service';
import { PaymentAccountsService } from '../../../src/giving/services/payment-accounts.service';
import { PaystackService } from '../../../src/giving/services/paystack.service';
import { ConfigService } from '@nestjs/config';
import { BranchScopeService } from '../../../src/common/services/branch-scope.service';

describe('Payment settlement and merchant isolation', () => {
  const secret = 'sk_test_original123';
  const reference = 'TITprovider-test';
  const transaction = {
    id: 'transaction',
    church_id: 'church-a',
    payment_gateway: 'paystack',
    integration_account_id: 'original-account',
    payment_reference: reference,
    amount: 5000,
    currency: 'NGN',
    status: 'pending',
    member_id: null,
    category_id: 'category',
    category: { name: 'Tithe' },
  };
  const payload = JSON.stringify({
    event: 'charge.success',
    data: { reference, amount: 500000, channel: 'card', customer: { email: 'member@example.org' } },
  });
  const signature = createHmac('sha512', secret).update(payload).digest('hex');
  let service: GivingService;
  let update: jest.Mock;
  let fetchMock: jest.SpiedFunction<typeof fetch>;
  let history: jest.Mock;
  beforeEach(() => {
    const provider = new PaystackService(new ConfigService({ PAYSTACK_SECRET_KEY: secret }));
    update = jest.fn().mockResolvedValue({ ...transaction, status: 'success' });
    const prisma = {
      transaction: {
        findFirst: jest.fn().mockResolvedValue(transaction),
        findFirstOrThrow: jest.fn().mockResolvedValue(transaction),
        findMany: jest.fn().mockResolvedValue([transaction]),
        updateMany: update,
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
      eventRegistration: { findFirst: jest.fn().mockResolvedValue(null) },
      profile: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    Object.assign(prisma, { $transaction: (fn: (tx: typeof prisma) => unknown) => fn(prisma) });
    history = jest.fn().mockResolvedValue(provider);
    service = new GivingService(
      prisma as never,
      { log: jest.fn() } as never,
      new Map([
        [
          'paystack',
          new PaystackService(new ConfigService({ PAYSTACK_SECRET_KEY: 'platform-key' })),
        ],
      ]),
      {} as never,
      {} as never,
      {} as BranchScopeService,
      {} as never,
      { historical: history } as unknown as PaymentAccountsService,
    );
    jest
      .spyOn(
        service as unknown as { generateReceiptNumber: () => Promise<string> },
        'generateReceiptNumber',
      )
      .mockResolvedValue('RECEIPT-1');
    fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          status: true,
          data: {
            reference,
            amount: 500000,
            currency: 'NGN',
            status: 'success',
            paid_at: '2026-10-16T00:00:00Z',
            channel: 'card',
            customer: { email: 'member@example.org' },
          },
        }),
      ),
    );
  });
  it('uses the originating church account to authenticate and independently verify a webhook', async () => {
    expect(await service.handleWebhook(payload, signature, 'paystack')).toEqual({
      processed: true,
      event: 'charge.success',
      reference,
    });
    expect(history).toHaveBeenCalledWith('church-a', 'paystack', 'original-account');
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: `Bearer ${secret}`,
    });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'success' }) }),
    );
  });
  it('rejects a platform/other merchant signature before making any payment mutation', async () => {
    const other = createHmac('sha512', 'platform-key').update(payload).digest('hex');
    await expect(service.handleWebhook(payload, other, 'paystack')).rejects.toThrow(
      'securely matched',
    );
    expect(update).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('rejects a validly signed notification if verified amount/currency differs', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: true,
          data: {
            reference,
            amount: 10000,
            currency: 'USD',
            status: 'success',
            channel: 'card',
            customer: { email: 'member@example.org' },
          },
        }),
      ),
    );
    await expect(service.handleWebhook(payload, signature, 'paystack')).rejects.toThrow(
      'does not match',
    );
    expect(update).not.toHaveBeenCalled();
  });
});
