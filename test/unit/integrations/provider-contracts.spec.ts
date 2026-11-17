import { ConfigService } from '@nestjs/config';
import {
  ProviderTransportService,
  ProviderAccountSecret,
} from '../../../src/integrations/provider-transport.service';

describe('Provider verification and transport failure contracts', () => {
  const service = new ProviderTransportService(
    new ConfigService({ PUBLIC_API_URL: 'https://api.example.org/' }),
  );
  let fetchMock: jest.SpiedFunction<typeof fetch>;
  const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });
  const cases: Array<{
    account: ProviderAccountSecret;
    url: string;
    response: unknown;
    authorization: string;
  }> = [
    {
      account: { provider: 'resend', credentials: { apiKey: 'synthetic' } },
      url: 'https://api.resend.com/domains',
      response: { data: [] },
      authorization: 'Bearer synthetic',
    },
    {
      account: { provider: 'sendgrid', credentials: { apiKey: 'synthetic' } },
      url: 'https://api.sendgrid.com/v3/scopes',
      response: { scopes: ['mail.send'] },
      authorization: 'Bearer synthetic',
    },
    {
      account: {
        provider: 'mailgun',
        credentials: { apiKey: 'synthetic', domain: 'mail.example.org', region: 'eu' },
      },
      url: 'https://api.eu.mailgun.net/v4/domains/mail.example.org',
      response: { domain: { name: 'mail.example.org' } },
      authorization: `Basic ${Buffer.from('api:synthetic').toString('base64')}`,
    },
    {
      account: {
        provider: 'mailgun',
        credentials: { apiKey: 'synthetic', domain: 'mail.example.org', region: 'us' },
      },
      url: 'https://api.mailgun.net/v4/domains/mail.example.org',
      response: { domain: { name: 'mail.example.org' } },
      authorization: `Basic ${Buffer.from('api:synthetic').toString('base64')}`,
    },
    {
      account: {
        provider: 'twilio',
        credentials: { accountSid: 'ACsynthetic', authToken: 'synthetic' },
      },
      url: 'https://api.twilio.com/2010-04-01/Accounts/ACsynthetic.json',
      response: { sid: 'ACsynthetic', status: 'active' },
      authorization: `Basic ${Buffer.from('ACsynthetic:synthetic').toString('base64')}`,
    },
    {
      account: {
        provider: 'meta',
        credentials: { phoneNumberId: 'phone-1', accessToken: 'synthetic' },
      },
      url: 'https://graph.facebook.com/v23.0/phone-1?fields=id,display_phone_number',
      response: { id: 'phone-1' },
      authorization: 'Bearer synthetic',
    },
    {
      account: { provider: 'paystack', credentials: { secretKey: 'synthetic' } },
      url: 'https://api.paystack.co/balance',
      response: { status: true, data: [] },
      authorization: 'Bearer synthetic',
    },
    {
      account: { provider: 'flutterwave', credentials: { secretKey: 'synthetic' } },
      url: 'https://api.flutterwave.com/v3/balances',
      response: { status: 'success', data: [] },
      authorization: 'Bearer synthetic',
    },
  ];
  it.each(cases)(
    'authenticates $account.provider account inspection against its fixed provider URL',
    async ({ account, url, response, authorization }) => {
      fetchMock.mockResolvedValue(reply(response));
      await expect(service.verify(account)).resolves.toMatchObject({ status: 'verified' });
      expect(fetchMock).toHaveBeenCalledWith(url, {
        headers: { Authorization: authorization },
        redirect: 'error',
        signal: expect.any(AbortSignal),
      });
      expect(new URL(url).searchParams.has('api_key')).toBe(false);
      expect(new URL(url).searchParams.has('access_token')).toBe(false);
    },
  );
  it.each(cases)(
    'does not report verification success on $account.provider outages',
    async ({ account }) => {
      fetchMock.mockResolvedValue(reply({ error: 'private upstream detail' }, 503));
      await expect(service.verify(account)).rejects.toThrow('retry later');
    },
  );
  it.each([
    { provider: 'meta', credentials: { phoneNumberId: 'owned' }, response: { id: 'foreign' } },
    {
      provider: 'twilio',
      credentials: { accountSid: 'owned' },
      response: { sid: 'owned', status: 'suspended' },
    },
    { provider: 'sendgrid', credentials: {}, response: { scopes: 'mail.send' } },
    { provider: 'paystack', credentials: {}, response: { status: false } },
    { provider: 'flutterwave', credentials: {}, response: { status: 'error' } },
  ])(
    'rejects unsuccessful $provider account verification despite HTTP 200',
    async ({ provider, credentials, response }) => {
      fetchMock.mockResolvedValue(reply(response));
      await expect(
        service.verify({ provider, credentials } as ProviderAccountSecret),
      ).resolves.toMatchObject({ status: 'rejected' });
    },
  );
  it.each([
    { provider: 'resend', credentials: {}, response: { data: {} } },
    { provider: 'paystack', credentials: {}, response: { status: true, data: null } },
    { provider: 'flutterwave', credentials: {}, response: { status: 'success' } },
    {
      provider: 'mailgun',
      credentials: { domain: 'owned' },
      response: { domain: { name: 'foreign' } },
    },
    { provider: 'mailgun', credentials: { domain: 'owned' }, response: {} },
  ])(
    'refuses malformed or unrelated $provider account responses',
    async ({ provider, credentials, response }) => {
      fetchMock.mockResolvedValue(reply(response));
      await expect(
        service.verify({ provider, credentials } as ProviderAccountSecret),
      ).rejects.toThrow();
    },
  );
  it.each([202, 401])(
    'accepts empty or non-JSON upstream responses where HTTP status %s is authoritative',
    async (status) => {
      fetchMock.mockResolvedValue(new Response('not JSON', { status }));
      const result = await service.request('https://provider.example.org', {});
      expect(result.response.status).toBe(status);
      expect(result.data).toEqual({});
    },
  );
  it('does not accept invalid JSON as a successful inspected account', async () => {
    fetchMock.mockResolvedValue(new Response('secret upstream body', { status: 200 }));
    await expect(service.verify(cases[0].account)).rejects.toThrow(
      'Provider request failed or timed out',
    );
  });
  it('handles truly empty responses without parsing them', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 202 }));
    await expect(service.request('https://provider.example.org', {})).resolves.toMatchObject({
      data: {},
    });
  });

  const input = { to: '+2348000000000', from: '+2348111111111', text: 'Synthetic test' };
  it.each(['resend', 'sendgrid', 'mailgun', 'meta', 'paystack', 'flutterwave'] as const)(
    'rejects unsupported SMS delivery through %s',
    async (provider) => {
      await expect(service.deliver({ provider, credentials: {} }, 'sms', input)).rejects.toThrow(
        'does not support',
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  it.each([
    'https://attacker.example.org',
    'http://api.termii.com',
    'https://api.termii.com.attacker.example.org',
  ])('refuses an untrusted Termii base URL %s', async (baseUrl) => {
    await expect(
      service.deliver({ provider: 'termii', credentials: { baseUrl } }, 'sms', input),
    ).rejects.toThrow('Unsupported Termii API origin');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([
    { staffPhone: undefined },
    { staffPhone: 'invalid' },
    { staffPhone: input.from, to: 'invalid' },
    { staffPhone: input.from, from: 'invalid' },
  ])('refuses invalid phone bridge participants before dialing: %j', async (overrides) => {
    await expect(
      service.deliver({ provider: 'twilio', credentials: {} }, 'voice', { ...input, ...overrides }),
    ).rejects.toThrow('Valid staff, member and caller numbers');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('rejects malformed Twilio Content SIDs before delivery', async () => {
    await expect(
      service.deliver({ provider: 'twilio', credentials: {} }, 'whatsapp', {
        ...input,
        templateId: 'arbitrary-template',
      }),
    ).rejects.toThrow('Content SID');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([undefined, { name: 'Ada' }])(
    'serializes Twilio templates with optional variables: %j',
    async (variables) => {
      fetchMock.mockResolvedValue(reply({ sid: 'SMsynthetic' }));
      const templateId = `HX${'a'.repeat(32)}`;
      await expect(
        service.deliver(
          {
            provider: 'twilio',
            accountId: 'account-1',
            credentials: { accountSid: 'ACsynthetic', authToken: 'synthetic' },
          },
          'whatsapp',
          { ...input, templateId, variables },
        ),
      ).resolves.toBe('SMsynthetic');
      const form = fetchMock.mock.calls[0][1]?.body as URLSearchParams;
      expect(form.get('ContentSid')).toBe(templateId);
      expect(form.get('ContentVariables')).toBe(variables ? JSON.stringify(variables) : null);
      expect(form.get('StatusCallback')).toBe(
        'https://api.example.org/api/v1/integrations/webhooks/account-1',
      );
      expect(form.has('Body')).toBe(false);
    },
  );
  it.each<Record<string, string> | undefined>([
    undefined,
    { language: 'fr', name: 'Ada' },
    { name: 'Ada' },
  ])('serializes Meta template language and parameter values: %j', async (variables) => {
    fetchMock.mockResolvedValue(reply({ messages: [{ id: 'wamid.synthetic' }] }));
    await service.deliver(
      { provider: 'meta', credentials: { phoneNumberId: 'phone-1' } },
      'whatsapp',
      { ...input, templateId: 'welcome', variables },
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(body.template.language.code).toBe(variables?.language ?? 'en');
    expect(body.to).toBe('2348000000000');
    if (variables)
      expect(body.template.components).toEqual([
        { type: 'body', parameters: [{ type: 'text', text: 'Ada' }] },
      ]);
    else expect(body.template).not.toHaveProperty('components');
  });
  it.each([undefined, { name: 'Ada' }])(
    'serializes Termii templates without putting API keys in the URL: %j',
    async (variables) => {
      fetchMock.mockResolvedValue(reply({ request_id: 'request-1' }));
      await expect(
        service.deliver(
          {
            provider: 'termii',
            credentials: { apiKey: 'synthetic', baseUrl: 'https://api.ng.termii.com' },
          },
          'whatsapp',
          { ...input, templateId: 'template-1', variables },
        ),
      ).resolves.toBe('request-1');
      expect(fetchMock.mock.calls[0][0]).toBe('https://api.ng.termii.com/api/send/template');
      expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toEqual({
        api_key: 'synthetic',
        phone_number: '2348000000000',
        device_id: input.from,
        template_id: 'template-1',
        data: variables ?? {},
      });
    },
  );
  it.each(['sms', 'whatsapp'] as const)(
    'uses the correct plain Termii %s channel',
    async (channel) => {
      fetchMock.mockResolvedValue(reply({ message_id: 'message-1' }));
      await expect(
        service.deliver(
          {
            provider: 'termii',
            credentials: { apiKey: 'synthetic', baseUrl: 'https://api.termii.com' },
          },
          channel,
          input,
        ),
      ).resolves.toBe('message-1');
      expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toMatchObject({
        channel: channel === 'sms' ? 'generic' : 'whatsapp',
        sms: input.text,
      });
    },
  );
  it.each(['resend', 'sendgrid', 'meta', 'termii', 'twilio'] as const)(
    'does not claim acceptance without an external ID from %s',
    async (provider) => {
      fetchMock.mockResolvedValue(reply({}));
      const channel =
        provider === 'resend' || provider === 'sendgrid'
          ? 'email'
          : provider === 'meta'
            ? 'whatsapp'
            : 'sms';
      await expect(
        service.deliver(
          { provider, credentials: { baseUrl: 'https://api.termii.com' } },
          channel,
          input,
        ),
      ).rejects.toThrow('did not confirm acceptance');
    },
  );
});
