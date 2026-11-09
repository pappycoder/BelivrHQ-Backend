import { ProviderTransportService } from '../../../src/integrations/provider-transport.service';
import { validateCredentials } from '../../../src/integrations/provider-catalog';

describe('Provider-specific authentication and delivery adapters', () => {
  const service = new ProviderTransportService();
  let fetchMock: jest.SpiedFunction<typeof fetch>;
  const response = (data: unknown, status = 200, headers?: Record<string, string>) =>
    new Response(JSON.stringify(data), { status, headers });
  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });
  it('rejects keys for the wrong provider, mixed payment modes, unexpected fields and unsafe addresses', () => {
    expect(() => validateCredentials('resend', { apiKey: 'SG.wrong.provider' })).toThrow();
    expect(() => validateCredentials('sendgrid', { apiKey: 're_wrong-provider' })).toThrow();
    expect(() =>
      validateCredentials('twilio', {
        accountSid: 'AC' + 'a'.repeat(32),
        authToken: 're_wrong-provider',
      }),
    ).toThrow();
    expect(() =>
      validateCredentials('paystack', { secretKey: 'sk_test_abcdef', publicKey: 'pk_live_abcdef' }),
    ).toThrow();
    expect(() =>
      validateCredentials('termii', { apiKey: 'secret-key', baseUrl: 'http://127.0.0.1' }),
    ).toThrow();
    expect(() =>
      validateCredentials('resend', { apiKey: 're_valid-test-key', secret: 'extra' }),
    ).toThrow();
  });
  it('handles valid, rejected and restricted credentials without claiming delivery was verified', async () => {
    fetchMock.mockResolvedValueOnce(response({ data: [] }));
    expect(
      (await service.verify({ provider: 'resend', credentials: { apiKey: 're_key' } })).status,
    ).toBe('verified');
    fetchMock.mockResolvedValueOnce(response({}, 401));
    expect(
      (await service.verify({ provider: 'resend', credentials: { apiKey: 're_key' } })).status,
    ).toBe('rejected');
    fetchMock.mockResolvedValueOnce(response({}, 403));
    expect(
      (await service.verify({ provider: 'resend', credentials: { apiKey: 're_key' } })).status,
    ).toBe('limited');
    expect(
      (await service.verify({ provider: 'termii', credentials: { apiKey: 'secret' } })).status,
    ).toBe('limited');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it('checks SendGrid mail.send scope and matching Twilio account identity', async () => {
    fetchMock.mockResolvedValueOnce(response({ scopes: ['mail.send'] }));
    expect(
      (await service.verify({ provider: 'sendgrid', credentials: { apiKey: 'SG.key' } })).status,
    ).toBe('verified');
    fetchMock.mockResolvedValueOnce(response({ scopes: [] }));
    expect(
      (await service.verify({ provider: 'sendgrid', credentials: { apiKey: 'SG.key' } })).status,
    ).toBe('rejected');
    fetchMock.mockResolvedValueOnce(response({ sid: 'different', status: 'active' }));
    expect(
      (
        await service.verify({
          provider: 'twilio',
          credentials: { accountSid: 'ACtest', authToken: 'secret' },
        })
      ).status,
    ).toBe('rejected');
  });
  it('uses provider-specific email senders, reply-to and attachments', async () => {
    const input = {
      from: 'church@example.org',
      to: 'member@example.org',
      senderName: 'Church office',
      replyTo: 'office@example.org',
      subject: 'Hello',
      text: 'Welcome',
      html: '<p>Welcome</p>',
      plainText: 'Welcome',
      attachment: { filename: 'receipt.pdf', content: Buffer.from('pdf') },
    };
    fetchMock.mockResolvedValueOnce(response({ id: 'resend-id' }));
    await service.deliver(
      { provider: 'resend', credentials: { apiKey: 're_secret' } },
      'email',
      input,
    );
    const resend = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(resend).toMatchObject({
      from: 'Church office <church@example.org>',
      reply_to: 'office@example.org',
      text: 'Welcome',
      attachments: [{ filename: 'receipt.pdf', content: 'cGRm' }],
    });
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 202, headers: { 'x-message-id': 'sendgrid-id' } }),
    );
    expect(
      await service.deliver(
        { provider: 'sendgrid', credentials: { apiKey: 'SG.secret.key' } },
        'email',
        input,
      ),
    ).toBe('sendgrid-id');
    expect(JSON.parse(fetchMock.mock.calls[1][1]?.body as string)).toMatchObject({
      from: { email: input.from, name: input.senderName },
      reply_to: { email: input.replyTo },
      content: [
        { type: 'text/plain', value: 'Welcome' },
        { type: 'text/html', value: '<p>Welcome</p>' },
      ],
    });
    fetchMock.mockResolvedValueOnce(response({ id: 'mailgun-id' }));
    await service.deliver(
      {
        provider: 'mailgun',
        credentials: { apiKey: 'key', domain: 'mail.example.org', region: 'eu' },
      },
      'email',
      input,
    );
    expect(fetchMock.mock.calls[2][0]).toBe(
      'https://api.eu.mailgun.net/v3/mail.example.org/messages',
    );
    expect((fetchMock.mock.calls[2][1]?.body as FormData).get('h:Reply-To')).toBe(input.replyTo);
    expect((fetchMock.mock.calls[2][1]?.body as FormData).get('text')).toBe('Welcome');
  });
  it('supports SMS and WhatsApp on one Twilio account with independent senders', async () => {
    const account = {
      provider: 'twilio' as const,
      credentials: { accountSid: 'ACtest', authToken: 'secret' },
    };
    fetchMock.mockImplementation(async () => response({ sid: 'SMtest' }));
    await service.deliver(account, 'sms', {
      from: '+12345678901',
      to: '+2348012345678',
      text: 'SMS',
    });
    await service.deliver(account, 'whatsapp', {
      from: '+12345678902',
      to: '+2348012345678',
      text: 'WhatsApp',
    });
    expect(
      new URLSearchParams(fetchMock.mock.calls[0][1]?.body as URLSearchParams).get('From'),
    ).toBe('+12345678901');
    expect(
      new URLSearchParams(fetchMock.mock.calls[1][1]?.body as URLSearchParams).get('From'),
    ).toBe('whatsapp:+12345678902');
  });
  it('connects live calls by ringing the staff phone and dialing the member; no text-to-speech', async () => {
    fetchMock.mockResolvedValue(response({ sid: 'CAtest' }));
    await service.deliver(
      { provider: 'twilio', credentials: { accountSid: 'ACtest', authToken: 'secret' } },
      'voice',
      { staffPhone: '+12345678901', from: '+12345678902', to: '+2348012345678', text: '' },
    );
    const form = fetchMock.mock.calls[0][1]?.body as URLSearchParams;
    expect(form.get('To')).toBe('+12345678901');
    expect(form.get('Twiml')).toContain('<Number>+2348012345678</Number>');
    expect(form.get('Twiml')).not.toContain('<Say>');
    expect(form.get('Twiml')).toContain('timeLimit="600"');
  });
  it('sends Meta WhatsApp through the configured phone ID and restricts transport timeout/redirects', async () => {
    fetchMock.mockResolvedValue(response({ messages: [{ id: 'wamid.test' }] }));
    expect(
      await service.deliver(
        { provider: 'meta', credentials: { phoneNumberId: '123456', accessToken: 'token' } },
        'whatsapp',
        { from: '', to: '+2348012345678', text: 'Hello' },
      ),
    ).toBe('wamid.test');
    expect(fetchMock.mock.calls[0][0]).toBe('https://graph.facebook.com/v23.0/123456/messages');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      redirect: 'error',
      signal: expect.any(AbortSignal),
    });
  });
  it('does not leak provider responses or transport errors containing keys', async () => {
    fetchMock.mockRejectedValueOnce(new Error('reflected-secret-key'));
    await expect(
      service.verify({ provider: 'resend', credentials: { apiKey: 'key' } }),
    ).rejects.toThrow('Provider request failed');
    fetchMock.mockResolvedValueOnce(response({ error: 'reflected-secret-key' }, 400));
    await expect(
      service.deliver({ provider: 'resend', credentials: { apiKey: 'key' } }, 'email', {
        from: 'from@example.org',
        to: 'to@example.org',
        text: 'Hello',
      }),
    ).rejects.toThrow('HTTP 400');
  });
});
