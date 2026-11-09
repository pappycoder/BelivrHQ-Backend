import { EmailDeliveryService } from '../../../src/communication/email-delivery.service';
import { ConfigService } from '@nestjs/config';
import { companyEmail, CompanyEmailKind } from '../../../src/company-email/company-email.templates';
import { CompanyEmailService } from '../../../src/company-email/company-email.service';
import { createPrismaMock } from '../../helpers/prisma-mock.helper';

const input = {
  churchName: 'Grace Church',
  firstName: 'Grace',
  plan: 'essentials' as const,
  cycle: 'monthly' as const,
  amount: 10,
  currency: 'USD',
  reference: 'BHQSUB_example',
  paidUntil: new Date('2026-11-22T12:00:00Z'),
};

describe('BelivrHQ company email presentation', () => {
  it.each(['welcome', 'activation', 'renewal', 'upgrade'] as CompanyEmailKind[])(
    'renders a branded %s email with a plain-text equivalent',
    (kind) => {
      const mail = companyEmail({ ...input, kind }, 'https://belivrhq.example');
      expect(mail.html).toContain('BelivrHQ');
      expect(mail.html).toContain('#c8f169');
      expect(mail.html).toContain('#123c35');
      expect(mail.html).toContain('Grace Church');
      expect(mail.html).toContain('https://belivrhq.example/');
      expect(mail.text).toContain('Essentials');
      expect(mail.text).toContain('Monthly');
      if (kind === 'welcome') {
        expect(mail.text).toContain('complete payment to activate');
        expect(mail.html).not.toContain('Amount paid');
        expect(mail.subject).not.toContain('is active');
      } else {
        expect(mail.text).toContain('Amount paid: USD');
        expect(mail.text).toContain('BHQSUB_example');
        expect(mail.text).toContain('22 November 2026');
      }
    },
  );
  it('escapes account-supplied text and uses only configured site links', () => {
    const mail = companyEmail(
      {
        ...input,
        kind: 'welcome',
        firstName: '<script>bad()</script>',
        churchName: '<img src=x onerror=bad()> & "Church"',
      },
      'https://belivrhq.example',
    );
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).not.toContain('<img src=x');
    expect(mail.html).toContain('&lt;script&gt;');
    expect(() => companyEmail({ ...input, kind: 'welcome' }, 'javascript:alert(1)')).toThrow();
  });
  it('preserves email verification and distinguishes upgrades from renewals', () => {
    expect(
      companyEmail(
        { ...input, kind: 'welcome', requiresEmailConfirmation: true },
        'https://belivrhq.example',
      ).text,
    ).toContain('Complete the email verification');
    expect(companyEmail({ ...input, kind: 'upgrade' }, 'https://belivrhq.example').text).toContain(
      'billing cycle and renewal date stay the same',
    );
    expect(companyEmail({ ...input, kind: 'renewal' }, 'https://belivrhq.example').text).toContain(
      'renewal is manual',
    );
  });
});

