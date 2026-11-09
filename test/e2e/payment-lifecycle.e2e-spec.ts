import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../src/prisma/prisma.service';
import { BillingService } from '../../src/billing/billing.service';
import { GivingService } from '../../src/giving/giving.service';
import { churchEntitlements } from '../../src/billing/entitlements';
import { parsePaymentEvent } from '../../src/giving/services/payment-lifecycle';
import { resolvePaymentAccess } from '../../src/billing/payment-access';

jest.mock('jose', () => ({}));
describe('Payment lifecycle with PostgreSQL', () => {
  const prisma = new PrismaService();
  const churches: string[] = [];
  const verification = jest.fn();
  const provider = {
    name: 'flutterwave',
    isConfigured: () => true,
    verifyTransaction: verification,
    validateWebhookSignature: (_raw: string, signature: string) => signature === 'valid',
    mapChannelToPaymentMethod: () => 'card',
    parseWebhookEvent: (raw: string) => ({
      ...parsePaymentEvent('flutterwave', JSON.parse(raw)),
      rawData: JSON.parse(raw),
    }),
  };
  const emails = { dispatch: jest.fn(), enqueueSubscription: jest.fn() };
  const billing = new BillingService(
    prisma,
    new ConfigService(),
    provider as never,
    provider as never,
    { gatewayCurrencies: () => ['NGN'] } as never,
    emails as never,
  );
  const giving = new GivingService(
    prisma,
    { log: jest.fn() } as never,
    new Map([['flutterwave', provider]]) as never,
    {
      getCategoryPrefix: () => 'OFF',
      generateReceiptNumber: () => `receipt-${randomUUID()}`,
    } as never,
    { createNotification: jest.fn() } as never,
    {} as never,
    {} as never,
    { historical: async () => provider } as never,
  );
  async function church() {
    const id = randomUUID();
    churches.push(id);
    await prisma.church.create({ data: { id, name: 'Lifecycle test' } });
    await prisma.platformSubscription.create({
      data: { church_id: id, plan: 'essentials', cycle: 'monthly' },
    });
    return id;
  }
  async function subscription(churchId: string, extras: Record<string, unknown> = {}) {
    const reference = `COSUB_${randomUUID().replaceAll('-', '')}`;
    return prisma.subscriptionPayment.create({
      data: {
        reference,
        church_id: churchId,
        gateway: 'flutterwave',
        plan: 'essentials',
        cycle: 'monthly',
        amount: 100,
        currency: 'NGN',
        ...extras,
      },
    });
  }
  function verified(reference: string, status = 'success') {
    verification.mockResolvedValue({
      reference,
      status,
      amount: 100,
      currency: 'NGN',
      channel: 'card',
      providerTransactionId: reference,
    });
  }
  function adjustment(
    reference: string,
    id: number,
    amount: number,
    status: string,
    event = 'refund.completed',
  ) {
    return JSON.stringify({
      event,
      data: { tx_ref: reference, id, amount_refunded: amount, amount, currency: 'NGN', status },
    });
  }
  beforeAll(() => prisma.$connect());
  afterAll(async () => {
    await prisma.ticket.deleteMany({ where: { event: { church_id: { in: churches } } } });
    await prisma.eventRegistration.deleteMany({ where: { church_id: { in: churches } } });
    await prisma.transaction.deleteMany({ where: { church_id: { in: churches } } });
    await prisma.event.deleteMany({ where: { church_id: { in: churches } } });
    await prisma.member.deleteMany({ where: { church_id: { in: churches } } });
    await prisma.subscriptionPayment.deleteMany({ where: { church_id: { in: churches } } });
    await prisma.auditLog.deleteMany({ where: { church_id: { in: churches } } });
    await prisma.church.deleteMany({ where: { id: { in: churches } } });
    await prisma.$disconnect();
  });
  beforeEach(() => jest.clearAllMocks());
  it('recovers a failed charge and grants a period only once under concurrent settlement', async () => {
    const id = await church(),
      payment = await subscription(id, { status: 'failed' });
    verified(payment.reference);
    await Promise.all([
      billing.reconcilePayment(id, payment.reference),
      billing.reconcilePayment(id, payment.reference),
    ]);
    const saved = await prisma.subscriptionPayment.findFirstOrThrow({
      where: { reference: payment.reference, church_id: id },
    });
    expect(saved).toMatchObject({ status: 'success', application_status: 'applied' });
    const access = await churchEntitlements(prisma, id);
    expect(access.active).toBe(true);
    expect((access.subscription!.access_grants as { grants: unknown[] }).grants).toHaveLength(1);
    expect(emails.enqueueSubscription).toHaveBeenCalledTimes(1);
  });
  it('keeps pending and failed refunds intact, deduplicates partial refunds and holds access', async () => {
    const id = await church(),
      payment = await subscription(id);
    verified(payment.reference);
    await billing.reconcilePayment(id, payment.reference);
    await billing.webhook('flutterwave', adjustment(payment.reference, 1, 30, 'failed'), 'valid');
    expect((await churchEntitlements(prisma, id)).active).toBe(true);
    await billing.webhook(
      'flutterwave',
      adjustment(payment.reference, 2, 30, 'completed'),
      'valid',
    );
    expect((await churchEntitlements(prisma, id)).active).toBe(true);
    const raw = adjustment(payment.reference, 2, 30, 'completed-mpgs');
    await Promise.all([
      billing.webhook('flutterwave', raw, 'valid'),
      billing.webhook('flutterwave', raw, 'valid'),
    ]);
    const saved = await prisma.subscriptionPayment.findFirstOrThrow({
      where: { church_id: id, reference: payment.reference },
    });
    expect(saved.lifecycle).toMatchObject({ refundedAmount: 30, access: 'review' });
    expect((await churchEntitlements(prisma, id)).active).toBe(false);
    expect(await prisma.$queryRaw`SELECT churchos_has_feature(${id}, 'giving') AS allowed`).toEqual(
      [{ allowed: false }],
    );
    await billing.webhook('flutterwave', adjustment(payment.reference, 2, 30, 'failed'), 'valid');
    expect((await churchEntitlements(prisma, id)).active).toBe(false);
  });
  it('revokes only the refunded grant and preserves a separate renewal at its original dates', async () => {
    const id = await church(),
      first = await subscription(id);
    verified(first.reference);
    await billing.reconcilePayment(id, first.reference);
    const second = await subscription(id);
    verified(second.reference);
    await billing.reconcilePayment(id, second.reference);
    await billing.webhook(
      'flutterwave',
      adjustment(first.reference, 3, 100, 'completed-bank-transfer'),
      'valid',
    );
    const saved = await prisma.platformSubscription.findUniqueOrThrow({ where: { church_id: id } });
    const grants = (
      saved.access_grants as { grants: { reference: string; start: string; end: string }[] }
    ).grants;
    const renewal = grants.find((grant) => grant.reference === second.reference)!;
    expect((await churchEntitlements(prisma, id)).active).toBe(false);
    expect(
      resolvePaymentAccess(saved.access_grants, new Date(Date.parse(renewal.start) + 1000)),
    ).toMatchObject({ active: true, selected: { reference: second.reference, end: renewal.end } });
  });
  it('closes a pending checkout without pretending no money can arrive, and sends late success to review', async () => {
    const id = await church(),
      payment = await subscription(id);
    await billing.closeCheckout(id, payment.reference);
    await expect(subscription(id)).resolves.toBeDefined();
    verified(payment.reference);
    await billing.reconcilePayment(id, payment.reference);
    expect(
      await prisma.subscriptionPayment.findFirstOrThrow({
        where: { church_id: id, reference: payment.reference },
      }),
    ).toMatchObject({
      status: 'success',
      application_status: 'review',
      checkout_close_reason: 'cancelled',
    });
    expect((await churchEntitlements(prisma, id)).active).toBe(false);
  });
  it('allows only a ChurchOS reviewer to release a partial-refund hold and preserves that decision on duplicate callbacks', async () => {
    const id = await church(),
      payment = await subscription(id);
    verified(payment.reference);
    await billing.reconcilePayment(id, payment.reference);
    const raw = adjustment(payment.reference, 5, 20, 'completed-mpgs');
    await billing.webhook('flutterwave', raw, 'valid');
    await expect(
      billing.reviewPayment(
        id,
        { id: 'admin', roles: ['church_admin'] },
        payment.reference,
        'release',
        'Reviewed provider evidence',
      ),
    ).rejects.toThrow('ChurchOS review');
    await billing.reviewPayment(
      id,
      { id: 'operator', roles: ['super_admin'] },
      payment.reference,
      'release',
      'Reviewed provider evidence',
    );
    await billing.webhook('flutterwave', raw, 'valid');
    expect((await churchEntitlements(prisma, id)).active).toBe(true);
    await billing.webhook(
      'flutterwave',
      adjustment(payment.reference, 6, 80, 'completed-mpgs'),
      'valid',
    );
    expect((await churchEntitlements(prisma, id)).active).toBe(false);
  });
  it('issues one ticket after late success and invalidates it atomically with a full refund', async () => {
    const id = await church();
    await prisma.platformSubscription.update({
      where: { church_id: id },
      data: { plan: 'network', paid_until: new Date(Date.now() + 86400000) },
    });
    const member = await prisma.member.create({
      data: { church_id: id, first_name: 'Test', last_name: 'Member' },
    });
    const event = await prisma.event.create({
      data: {
        church_id: id,
        title: 'Paid event',
        start_date: new Date(),
        is_free: false,
        price: 100,
      },
    });
    const reference = `ticket-${randomUUID()}`;
    const payment = await prisma.transaction.create({
      data: {
        church_id: id,
        event_id: event.id,
        amount: 100,
        currency: 'NGN',
        status: 'failed',
        payment_gateway: 'flutterwave',
        payment_reference: reference,
      },
    });
    await prisma.eventRegistration.create({
      data: {
        church_id: id,
        event_id: event.id,
        member_id: member.id,
        payment_reference: reference,
        transaction_id: payment.id,
        payment_status: 'failed',
      },
    });
    verified(reference);
    await Promise.all([
      giving.reconcilePayment(id, reference),
      giving.reconcilePayment(id, reference),
    ]);
    expect(
      await prisma.ticket.count({
        where: { transaction_id: payment.id, event: { church_id: id } },
      }),
    ).toBe(1);
    await giving.handleWebhook(
      adjustment(reference, 9, 100, 'completed-mpgs'),
      'valid',
      'flutterwave',
    );
    expect(
      await prisma.ticket.findFirstOrThrow({
        where: { transaction_id: payment.id, event: { church_id: id } },
      }),
    ).toMatchObject({ status: 'refunded' });
    expect(
      await prisma.eventRegistration.findFirstOrThrow({
        where: { church_id: id, transaction_id: payment.id },
      }),
    ).toMatchObject({ payment_status: 'refunded' });
    await giving.reconcilePayment(id, reference);
    expect(
      await prisma.transaction.findFirstOrThrow({ where: { church_id: id, id: payment.id } }),
    ).toMatchObject({ status: 'reversed' });
  });
});
