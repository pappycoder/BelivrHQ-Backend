import { createHmac } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { PaystackService } from '../../../src/giving/services/paystack.service';

describe('Paystack lifecycle contract', () => {
  const secret = 'sk_test_payment',
    signing = 'whsec_test_signing';
  const gateway = new PaystackService(
    new ConfigService({ PAYSTACK_SECRET_KEY: secret, PAYSTACK_WEBHOOK_SECRET: signing }),
  );
  const raw = JSON.stringify({ event: 'charge.success', data: { reference: 'payment' } });
  afterEach(() => jest.restoreAllMocks());
  it('accepts modern signed raw bodies, including overlapping signing keys', () => {
    const time = Math.floor(Date.now() / 1000);
    const hash = createHmac('sha512', signing).update(`${time}.${raw}`).digest('hex');
    expect(
      gateway.validateWebhookSignature(
        raw,
        `t=${time},v1=whk_old:${'0'.repeat(128)},v1=whk_current:${hash}`,
      ),
    ).toBe(true);
    expect(gateway.validateWebhookSignature(`${raw} `, `t=${time},v1=whk_current:${hash}`)).toBe(
      false,
    );
    expect(gateway.validateWebhookSignature(raw, `t=${time - 301},v1=whk_current:${hash}`)).toBe(
      false,
    );
  });
  it('retains legacy HMAC signatures and rejects malformed signatures', () => {
    expect(
      gateway.validateWebhookSignature(raw, createHmac('sha512', secret).update(raw).digest('hex')),
    ).toBe(true);
    expect(gateway.validateWebhookSignature(raw, 'invalid')).toBe(false);
    expect(gateway.validateWebhookSignature(raw, `t=123,t=123,v1=whk_id:${'a'.repeat(128)}`)).toBe(
      false,
    );
  });
  it.each(['refund.failed', 'refund.pending', 'refund.processing', 'refund.processed'])(
    'does not treat %s as a charge reversal',
    (event) => {
      expect(gateway.mapEventToStatus(event)).toBeNull();
    },
  );
  it.each([
    ['success', 'success'],
    ['failed', 'failed'],
    ['abandoned', 'failed'],
    ['ongoing', 'pending'],
    ['processing', 'pending'],
    ['reversed', 'reversed'],
  ])('normalizes verified %s', async (status, expected) => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          status: true,
          data: {
            id: 123,
            reference: 'payment',
            currency: 'NGN',
            amount: 10000,
            status,
            customer: { email: '' },
          },
        }),
      ),
    );
    expect(await gateway.verifyTransaction('payment')).toMatchObject({
      status: expected,
      amount: 100,
      providerTransactionId: '123',
    });
  });
  it('treats an uncreated checkout charge as unconfirmed and keeps provider errors distinct', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch');
    fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: false, message: 'Transaction reference not found' }), {
        status: 404,
      }),
    );
    await expect(gateway.verifyTransaction('unpaid')).rejects.toThrow('No completed payment');
    fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: false, message: 'Invalid key' }), { status: 401 }),
    );
    await expect(gateway.verifyTransaction('payment')).rejects.toThrow(
      'Paystack could not confirm',
    );
  });
});