describe('Persistent company email dispatch', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let email: { sendEmail: jest.Mock };
  let service: CompanyEmailService;
  const row = {
    id: 'notification-id',
    event_key: 'registration/user',
    to_email: 'admin@example.org',
    from_email: 'BelivrHQ <team@example.org>',
    subject: 'Welcome',
    html: '<p>Welcome</p>',
    text: 'Welcome',
    status: 'pending',
    sent_at: null,
    attempts: 0,
    available_at: new Date(0),
    lease_token: null,
    lease_until: null,
    first_attempt_at: null,
  };
  beforeEach(() => {
    prisma = createPrismaMock();
    prisma.companyEmailNotification.findUnique.mockResolvedValue({ ...row });
    prisma.companyEmailNotification.updateMany.mockResolvedValue({ count: 1 });
    email = { sendEmail: jest.fn().mockResolvedValue('provider-id') };
    service = new CompanyEmailService(
      prisma as never,
      email as never,
      new ConfigService({
        RESEND_API_KEY: 'test-key',
        RESEND_FROM: 'team@example.org',
        WEB_URL: 'https://belivrhq.example',
      }),
    );
  });
  it('uses the organization sender and a stable provider idempotency key', async () => {
    await service.dispatch(row.event_key);
    expect(email.sendEmail).toHaveBeenCalledWith(
      row.to_email,
      row.subject,
      row.html,
      '',
      undefined,
      { text: row.text, from: row.from_email, idempotencyKey: 'churchos-account-notification-id' },
    );
    expect(prisma.companyEmailNotification.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'sent',
          provider_id: 'provider-id',
          sent_at: expect.any(Date),
        }),
      }),
    );
  });
  it('does not send if another worker already holds the claim', async () => {
    prisma.companyEmailNotification.updateMany.mockResolvedValueOnce({ count: 0 });
    await service.dispatch(row.event_key);
    expect(email.sendEmail).not.toHaveBeenCalled();
  });
  it('never resends an already accepted message', async () => {
    prisma.companyEmailNotification.findUnique.mockResolvedValue({
      ...row,
      sent_at: new Date(),
      status: 'sent',
    });
    await service.dispatch(row.event_key);
    expect(email.sendEmail).not.toHaveBeenCalled();
  });
  it('retains failures for retry without failing account or payment requests', async () => {
    email.sendEmail.mockRejectedValue(new Error('provider error with secret details'));
    await expect(service.dispatch(row.event_key)).resolves.toBeUndefined();
    expect(prisma.companyEmailNotification.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'pending',
          last_error: 'provider_not_accepted',
          lease_token: null,
          available_at: expect.any(Date),
        }),
      }),
    );
  });
  it('does not risk resending outside the provider deduplication window', async () => {
    prisma.companyEmailNotification.findUnique.mockResolvedValue({
      ...row,
      first_attempt_at: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });
    await service.dispatch(row.event_key);
    expect(email.sendEmail).not.toHaveBeenCalled();
    expect(prisma.companyEmailNotification.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'failed', last_error: 'delivery_window_expired' }),
      }),
    );
  });
  it('keeps notifications pending without consuming attempts when sender credentials are missing', async () => {
    const unconfigured = new CompanyEmailService(
      prisma as never,
      email as never,
      new ConfigService({ WEB_URL: 'https://belivrhq.example' }),
    );
    await unconfigured.dispatch(row.event_key);
    expect(email.sendEmail).not.toHaveBeenCalled();
    expect(prisma.companyEmailNotification.updateMany).not.toHaveBeenCalled();
  });
  it('stores an immutable welcome snapshot transactionally and deduplicates by registration', async () => {
    prisma.companyEmailNotification.createMany.mockResolvedValue({ count: 1 });
    await service.enqueueWelcome(prisma as never, {
      ...input,
      kind: 'welcome',
      userId: 'user',
      churchId: 'church',
      email: 'admin@example.org',
    });
    expect(prisma.companyEmailNotification.createMany).toHaveBeenCalledWith({
      skipDuplicates: true,
      data: [
        expect.objectContaining({
          event_key: 'registration/user',
          kind: 'welcome',
          to_email: 'admin@example.org',
          from_email: 'BelivrHQ <team@example.org>',
          text: expect.stringContaining('complete payment to activate'),
        }),
      ],
    });
  });
  it.each([
    [true, 'activation'],
    [false, 'renewal'],
  ] as const)(
    'records the verified payer and the correct billing event: first=%s',
    async (first, kind) => {
      Object.assign(prisma.church, {
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ name: 'Grace Church', email: 'old-admin@example.org' }),
      });
      await service.enqueueSubscription(
        prisma as never,
        {
          ...input,
          reference: 'BHQSUB_ref',
          church_id: 'church',
          billing_email: 'payer@example.org',
          intent: 'renewal',
        } as never,
        first,
        input.paidUntil,
      );
      expect(prisma.companyEmailNotification.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: [
            expect.objectContaining({
              event_key: 'subscription/BHQSUB_ref',
              to_email: 'payer@example.org',
              kind,
            }),
          ],
        }),
      );
    },
  );
});

describe('Organization email transport', () => {
  it('sends the branded sender, text fallback and stable idempotency header without using a church account', async () => {
    const prisma = createPrismaMock();
    const accounts = { resolve: jest.fn() };
    const sender = new EmailDeliveryService(
      prisma as never,
      {} as never,
      new ConfigService({ RESEND_API_KEY: 'test-key', RESEND_FROM: 'system@example.org' }),
      accounts as never,
    );
    const provider = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ id: 'accepted-id' }), { status: 200 }));
    try {
      await expect(
        sender.sendEmail('admin@example.org', 'Welcome', '<p>Welcome</p>', '', undefined, {
          text: 'Welcome',
          from: 'BelivrHQ <team@example.org>',
          idempotencyKey: 'company/event',
        }),
      ).resolves.toBe('accepted-id');
      const options = provider.mock.calls[0][1]!;
      expect(options.headers).toEqual(
        expect.objectContaining({ 'Idempotency-Key': 'company/event' }),
      );
      expect(JSON.parse(String(options.body))).toMatchObject({
        from: 'BelivrHQ <team@example.org>',
        to: ['admin@example.org'],
        text: 'Welcome',
      });
      expect(accounts.resolve).not.toHaveBeenCalled();
      expect(prisma.message.create).not.toHaveBeenCalled();
    } finally {
      provider.mockRestore();
    }
  });
});
