import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PrismaService } from '../../src/prisma/prisma.service';
import { CompanyEmailService } from '../../src/company-email/company-email.service';
import { BillingService } from '../../src/billing/billing.service';

// All provider calls are local mocks. Only TEST_DATABASE_URL's isolated database is used.
describe('Company email transaction and delivery integrity', () => {
  const prisma = new PrismaService();
  const churchIds: string[] = [];
  const mail = { sendEmail: jest.fn().mockResolvedValue('provider-accepted') };
  const config = new ConfigService({
    WEB_URL: 'https://belivrhq.example',
    RESEND_API_KEY: 'test-fixture',
    RESEND_FROM: 'team@belivrhq.example',
  });
  const company = new CompanyEmailService(prisma, mail as never, config);
  const gateway = { isConfigured: () => true, verifyTransaction: jest.fn() };
  const billing = new BillingService(
    prisma,
    config,
    gateway as never,
    { ...gateway, name: 'flutterwave' } as never,
    {} as never,
    company,
  );
  beforeEach(() => {
    mail.sendEmail.mockReset().mockResolvedValue('provider-accepted');
  });
  afterAll(async () => {
    for (const id of churchIds) {
      await prisma.companyEmailNotification.deleteMany({ where: { church_id: id } });
      await prisma.subscriptionPayment.deleteMany({ where: { church_id: id } });
      await prisma.church.delete({ where: { id } });
    }
    await prisma.$disconnect();
  });
  async function church(previousPeriod = false) {
    const row = await prisma.church.create({
      data: { name: 'Company email test', email: 'church@example.org' },
    });
    churchIds.push(row.id);
    await prisma.platformSubscription.create({
      data: {
        church_id: row.id,
        plan: 'essentials',
        cycle: 'monthly',
        paid_until: previousPeriod ? new Date(0) : null,
      },
    });
    return row;
  }
  async function enqueueWelcome(churchId: string, eventId = randomUUID()) {
    return prisma.$transaction((tx) =>
      company.enqueueWelcome(tx, {
        kind: 'welcome',
        userId: eventId,
        churchId,
        email: 'admin@example.org',
        firstName: 'Grace',
        churchName: 'Company email test',
        plan: 'essentials',
        cycle: 'monthly',
      }),
    );
  }
  it('rolls the notification back with a failed registration transaction', async () => {
    const record = await church();
    await expect(
      prisma.$transaction(async (tx) => {
        await company.enqueueWelcome(tx, {
          kind: 'welcome',
          userId: randomUUID(),
          churchId: record.id,
          email: 'admin@example.org',
          churchName: record.name,
          plan: 'essentials',
          cycle: 'monthly',
        });
        throw new Error('Registration rolled back');
      }),
    ).rejects.toThrow('Registration rolled back');
    expect(await prisma.companyEmailNotification.count({ where: { church_id: record.id } })).toBe(
      0,
    );
    expect(mail.sendEmail).not.toHaveBeenCalled();
  });
  it('deduplicates registration events and atomically claims sends across workers', async () => {
    const record = await church();
    const eventId = randomUUID();
    const key = await enqueueWelcome(record.id, eventId);
    await enqueueWelcome(record.id, eventId);
    await Promise.all([company.dispatch(key), company.dispatch(key), company.dispatch(key)]);
    expect(mail.sendEmail).toHaveBeenCalledTimes(1);
    expect(
      await prisma.companyEmailNotification.count({
        where: { church_id: record.id, status: 'sent' },
      }),
    ).toBe(1);
  });
  it.each([false, true])(
    'queues exactly one verified subscription email under callback races (renewal=%s)',
    async (previousPeriod) => {
      const record = await church(previousPeriod);
      const reference = 'BHQSUB_' + randomUUID().replace(/-/g, '');
      await prisma.subscriptionPayment.create({
        data: {
          reference,
          church_id: record.id,
          gateway: 'flutterwave',
          plan: 'essentials',
          cycle: 'monthly',
          amount: 10,
          currency: 'USD',
          billing_email: 'payer@example.org',
        },
      });
      gateway.verifyTransaction.mockResolvedValue({
        reference,
        amount: 10,
        currency: 'USD',
        status: 'success',
      });
      await Promise.all([
        billing.reconcilePayment(record.id, reference),
        billing.reconcilePayment(record.id, reference),
      ]);
      await billing.reconcilePayment(record.id, reference);
      const notifications = await prisma.companyEmailNotification.findMany({
        where: { church_id: record.id },
      });
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toMatchObject({
        kind: previousPeriod ? 'renewal' : 'activation',
        to_email: 'payer@example.org',
        status: 'sent',
      });
      expect(notifications[0].text).toContain('Amount paid: USD');
      expect(mail.sendEmail).toHaveBeenCalledTimes(1);
      expect(
        (await prisma.subscriptionPayment.findUniqueOrThrow({ where: { reference } }))
          .application_status,
      ).toBe('applied');
    },
  );
  it('retains failed sends and reuses the exact payload and provider key when recovering', async () => {
    const record = await church();
    const key = await enqueueWelcome(record.id);
    mail.sendEmail.mockRejectedValueOnce(new Error('Provider temporarily unavailable'));
    await company.dispatch(key);
    expect(
      await prisma.companyEmailNotification.findUniqueOrThrow({ where: { event_key: key } }),
    ).toMatchObject({ status: 'pending', attempts: 1, last_error: 'provider_not_accepted' });
    await prisma.companyEmailNotification.update({
      where: { event_key: key },
      data: { available_at: new Date(0) },
    });
    const previousWorkerSetting = process.env.ENABLE_QUEUE_WORKERS;
    process.env.ENABLE_QUEUE_WORKERS = 'true';
    try {
      await company.retryPending();
    } finally {
      if (previousWorkerSetting === undefined) delete process.env.ENABLE_QUEUE_WORKERS;
      else process.env.ENABLE_QUEUE_WORKERS = previousWorkerSetting;
    }
    expect(mail.sendEmail.mock.calls[0]).toEqual(mail.sendEmail.mock.calls[1]);
    expect(
      await prisma.companyEmailNotification.findUniqueOrThrow({ where: { event_key: key } }),
    ).toMatchObject({ status: 'sent', attempts: 2, provider_id: 'provider-accepted' });
  });
  it('prevents ordinary database roles from reading queued company emails', async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    const client = await pool.connect();
    try {
      for (const role of ['anon', 'authenticated']) {
        await client.query(`SET ROLE ${role}`);
        await expect(
          client.query('SELECT * FROM public.company_email_notifications'),
        ).rejects.toMatchObject({ code: '42501' });
        await client.query('RESET ROLE');
      }
    } finally {
      await client.query('RESET ROLE');
      client.release();
      await pool.end();
    }
  });
});
