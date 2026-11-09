import { ConfigService } from '@nestjs/config';
import { EmailDeliveryService } from '../../../src/communication/email-delivery.service';
import { MessagingDeliveryService } from '../../../src/communication/messaging-delivery.service';

describe('Unified church messaging delivery', () => {
  const accounts = { resolve: jest.fn(), deliver: jest.fn() };
  const prisma = { message: { create: jest.fn() } };
  const config = new ConfigService({
    RESEND_API_KEY: 'organization-only',
    RESEND_FROM: 'system@belivrhq.example',
  });
  const email = new EmailDeliveryService(
    prisma as never,
    { get: jest.fn() } as never,
    config,
    accounts as never,
  );
  const messaging = new MessagingDeliveryService(prisma as never, accounts as never);
  let fetcher: jest.SpyInstance;
  beforeEach(() => {
    fetcher = jest.spyOn(global, 'fetch');
    jest.clearAllMocks();
    prisma.message.create.mockResolvedValue({ id: 'message-id' });
    accounts.resolve.mockImplementation(async (churchId: string, channel: string) => ({
      provider: channel === 'email' ? 'sendgrid' : 'twilio',
      accountId: churchId + '-account',
      credentials: { apiKey: 'private-church-key' },
      settings: { from: channel === 'email' ? 'office@church.example' : '+1234567890' },
    }));
    accounts.deliver.mockResolvedValue('provider-id');
  });
  afterAll(() => fetcher.mockRestore());
  it('routes email/SMS/WhatsApp/templates through independent channel accounts and preserves senders', async () => {
    await email.sendEmail('member@example.org', 'Subject', '<p>Body</p>', 'church-a');
    await messaging.sendSms('+2348012345678', 'SMS', 'church-b', 'parent-id');
    expect(await messaging.sendWhatsAppMessage('+2348012345678', 'WhatsApp', 'church-c')).toEqual({
      requestId: 'provider-id',
      provider: 'twilio',
      accountId: 'church-c-account',
    });
    await messaging.sendWhatsAppTemplate(
      '+2348012345678',
      'approved-template',
      { name: 'Member' },
      'church-d',
    );
    expect(accounts.resolve.mock.calls).toEqual([
      ['church-a', 'email'],
      ['church-b', 'sms'],
      ['church-c', 'whatsapp'],
      ['church-d', 'whatsapp'],
    ]);
    expect(accounts.deliver).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ accountId: 'church-a-account' }),
      'email',
      expect.objectContaining({ from: 'office@church.example', subject: 'Subject' }),
    );
    expect(prisma.message.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          church_id: 'church-b',
          parent_message_id: 'parent-id',
          metadata: expect.objectContaining({ integration_account_id: 'church-b-account' }),
        }),
      }),
    );
    expect(JSON.stringify(prisma.message.create.mock.calls)).not.toContain('private-church-key');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('uses a supplied plain-text alternative for a church email', async () => {
    await email.sendEmail(
      'member@example.org',
      'Receipt',
      '<p>Receipt details</p>',
      'church-a',
      undefined,
      { text: 'Receipt details' },
    );
    expect(accounts.deliver).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'church-a-account' }),
      'email',
      expect.objectContaining({
        from: 'office@church.example',
        text: 'Receipt details',
        plainText: 'Receipt details',
        html: '<p>Receipt details</p>',
      }),
    );
  });
  it('fails closed before delivery for missing, disabled or corrupt church credentials', async () => {
    accounts.resolve.mockRejectedValue(new Error('Account disabled'));
    await expect(
      email.sendEmail('member@example.org', 'Subject', 'Body', 'church-a'),
    ).rejects.toThrow('disabled');
    await expect(messaging.sendSms('+2348012345678', 'SMS', 'church-a')).rejects.toThrow(
      'disabled',
    );
    await expect(messaging.sendWhatsAppMessage('+2348012345678', 'WA', 'church-a')).rejects.toThrow(
      'disabled',
    );
    expect(accounts.deliver).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(prisma.message.create).not.toHaveBeenCalled();
  });
  it('uses only organization credentials for explicit authentication email and creates no tenant message', async () => {
    fetcher.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'org-message' }), { status: 200 }),
    );
    expect(await email.sendEmail('admin@example.org', 'Reset password', 'Reset link', '')).toBe(
      'org-message',
    );
    expect(accounts.resolve).not.toHaveBeenCalled();
    expect(prisma.message.create).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer organization-only' }),
        redirect: 'error',
        signal: expect.any(AbortSignal),
      }),
    );
  });
  it('does not report a platform email as sent without provider acceptance', async () => {
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));
    await expect(email.sendEmail('admin@example.org', 'Reset', 'Link', '')).rejects.toThrow(
      'did not confirm',
    );
  });
});
