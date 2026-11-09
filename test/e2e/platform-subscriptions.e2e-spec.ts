import { CompanyEmailService } from '../../src/company-email/company-email.service';
import { SubscriptionPricingService } from '../../src/billing/subscription-pricing.service';
import { RedisService } from '../../src/redis/redis.service';
import { randomUUID, createHmac } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Request, Response, NextFunction } from 'express';
import { PrismaService } from '../../src/prisma/prisma.service';
import { BillingController, BillingWebhookController } from '../../src/billing/billing.controller';
import { BillingService } from '../../src/billing/billing.service';
import { PaymentReconciliationService } from '../../src/billing/payment-reconciliation.service';
import { PaystackService } from '../../src/giving/services/paystack.service';
import { FlutterwaveService } from '../../src/giving/services/flutterwave.service';
import { JwtAuthGuard } from '../../src/auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../src/auth/guards/permissions.guard';
import { PermissionsService } from '../../src/auth/services/permissions.service';
import { ResponseInterceptor } from '../../src/common/interceptors/response.interceptor';
import { GlobalExceptionFilter } from '../../src/common/filters/global-exception.filter';
import {
  generateAllPermissions,
  DEFAULT_PERMISSION_MATRIX,
} from '../../prisma/seeds/shared/permissions.seed';
jest.mock('jose', () => ({}));
describe('Platform subscription checkout (PostgreSQL + HTTP)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let base: string;
  const churchA = randomUUID(),
    churchB = randomUUID(),
    churchUnconfigured = randomUUID();
  const secret = 'sk_test_organization_only';
  const originalFetch = global.fetch;
  let fetchSpy: jest.SpyInstance;
  const providerPayments = new Map<
    string,
    { amount: number; currency: string; status: string; reference: string }
  >();
  const quoteCache = new Map<string, unknown>();
  const request = async (
    path: string,
    method = 'GET',
    body?: unknown,
    role = 'church_admin',
    church = churchA,
  ): Promise<globalThis.Response> => {
    // Simulate the administrator reviewing a server quote before creating a new checkout.
    const dto = body as Record<string, unknown> | undefined;
    if (
      path === '/billing/checkout' &&
      role === 'church_admin' &&
      dto &&
      !dto.quoteId &&
      ['essentials', 'community', 'network'].includes(String(dto.plan)) &&
      Object.keys(dto).every((key) => ['plan', 'cycle', 'gateway', 'currency'].includes(key))
    ) {
      const existing = await prisma.subscriptionPayment.findFirst({
        where: { church_id: church, status: 'pending', checkout_url: { not: null } },
      });
      if (existing)
        return originalFetch(base + path, {
          method,
          headers: {
            'Content-Type': 'application/json',
            'x-test-role': role,
            'x-test-church': church,
          },
          body: JSON.stringify({ ...dto, currency: existing.currency }),
        });
      const quoted = await request(
        '/billing/quote',
        'POST',
        { ...dto, currency: 'NGN' },
        role,
        church,
      );
      if (!quoted.ok) return quoted;
      const data = (await quoted.json()).data;
      body = { ...dto, currency: 'NGN', quoteId: data.quoteId };
    }
    return originalFetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-test-role': role, 'x-test-church': church },
      body: body ? JSON.stringify(body) : undefined,
    });
  };
  const result = async (r: globalThis.Response) =>
    (
      (await r.json()) as {
        data: Record<string, unknown> & { reference: string; authorizationUrl: string };
      }
    ).data;
  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    await prisma.church.createMany({
      data: [
        { id: churchA, name: 'Subscription A' },
        { id: churchB, name: 'Subscription B' },
        { id: churchUnconfigured, name: 'Unconfigured workspace' },
      ],
    });
    await prisma.platformSubscription.createMany({
      data: [churchA, churchB].map((church_id) => ({
        church_id,
        plan: 'essentials',
        cycle: 'monthly',
      })),
    });
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === 'https://open.er-api.com/v6/latest/USD')
        return globalThis.Response.json({
          result: 'success',
          base_code: 'USD',
          time_last_update_unix: Math.floor(Date.now() / 1000),
          time_next_update_unix: Math.floor(Date.now() / 1000) + 86400,
          rates: Object.fromEntries(
            ['USD', 'NGN', 'EUR', 'GBP', 'CAD', 'GHS', 'KES', 'ZAR', 'UGX', 'XAF', 'XOF'].map(
              (c) => [c, c === 'USD' ? 1 : 1000],
            ),
          ),
        });
      if (url === 'https://api.paystack.co/transaction/initialize') {
        expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer ' + secret);
        const body = JSON.parse(String(init!.body));
        expect(body.callback_url).toBe('https://churchos.example/subscription?payment_window=1');
        expect(body.metadata.purpose).toBe('churchos_subscription');
        providerPayments.set(body.reference, {
          reference: body.reference,
          amount: body.amount,
          currency: 'NGN',
          status: 'success',
        });
        return new globalThis.Response(
          JSON.stringify({
            status: true,
            data: {
              authorization_url: 'https://checkout.paystack.com/' + body.reference,
              reference: body.reference,
              access_code: 'test',
            },
          }),
        );
      }
      if (url.startsWith('https://api.paystack.co/transaction/verify/')) {
        const ref = url.split('/').at(-1)!;
        const record = providerPayments.get(ref);
        return new globalThis.Response(
          JSON.stringify({
            status: true,
            data: {
              ...record,
              paid_at: new Date().toISOString(),
              channel: 'card',
              customer: { email: 'admin@example.org' },
            },
          }),
        );
      }
      if (url === 'https://api.flutterwave.com/v3/payments') {
        expect((init!.headers as Record<string, string>).Authorization).toBe(
          'Bearer platform-flutterwave-test',
        );
        const body = JSON.parse(String(init!.body));
        expect(body.redirect_url).toBe('https://churchos.example/subscription?payment_window=1');
        providerPayments.set(body.tx_ref, {
          reference: body.tx_ref,
          amount: body.amount,
          currency: 'NGN',
          status: 'success',
        });
        return new globalThis.Response(
          JSON.stringify({
            status: 'success',
            data: { link: 'https://checkout.flutterwave.com/' + body.tx_ref },
          }),
        );
      }
      if (url.startsWith('https://api.flutterwave.com/v3/transactions/verify_by_reference?')) {
        const ref = new URL(url).searchParams.get('tx_ref')!;
        const record = providerPayments.get(ref)!;
        return new globalThis.Response(
          JSON.stringify({
            status: 'success',
            data: {
              tx_ref: ref,
              amount: record.amount,
              currency: record.currency,
              status: record.status === 'success' ? 'successful' : record.status,
              created_at: new Date().toISOString(),
              payment_type: 'card',
              customer: { email: 'admin@example.org' },
            },
          }),
        );
      }
      throw new Error('Unexpected external request: ' + url);
    });
    const module = await Test.createTestingModule({
      controllers: [BillingController, BillingWebhookController],
      providers: [
        BillingService,
        {
          provide: CompanyEmailService,
          useValue: {
            enqueueSubscription: jest.fn().mockResolvedValue(null),
            dispatch: jest.fn().mockResolvedValue(undefined),
          },
        },
        SubscriptionPricingService,
        {
          provide: RedisService,
          useValue: {
            get: async (key: string) => quoteCache.get(key) ?? null,
            set: async (key: string, value: unknown) => {
              quoteCache.set(key, value);
            },
          },
        },
        PaystackService,
        FlutterwaveService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: ConfigService,
          useValue: new ConfigService({
            PAYSTACK_SECRET_KEY: secret,
            FLUTTERWAVE_SECRET_KEY: 'platform-flutterwave-test',
            FLUTTERWAVE_WEBHOOK_SECRET: 'platform-webhook-test',
            WEB_URL: 'https://churchos.example',
          }),
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication({ rawBody: true });
    app.use((req: Request, _res: Response, next: NextFunction) => {
      const role = String(req.headers['x-test-role'] || '');
      if (role)
        Object.assign(req, {
          user: { id: 'actor', sub: 'actor', email: 'admin@example.org' },
          profile: {
            church_id: String(req.headers['x-test-church']),
            role,
            roles: [role],
            status: 'active',
            permissions:
              role === 'readonly'
                ? ['billing:read']
                : role === 'super_admin'
                  ? generateAllPermissions().map((p) => p.name)
                  : DEFAULT_PERMISSION_MATRIX[role] || [],
          },
        });
      next();
    });
    app.useGlobalGuards(new PermissionsGuard(new Reflector(), {} as PermissionsService, prisma));
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });
  afterAll(async () => {
    await app?.close();
    fetchSpy?.mockRestore();
    await prisma?.subscriptionPayment.deleteMany({
      where: { church_id: { in: [churchA, churchB] } },
    });
    await prisma?.church.deleteMany({
      where: { id: { in: [churchA, churchB, churchUnconfigured] } },
    });
    await prisma?.$disconnect();
  });
  it('requires authentication and administrator billing permissions', async () => {
    expect((await request('/billing/subscription', 'GET', undefined, '')).status).toBe(401);
    for (const role of [
      'member',
      'usher',
      'treasurer',
      'senior_pastor',
      'department_head',
      'cell_leader',
    ])
      expect((await request('/billing/subscription', 'GET', undefined, role)).status).toBe(403);
    expect((await request('/billing/subscription', 'GET', undefined, 'super_admin')).status).toBe(
      200,
    );
    expect((await request('/billing/subscription', 'GET', undefined, 'readonly')).status).toBe(403);
    expect(
      (
        await request(
          '/billing/checkout',
          'POST',
          { plan: 'essentials', cycle: 'monthly', gateway: 'flutterwave' },
          'readonly',
        )
      ).status,
    ).toBe(403);
  });
  it('rejects browser-supplied prices and unsupported Enterprise self-service', async () => {
    for (const extra of [{ amount: 1 }, { churchId: churchB }, { plan: 'enterprise' }])
      expect(
        (
          await request('/billing/checkout', 'POST', {
            plan: 'essentials',
            cycle: 'monthly',
            gateway: 'flutterwave',
            ...extra,
          })
        ).status,
      ).toBe(400);
  });
  it('requires enrollment and leaves all unconfigured workspaces unpaid', async () => {
    expect(await result(await request('/billing/subscription'))).toMatchObject({
      active: false,
      gateways: ['flutterwave'],
    });
    expect(
      await result(
        await request(
          '/billing/subscription',
          'GET',
          undefined,
          'church_admin',
          churchUnconfigured,
        ),
      ),
    ).toMatchObject({ active: false, subscription: null });
  });
  it('serializes concurrent checkout and resumes the same hosted transaction', async () => {
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        request('/billing/checkout', 'POST', {
          plan: 'essentials',
          cycle: 'monthly',
          gateway: 'flutterwave',
        }),
      ),
    );
    expect(responses.some((r) => r.status === 201)).toBe(true);
    expect(responses.every((r) => [201, 409].includes(r.status))).toBe(true);
    expect(
      await prisma.subscriptionPayment.count({ where: { church_id: churchA, status: 'pending' } }),
    ).toBe(1);
    const checkout = await result(
      await request('/billing/checkout', 'POST', {
        plan: 'essentials',
        cycle: 'monthly',
        gateway: 'flutterwave',
      }),
    );
    expect(checkout.authorizationUrl).toMatch(/^https:\/\/checkout.flutterwave.com\//);
    expect(providerPayments.size).toBe(1);
  });
  it('isolates payment references by tenant and validates amount/currency before activation', async () => {
    const payment = await prisma.subscriptionPayment.findFirstOrThrow({
      where: { church_id: churchA },
    });
    expect(
      (
        await request(
          '/billing/verify',
          'POST',
          { reference: payment.reference },
          'church_admin',
          churchB,
        )
      ).status,
    ).toBe(404);
    const record = providerPayments.get(payment.reference)!;
    record.amount = 1;
    expect(
      (await request('/billing/verify', 'POST', { reference: payment.reference })).status,
    ).toBe(400);
    record.amount = payment.amount;
    record.currency = 'USD';
    expect(
      (await request('/billing/verify', 'POST', { reference: payment.reference })).status,
    ).toBe(400);
    record.currency = 'NGN';
    expect(
      (await prisma.platformSubscription.findUniqueOrThrow({ where: { church_id: churchA } }))
        .paid_until,
    ).toBeNull();
  });
  it('rejects bad signatures and activates once across concurrent callback/browser verification', async () => {
    const payment = await prisma.subscriptionPayment.findFirstOrThrow({
      where: { church_id: churchA },
    });
    const raw = JSON.stringify({ event: 'charge.completed', data: { tx_ref: payment.reference } });
    const webhook = (signature: string) =>
      originalFetch(base + '/billing/webhooks/flutterwave', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'flutterwave-signature': signature },
        body: raw,
      });
    expect((await webhook('bad')).status).toBe(401);
    const signed = createHmac('sha256', 'platform-webhook-test').update(raw).digest('base64');
    const responses = await Promise.all([
      webhook(signed),
      ...Array.from({ length: 4 }, () =>
        request('/billing/verify', 'POST', { reference: payment.reference }),
      ),
    ]);
    expect(responses.every((r) => r.status === 200)).toBe(true);
    const activated = await prisma.platformSubscription.findUniqueOrThrow({
      where: { church_id: churchA },
    });
    expect(activated.paid_until!.getTime()).toBeGreaterThan(Date.now() + 27 * 86400000);
    expect(activated.paid_until!.getTime()).toBeLessThan(Date.now() + 32 * 86400000);
    await webhook(signed);
    expect(
      (await prisma.platformSubscription.findUniqueOrThrow({ where: { church_id: churchA } }))
        .paid_until,
    ).toEqual(activated.paid_until);
    expect(
      (
        await request('/billing/checkout', 'POST', {
          plan: 'essentials',
          cycle: 'monthly',
          gateway: 'flutterwave',
        })
      ).status,
    ).toBe(409);
  });
  it('uses the independent ChurchOS Flutterwave account and signed confirmation for yearly subscriptions', async () => {
    const checkout = await result(
      await request(
        '/billing/checkout',
        'POST',
        { plan: 'community', cycle: 'annual', gateway: 'flutterwave' },
        'church_admin',
        churchB,
      ),
    );
    expect(checkout.authorizationUrl).toMatch(/^https:\/\/checkout.flutterwave.com\//);
    const payment = await prisma.subscriptionPayment.findUniqueOrThrow({
      where: { reference: checkout.reference },
    });
    expect(payment.amount).toBe(216000);
    expect(payment.gateway).toBe('flutterwave');
    const raw = JSON.stringify({ event: 'charge.completed', data: { tx_ref: payment.reference } });
    const signature = createHmac('sha256', 'platform-webhook-test').update(raw).digest('base64');
    const response = await originalFetch(base + '/billing/webhooks/flutterwave', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'flutterwave-signature': signature },
      body: raw,
    });
    expect(response.status).toBe(200);
    const active = await prisma.platformSubscription.findUniqueOrThrow({
      where: { church_id: churchB },
    });
    expect(active).toMatchObject({ plan: 'community', cycle: 'annual' });
    expect(active.paid_until!.getTime()).toBeGreaterThan(Date.now() + 364 * 86400000);
  });

  it('recovers a pending then failed payment that succeeds without a callback or webhook', async () => {
    const recoveryChurch = randomUUID();
    const previousWorkers = process.env.ENABLE_QUEUE_WORKERS;
    process.env.ENABLE_QUEUE_WORKERS = 'true';
    try {
      await prisma.church.create({
        data: { id: recoveryChurch, name: 'Payment recovery fixture' },
      });
      await prisma.platformSubscription.create({
        data: { church_id: recoveryChurch, plan: 'essentials', cycle: 'monthly' },
      });
      const checkout = await result(
        await request(
          '/billing/checkout',
          'POST',
          {
            plan: 'essentials',
            cycle: 'monthly',
            gateway: 'flutterwave',
          },
          'church_admin',
          recoveryChurch,
        ),
      );
      const record = providerPayments.get(checkout.reference)!;
      record.status = 'pending';
      const pending = await result(
        await request(
          '/billing/verify',
          'POST',
          { reference: checkout.reference },
          'church_admin',
          recoveryChurch,
        ),
      );
      expect(pending).toMatchObject({
        active: false,
        verification: { reference: checkout.reference, status: 'pending' },
      });
      record.status = 'failed';
      await request(
        '/billing/verify',
        'POST',
        { reference: checkout.reference },
        'church_admin',
        recoveryChurch,
      );
      expect(
        (
          await prisma.subscriptionPayment.findUniqueOrThrow({
            where: { reference: checkout.reference },
          })
        ).status,
      ).toBe('failed');
      record.status = 'success';
      const recovery = new PaymentReconciliationService(
        prisma,
        app.get(BillingService),
        app.get(FlutterwaveService),
        { isConfigured: () => false } as never,
        { reconcilePayment: async () => {}, reconcileAdjustments: async () => {} } as never,
      );
      await recovery.reconcile();
      const confirmed = await result(
        await request(
          '/billing/verify',
          'POST',
          { reference: checkout.reference },
          'church_admin',
          recoveryChurch,
        ),
      );
      expect(confirmed).toMatchObject({
        active: true,
        verification: {
          reference: checkout.reference,
          status: 'success',
          application_status: 'applied',
        },
      });
      const paidUntil = (
        await prisma.platformSubscription.findUniqueOrThrow({
          where: { church_id: recoveryChurch },
        })
      ).paid_until;
      await recovery.reconcile();
      expect(
        (
          await prisma.platformSubscription.findUniqueOrThrow({
            where: { church_id: recoveryChurch },
          })
        ).paid_until,
      ).toEqual(paidUntil);
    } finally {
      if (previousWorkers === undefined) delete process.env.ENABLE_QUEUE_WORKERS;
      else process.env.ENABLE_QUEUE_WORKERS = previousWorkers;
      await prisma.subscriptionPayment.deleteMany({ where: { church_id: recoveryChurch } });
      await prisma.church.deleteMany({ where: { id: recoveryChurch } });
    }
  });
  it('removes the obsolete messaging table and permission family', async () => {
    expect(
      await prisma.$queryRaw`SELECT to_regclass('public.messaging_integrations')::text AS obsolete`,
    ).toEqual([{ obsolete: null }]);
    expect(await prisma.permission.count({ where: { resource: 'messaging_integrations' } })).toBe(
      0,
    );
  });
  it('enforces database enum types and hides billing tables from browser database roles', async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE platform_subscriptions SET plan = 'free' WHERE church_id = '${churchB}'`,
      ),
    ).rejects.toThrow();
    const rows = await prisma.$queryRaw<
      { table_name: string; allowed: boolean }[]
    >`SELECT t AS table_name, has_table_privilege('authenticated',t,'SELECT') AS allowed FROM unnest(ARRAY['platform_subscriptions','subscription_payments']) t`;
    expect(rows.every((r) => !r.allowed)).toBe(true);
  });
});
