import { PaymentVerificationPendingException } from '../../../src/giving/services/payment-verification-pending.exception';
import { ServiceUnavailableException } from '@nestjs/common';
import { CompanyEmailService } from '../../../src/company-email/company-email.service';
import { SubscriptionPricingService } from '../../../src/billing/subscription-pricing.service';
import { RedisService } from '../../../src/redis/redis.service';
import { ConfigService } from '@nestjs/config';
import { validate } from 'class-validator';
import { CheckoutDto } from '../../../src/billing/billing.dto';
import { BillingService } from '../../../src/billing/billing.service';
import { subscriptionEnd, SUBSCRIPTION_PLANS } from '../../../src/billing/plans';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { PaystackService } from '../../../src/giving/services/paystack.service';
import { FlutterwaveService } from '../../../src/giving/services/flutterwave.service';
const reference = 'BHQSUB_' + 'a'.repeat(32);
describe('Platform subscriptions', () => {
  let service: BillingService;
  let prisma: any;
  let gateway: any;
  let pricing: SubscriptionPricingService;
  let companyEmails: { enqueueSubscription: jest.Mock; dispatch: jest.Mock };
  const payment = {
    reference,
    church_id: 'church-a',
    plan: 'essentials',
    cycle: 'monthly',
    amount: 10000,
    currency: 'NGN',
    status: 'pending',
    gateway: 'flutterwave',
    checkout_url: null,
  };
  beforeEach(() => {
    prisma = {
      member: { count: jest.fn().mockResolvedValue(25) },
      profile: { count: jest.fn().mockResolvedValue(1) },
      branch: { count: jest.fn().mockResolvedValue(1) },
      staffInvitationReservation: { count: jest.fn().mockResolvedValue(0) },
      platformSubscription: {
        findUnique: jest.fn().mockResolvedValue({
          church_id: 'church-a',
          plan: 'essentials',
          cycle: 'monthly',
          paid_until: null,
        }),
        upsert: jest
          .fn()
          .mockResolvedValue({ plan: 'essentials', cycle: 'monthly', paid_until: null }),
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ plan: 'essentials', cycle: 'monthly', paid_until: null }),
        update: jest.fn(),
      },
      subscriptionPayment: {
        findFirst: jest.fn().mockResolvedValue(null),
        findFirstOrThrow: jest
          .fn()
          .mockImplementation(() => prisma.subscriptionPayment.findFirst()),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        create: jest.fn().mockImplementation(({ data }) => ({ ...data, checkout_url: null })),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'church-a' }]),
    };
    prisma.$transaction = jest.fn((fn) => fn(prisma));
    gateway = {
      name: 'flutterwave',
      isConfigured: jest.fn().mockReturnValue(true),
      initializeTransaction: jest.fn().mockImplementation((_e, _a, ref) =>
        Promise.resolve({
          reference: ref,
          authorizationUrl: 'https://checkout.flutterwave.com/secure',
        }),
      ),
      verifyTransaction: jest
        .fn()
        .mockResolvedValue({ reference, currency: 'NGN', amount: 10000, status: 'success' }),
      validateWebhookSignature: jest.fn().mockReturnValue(true),
      parseWebhookEvent: jest.fn().mockReturnValue({ reference, event: 'charge.success' }),
    };
    const cache = new Map<string, unknown>();
    pricing = new SubscriptionPricingService(
      {
        get: jest.fn(async (key: string) => cache.get(key) ?? null),
        set: jest.fn(async (key: string, value: unknown) => {
          cache.set(key, value);
        }),
      } as unknown as RedisService,
      new ConfigService({
        SUBSCRIPTION_PAYSTACK_CURRENCIES: 'NGN,USD',
        SUBSCRIPTION_FLUTTERWAVE_CURRENCIES: 'NGN,USD',
      }),
    );
    companyEmails = {
      enqueueSubscription: jest.fn().mockResolvedValue('subscription/event'),
      dispatch: jest.fn().mockResolvedValue(undefined),
    };
    service = new BillingService(
      prisma as PrismaService,
      {
        getOrThrow: () => 'https://belivrhq.example',
        get: () => 'FLWSECK_TEST-fixture-X',
      } as unknown as ConfigService,
      gateway as PaystackService,
      { ...gateway, name: 'flutterwave' } as FlutterwaveService,
      pricing,
      companyEmails as unknown as CompanyEmailService,
    );
  });
  async function checkout(churchId: string, email: string, dto: CheckoutDto) {
    const quote = await service.quote(churchId, dto);
    return service.checkout(churchId, email, { ...dto, quoteId: quote.quoteId });
  }
  it('calculates exact server-owned monthly/yearly prices', async () => {
    for (const [plan, prices] of Object.entries(SUBSCRIPTION_PLANS))
      for (const cycle of ['monthly', 'annual'] as const) {
        await checkout('church-a', 'admin@example.org', {
          plan: plan as CheckoutDto['plan'],
          cycle,
          gateway: 'flutterwave',
        });
        expect(gateway.initializeTransaction).toHaveBeenLastCalledWith(
          'admin@example.org',
          prices[cycle],
          expect.stringMatching(/^BHQSUB_[a-f0-9]{32}$/),
          { purpose: 'belivrhq_subscription', churchId: 'church-a' },
          {
            callbackUrl: 'https://belivrhq.example/subscription?payment_window=1',
            currency: 'USD',
          },
        );
      }
  });
  it('only advertises Flutterwave and rejects new Paystack payments and quotes', async () => {
    expect(await service.status('church-a')).toMatchObject({ gateways: ['flutterwave'] });
    const dto: CheckoutDto = { plan: 'essentials', cycle: 'monthly', gateway: 'paystack' };
    await expect(service.quote('church-a', dto)).rejects.toThrow('use Flutterwave');
    await expect(service.checkout('church-a', 'admin@example.org', dto)).rejects.toThrow(
      'use Flutterwave',
    );
    expect(gateway.initializeTransaction).not.toHaveBeenCalled();
  });
  it('accepts and resumes the real Flutterwave test checkout host', async () => {
    const link = 'https://checkout-v2.dev-flutterwave.com/v3/hosted/pay/test';
    gateway.initializeTransaction.mockImplementation((_e: string, _a: number, ref: string) =>
      Promise.resolve({ reference: ref, authorizationUrl: link }),
    );
    expect(
      await checkout('church-a', 'admin@example.org', {
        plan: 'essentials',
        cycle: 'monthly',
        gateway: 'flutterwave',
      }),
    ).toMatchObject({ authorizationUrl: link });
    prisma.subscriptionPayment.findFirst.mockResolvedValue({ ...payment, checkout_url: link });
    expect(
      await service.checkout('church-a', 'admin@example.org', {
        plan: 'essentials',
        cycle: 'monthly',
        gateway: 'flutterwave',
      }),
    ).toMatchObject({ authorizationUrl: link });
    expect(gateway.initializeTransaction).toHaveBeenCalledTimes(1);
  });
  it('rejects arbitrary plans, periods, gateways and browser price fields', async () => {
    for (const change of [
      { plan: 'free' },
      { plan: 'enterprise' },
      { cycle: 'forever' },
      { gateway: 'custom' },
      { gateway: 'paystack' },
      { amount: 1 },
      { currency: 'BTC' },
      { quoteId: 'fake' },
    ]) {
      const dto = Object.assign(
        new CheckoutDto(),
        { plan: 'essentials', cycle: 'monthly', gateway: 'flutterwave' },
        change,
      );
      expect(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).not.toHaveLength(
        0,
      );
    }
  });
  it('does not charge an already-active workspace', async () => {
    prisma.platformSubscription.upsert.mockResolvedValueOnce({
      plan: 'essentials',
      cycle: 'monthly',
      paid_until: new Date(Date.now() + 60000),
    });
    await expect(
      checkout('church-a', 'admin@example.org', {
        plan: 'essentials',
        cycle: 'monthly',
        gateway: 'flutterwave',
      }),
    ).rejects.toThrow('subscription changed');
    expect(gateway.initializeTransaction).not.toHaveBeenCalled();
  });
  it('resumes the same unpaid checkout without another initialization', async () => {
    prisma.subscriptionPayment.findFirst.mockResolvedValue({
      ...payment,
      checkout_url: 'https://checkout.flutterwave.com/old',
    });
    expect(
      await service.checkout('church-a', 'admin@example.org', {
        plan: 'essentials',
        cycle: 'monthly',
        gateway: 'flutterwave',
      }),
    ).toEqual({ reference, authorizationUrl: 'https://checkout.flutterwave.com/old' });
    expect(gateway.initializeTransaction).not.toHaveBeenCalled();
  });
  it.each([
    'https://evil.example/checkout',
    'javascript:alert(1)',
    'https://checkout.flutterwave.com.evil.example/pay',
    'https://user@checkout.flutterwave.com/pay',
  ])('rejects untrusted redirect %s', async (authorizationUrl) => {
    gateway.initializeTransaction.mockImplementation((_e: any, _a: any, ref: string) =>
      Promise.resolve({ reference: ref, authorizationUrl }),
    );
    await expect(
      checkout('church-a', 'admin@example.org', {
        plan: 'essentials',
        cycle: 'monthly',
        gateway: 'flutterwave',
      }),
    ).rejects.toThrow();
    expect(prisma.subscriptionPayment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'failed' } }),
    );
  });
  it('leaves an unconfirmed provider reference and subscription unchanged for recovery', async () => {
    prisma.subscriptionPayment.findFirst.mockResolvedValue(payment);
    gateway.verifyTransaction.mockRejectedValue(new PaymentVerificationPendingException());
    await expect(service.reconcilePayment('church-a', reference)).resolves.toBeUndefined();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.subscriptionPayment.updateMany).not.toHaveBeenCalled();
    expect(prisma.platformSubscription.update).not.toHaveBeenCalled();
    expect(companyEmails.dispatch).not.toHaveBeenCalled();
  });
  it('preserves provider configuration errors for support without changing the payment', async () => {
    prisma.subscriptionPayment.findFirst.mockResolvedValue(payment);
    gateway.verifyTransaction.mockRejectedValue(
      new ServiceUnavailableException('Check Flutterwave account configuration'),
    );
    await expect(service.reconcilePayment('church-a', reference)).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.subscriptionPayment.updateMany).not.toHaveBeenCalled();
  });
  it('rejects cross-church references before contacting any provider', async () => {
    await expect(service.verify('church-b', reference)).rejects.toThrow('not found');
    expect(prisma.subscriptionPayment.findFirst).toHaveBeenCalledWith({
      where: { reference, church_id: 'church-b' },
    });
    expect(gateway.verifyTransaction).not.toHaveBeenCalled();
  });
  it.each([
    { currency: 'USD' },
    { amount: 1 },
    { reference: 'wrong' },
    { amount: NaN },
    { amount: 10000.01 },
  ])('does not activate a mismatched payment %j', async (mismatch) => {
    prisma.subscriptionPayment.findFirst.mockResolvedValue(payment);
    gateway.verifyTransaction.mockResolvedValue({
      reference,
      currency: 'NGN',
      amount: 10000,
      status: 'success',
      ...mismatch,
    });
    await expect(service.verify('church-a', reference)).rejects.toThrow('do not match');
    expect(prisma.platformSubscription.update).not.toHaveBeenCalled();
  });
  it('never activates from an unconfirmed callback or pending provider status', async () => {
    prisma.subscriptionPayment.findFirst.mockResolvedValue(payment);
    gateway.verifyTransaction.mockResolvedValue({
      reference,
      currency: 'NGN',
      amount: 10000,
      status: 'pending',
    });
    await service.verify('church-a', reference);
    expect(prisma.platformSubscription.update).not.toHaveBeenCalled();
  });
  it('claims a successful reference atomically and activates exactly once', async () => {
    prisma.subscriptionPayment.findFirst.mockResolvedValue(payment);
    prisma.subscriptionPayment.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    await service.verify('church-a', reference);
    await service.verify('church-a', reference);
    expect(prisma.platformSubscription.update).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });
  it('ignores an already activated reference without extending or recharging', async () => {
    prisma.subscriptionPayment.findFirst.mockResolvedValue({ ...payment, status: 'success' });
    await service.verify('church-a', reference);
    expect(gateway.verifyTransaction).toHaveBeenCalledWith(reference);
    expect(prisma.platformSubscription.update).not.toHaveBeenCalled();
  });
  it('queues a first-activation email only after verified success and retries dispatch on duplicate callbacks', async () => {
    prisma.subscriptionPayment.findFirst.mockResolvedValue(payment);
    await service.reconcilePayment('church-a', reference);
    expect(companyEmails.enqueueSubscription).toHaveBeenCalledTimes(1);
    expect(companyEmails.enqueueSubscription).toHaveBeenCalledWith(
      expect.anything(),
      payment,
      true,
      expect.any(Date),
    );
    expect(companyEmails.dispatch).toHaveBeenCalledWith('subscription/event');
    prisma.subscriptionPayment.findFirst.mockResolvedValue({
      ...payment,
      status: 'success',
      application_status: 'applied',
    });
    await service.reconcilePayment('church-a', reference);
    expect(companyEmails.enqueueSubscription).toHaveBeenCalledTimes(1);
    expect(companyEmails.dispatch).toHaveBeenLastCalledWith(`subscription/${reference}`);
  });
  it('marks notification as a renewal when an access period already exists', async () => {
    prisma.subscriptionPayment.findFirst.mockResolvedValue(payment);
    prisma.platformSubscription.findUniqueOrThrow.mockResolvedValue({
      plan: 'essentials',
      cycle: 'monthly',
      paid_until: new Date(0),
    });
    await service.reconcilePayment('church-a', reference);
    expect(companyEmails.enqueueSubscription).toHaveBeenCalledWith(
      expect.anything(),
      payment,
      false,
      expect.any(Date),
    );
  });
  it('does not queue success emails for pending, failed or mismatched provider results', async () => {
    prisma.subscriptionPayment.findFirst.mockResolvedValue(payment);
    for (const status of ['pending', 'failed']) {
      gateway.verifyTransaction.mockResolvedValue({
        reference,
        amount: payment.amount,
        currency: payment.currency,
        status,
      });
      await service.reconcilePayment('church-a', reference);
    }
    expect(companyEmails.enqueueSubscription).not.toHaveBeenCalled();
  });
  it('rejects unsigned callbacks before accessing the ledger', async () => {
    gateway.validateWebhookSignature.mockReturnValue(false);
    await expect(service.webhook('flutterwave', '{}', 'bad')).rejects.toThrow(
      'Invalid payment signature',
    );
    expect(prisma.subscriptionPayment.findUnique).not.toHaveBeenCalled();
  });
  it('does not reconcile a reference through a different gateway', async () => {
    prisma.subscriptionPayment.findUnique.mockResolvedValue({ ...payment, gateway: 'paystack' });
    await service.webhook('flutterwave', '{}', 'signed');
    expect(gateway.verifyTransaction).not.toHaveBeenCalled();
  });
  it('quotes an immediate upgrade for only the remaining paid period', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-16T00:00:00Z'));
    try {
      prisma.platformSubscription.findUniqueOrThrow.mockResolvedValue({
        plan: 'essentials',
        cycle: 'monthly',
        period_started_at: new Date('2026-10-01T00:00:00Z'),
        paid_until: new Date('2026-10-31T00:00:00Z'),
      });
      const quote = await service.quote('church-a', {
        plan: 'community',
        cycle: 'monthly',
        gateway: 'flutterwave',
      });
      expect(quote).toMatchObject({
        intent: 'upgrade',
        amount: 5,
        renewBy: '2026-10-31T00:00:00.000Z',
      });
      expect(prisma.platformSubscription.update).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
  it('records a stale successful payment for review without changing the current paid plan', async () => {
    prisma.subscriptionPayment.findFirst.mockResolvedValue({
      ...payment,
      intent: 'upgrade',
      base_plan: 'essentials',
      base_paid_until: new Date('2026-10-31T00:00:00Z'),
      target_paid_until: new Date('2026-10-31T00:00:00Z'),
    });
    prisma.platformSubscription.findUniqueOrThrow.mockResolvedValue({
      plan: 'network',
      paid_until: new Date('2027-01-01T00:00:00Z'),
    });
    await service.verify('church-a', reference);
    expect(prisma.subscriptionPayment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'success', application_status: 'review' }),
      }),
    );
    expect(prisma.platformSubscription.update).not.toHaveBeenCalled();
    expect(companyEmails.enqueueSubscription).not.toHaveBeenCalled();
  });
  it('does not silently substitute a different pending quote from another tab', async () => {
    const dto: CheckoutDto = { plan: 'essentials', cycle: 'monthly', gateway: 'flutterwave' };
    const quoted = await service.quote('church-a', dto);
    prisma.subscriptionPayment.findFirst.mockResolvedValue({
      ...payment,
      currency: 'USD',
      pricing_snapshot: { quoteId: 'BHQQUOTE_' + 'c'.repeat(32) },
      checkout_url: 'https://checkout.flutterwave.com/other-tab',
    });
    await expect(
      service.checkout('church-a', 'admin@example.org', { ...dto, quoteId: quoted.quoteId }),
    ).rejects.toThrow('Another checkout');
    expect(gateway.initializeTransaction).not.toHaveBeenCalled();
  });
  it('freezes a rounded NGN quote and passes its currency to the provider', async () => {
    jest
      .spyOn(pricing, 'exchange')
      .mockResolvedValue({ rate: 1500.111, updatedAt: new Date().toISOString() });
    const dto: CheckoutDto = {
      plan: 'essentials',
      cycle: 'monthly',
      gateway: 'flutterwave',
      currency: 'NGN',
    };
    const quoted = await service.quote('church-a', dto);
    expect(quoted.amount).toBe(15002);
    jest
      .spyOn(pricing, 'exchange')
      .mockResolvedValue({ rate: 2000, updatedAt: new Date().toISOString() });
    await service.checkout('church-a', 'admin@example.org', { ...dto, quoteId: quoted.quoteId });
    expect(gateway.initializeTransaction).toHaveBeenCalledWith(
      expect.any(String),
      15002,
      expect.any(String),
      expect.any(Object),
      { callbackUrl: 'https://belivrhq.example/subscription?payment_window=1', currency: 'NGN' },
    );
    expect(prisma.subscriptionPayment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          amount: 15002,
          currency: 'NGN',
          pricing_snapshot: expect.objectContaining({ exchangeRate: 1500.111, usdAmount: 10 }),
        }),
      }),
    );
  });
  it('requires a quote and rejects expired, cross-church and changed-currency quotes', async () => {
    const dto: CheckoutDto = { plan: 'essentials', cycle: 'monthly', gateway: 'flutterwave' };
    await expect(service.checkout('church-a', 'admin@example.org', dto)).rejects.toThrow(
      'fresh payment quote',
    );
    const quoted = await service.quote('church-a', dto);
    await expect(
      service.checkout('church-b', 'admin@example.org', { ...dto, quoteId: quoted.quoteId }),
    ).rejects.toThrow('expired');
    await expect(
      service.checkout('church-a', 'admin@example.org', {
        ...dto,
        currency: 'NGN',
        quoteId: quoted.quoteId,
      }),
    ).rejects.toThrow('different');
    jest.useFakeTimers().setSystemTime(Date.now() + 901000);
    try {
      await expect(
        service.checkout('church-a', 'admin@example.org', { ...dto, quoteId: quoted.quoteId }),
      ).rejects.toThrow('expired');
    } finally {
      jest.useRealTimers();
    }
    expect(gateway.initializeTransaction).not.toHaveBeenCalled();
  });
  it('returns church-wide usage including reserved staff seats', async () => {
    prisma.staffInvitationReservation.count.mockResolvedValue(1);
    const status = await service.status('church-a');
    expect(status.limits).toEqual({ members: 100, staff: 2, locations: 1 });
    expect(status.usage).toEqual({ members: 25, staff: 2, locations: 1, pendingInvitations: 1 });
  });
  it('blocks plan scheduling while an unpaid checkout is outstanding', async () => {
    prisma.platformSubscription.findUniqueOrThrow.mockResolvedValue({
      plan: 'network',
      cycle: 'monthly',
      paid_until: new Date(Date.now() + 86400000),
    });
    prisma.subscriptionPayment.findFirst.mockResolvedValue(payment);
    await expect(service.schedule('church-a', 'community', 'monthly')).rejects.toThrow(
      'pending checkout',
    );
    expect(prisma.platformSubscription.update).not.toHaveBeenCalled();
  });
  it.each([
    ['2026-01-31T14:12:00Z', 'monthly', '2026-02-28T14:12:00.000Z'],
    ['2028-02-29T12:00:00Z', 'annual', '2029-02-28T12:00:00.000Z'],
  ])('uses calendar period %s %s', (start, cycle, end) => {
    expect(subscriptionEnd(new Date(start), cycle as 'monthly' | 'annual').toISOString()).toBe(end);
  });
  it('does not sell a new overlapping period across an unresolved access hold or an already-paid future renewal', async () => {
    prisma.platformSubscription.findUniqueOrThrow.mockResolvedValue({
      plan: 'essentials',
      cycle: 'monthly',
      paid_until: null,
      access_grants: {
        grants: [
          {
            reference: 'future',
            plan: 'essentials',
            cycle: 'monthly',
            state: 'clear',
            start: new Date(Date.now() + 86400000).toISOString(),
            end: new Date(Date.now() + 32 * 86400000).toISOString(),
          },
        ],
      },
    });
    await expect(
      service.quote('church-a', {
        plan: 'essentials',
        cycle: 'monthly',
        gateway: 'flutterwave',
        currency: 'USD',
      }),
    ).rejects.toThrow('avoid overlapping payments');
  });
});
