import { createHmac } from 'node:crypto';
import type { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { IntegrationCallbacksController } from '../../../src/integrations/integration-callbacks.controller';
import { IntegrationAccountsService } from '../../../src/integrations/integration-accounts.service';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { WhatsAppService } from '../../../src/whatsapp/whatsapp.service';

describe('Authenticated integration callbacks', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const churchId = '22222222-2222-4222-8222-222222222222';
  const originalUrl = `/api/v1/integrations/webhooks/${id}`;
  const credentials = {
    appSecret: 'synthetic-meta-secret',
    webhookSecret: 'synthetic-termii-secret',
    authToken: 'synthetic-twilio-secret',
    verifyToken: 'synthetic-subscription-token',
    phoneNumberId: 'owned-phone',
  };
  let controller: IntegrationCallbacksController;
  const prisma = {
    integrationAccount: { findFirst: jest.fn() },
    integrationChannel: { findUnique: jest.fn() },
    message: { updateMany: jest.fn() },
  };
  const accounts = { account: jest.fn() };
  const whatsapp = { processWebhook: jest.fn() };
  const config = { get: jest.fn() };
  const response = { type: jest.fn() };
  type CallbackRequest = Parameters<IntegrationCallbacksController['receive']>[2];

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.integrationAccount.findFirst.mockResolvedValue({ id, church_id: churchId });
    prisma.integrationChannel.findUnique.mockResolvedValue({ mode: 'custom', account_id: id });
    prisma.message.updateMany.mockResolvedValue({ count: 1 });
    accounts.account.mockResolvedValue({ provider: 'meta', credentials });
    whatsapp.processWebhook.mockResolvedValue({ processed: 1 });
    config.get.mockReturnValue('https://api.example.org/');
    controller = new IntegrationCallbacksController(
      prisma as unknown as PrismaService,
      accounts as unknown as IntegrationAccountsService,
      whatsapp as unknown as WhatsAppService,
      config as unknown as ConfigService,
    );
  });

  function signed(provider: string, body: Record<string, unknown>, raw = JSON.stringify(body)) {
    accounts.account.mockResolvedValue({ provider, credentials });
    const rawBody = Buffer.from(raw);
    const algorithm = provider === 'meta' ? 'sha256' : 'sha512';
    const key = provider === 'meta' ? credentials.appSecret : credentials.webhookSecret;
    const header = provider === 'meta' ? 'x-hub-signature-256' : 'x-termii-signature';
    const headers: Record<string, string | string[]> = {
      [header]: `${algorithm}=${createHmac(algorithm, key).update(rawBody).digest('hex')}`,
    };
    if (provider === 'twilio') {
      const content =
        `https://api.example.org${originalUrl}` +
        Object.keys(body)
          .sort()
          .map((key) => `${key}${body[key]}`)
          .join('');
      headers['x-twilio-signature'] = createHmac('sha1', credentials.authToken)
        .update(content)
        .digest('base64');
    }
    return { headers, originalUrl, rawBody } as CallbackRequest;
  }
  const receive = (body: Record<string, unknown>, req: CallbackRequest) =>
    controller.receive(id, body, req, response as unknown as Response);

  it('verifies subscriptions only against the requested active account', async () => {
    await expect(
      controller.verify(id, 'subscribe', credentials.verifyToken, 'challenge'),
    ).resolves.toBe('challenge');
    expect(prisma.integrationAccount.findFirst).toHaveBeenCalledWith({
      where: { id, archived_at: null },
    });
    expect(accounts.account).toHaveBeenCalledWith(churchId, id);
  });

  it.each([
    ['meta', 'unsubscribe', credentials.verifyToken],
    ['meta', 'subscribe', ''],
    ['meta', 'subscribe', 'wrong'],
    ['meta', 'subscribe', 'x'.repeat(credentials.verifyToken.length)],
    ['termii', 'subscribe', credentials.verifyToken],
  ])('rejects invalid subscription verification (%s, %s)', async (provider, mode, token) => {
    accounts.account.mockResolvedValue({ provider, credentials });
    await expect(controller.verify(id, mode, token, 'challenge')).rejects.toThrow(
      'Invalid subscription token',
    );
  });

  it('rejects archived or missing accounts before decrypting or processing', async () => {
    const req = signed('meta', {});
    prisma.integrationAccount.findFirst.mockResolvedValue(null);
    await expect(receive({}, req)).rejects.toThrow('account is unavailable');
    expect(accounts.account).not.toHaveBeenCalled();
    expect(whatsapp.processWebhook).not.toHaveBeenCalled();
  });

  it.each(['meta', 'termii', 'twilio'])('requires raw bytes for %s callbacks', async (provider) => {
    const req = signed(provider, {});
    delete req.rawBody;
    await expect(receive({}, req)).rejects.toThrow('Raw callback payload is required');
    expect(prisma.integrationChannel.findUnique).not.toHaveBeenCalled();
  });

  it.each(['meta', 'termii'])('authenticates the exact raw payload for %s', async (provider) => {
    const body = {};
    const req = signed(provider, body);
    req.rawBody = Buffer.from('{ "tampered": true }');
    await expect(receive(body, req)).rejects.toThrow('Invalid provider signature');
    expect(whatsapp.processWebhook).not.toHaveBeenCalled();
    expect(prisma.message.updateMany).not.toHaveBeenCalled();
  });

  it.each(['meta', 'termii'])(
    'refuses missing or repeated %s signature headers',
    async (provider) => {
      const header = provider === 'meta' ? 'x-hub-signature-256' : 'x-termii-signature';
      for (const value of [undefined, ['one', 'two']]) {
        const req = signed(provider, {});
        req.headers[header] = value;
        await expect(receive({}, req)).rejects.toThrow('Invalid provider signature');
      }
    },
  );

  it.each(['meta', 'termii'])(
    'rejects %s callbacks without a configured signing secret',
    async (provider) => {
      const req = signed(provider, {});
      accounts.account.mockResolvedValue({
        provider,
        credentials: { ...credentials, appSecret: '', webhookSecret: '' },
      });
      await expect(receive({}, req)).rejects.toThrow('Invalid provider signature');
    },
  );

  it.each([
    null,
    { mode: 'platform', account_id: id },
    { mode: 'custom', account_id: 'other-account' },
  ])('rejects Meta events for an inactive channel binding: %j', async (binding) => {
    prisma.integrationChannel.findUnique.mockResolvedValue(binding);
    await expect(receive({}, signed('meta', {}))).rejects.toThrow('no longer active');
    expect(whatsapp.processWebhook).not.toHaveBeenCalled();
  });

  it('processes only the owned Meta phone and normalizes inbound sender numbers', async () => {
    const body = {
      entry: [
        {},
        {
          changes: [
            {},
            {
              value: {
                metadata: { phone_number_id: 'foreign-phone' },
                messages: [{ from: '999' }],
              },
            },
            {
              value: {
                metadata: { phone_number_id: credentials.phoneNumberId },
                messages: [{ from: '2341' }, { from: '+2342' }],
              },
            },
            {
              value: {
                metadata: { phone_number_id: credentials.phoneNumberId },
                statuses: [{ id: 'receipt' }],
              },
            },
          ],
        },
      ],
    };
    await expect(receive(body, signed('meta', body))).resolves.toEqual({ processed: 2 });
    expect(whatsapp.processWebhook).toHaveBeenCalledTimes(2);
    expect(whatsapp.processWebhook).toHaveBeenNthCalledWith(
      1,
      {
        metadata: { phone_number_id: 'owned-phone' },
        messages: [{ from: '+2341' }, { from: '+2342' }],
      },
      churchId,
    );
    expect(whatsapp.processWebhook).toHaveBeenNthCalledWith(
      2,
      {
        metadata: { phone_number_id: 'owned-phone' },
        statuses: [{ id: 'receipt' }],
        messages: undefined,
      },
      churchId,
    );
  });

  it('accepts a valid empty Meta batch without processing messages', async () => {
    await expect(receive({}, signed('meta', {}))).resolves.toEqual({ processed: 0 });
    expect(whatsapp.processWebhook).not.toHaveBeenCalled();
  });

  it('authenticates Twilio using the canonical public origin and sorted form fields', async () => {
    const body = { MessageSid: 'message-1', Body: 'Hello', From: 'whatsapp:+2341' };
    const req = signed('twilio', body);
    req.headers.host = 'attacker.example.org';
    await expect(receive(body, req)).resolves.toBe('<Response/>');
    expect(whatsapp.processWebhook).toHaveBeenCalledWith(
      {
        type: 'inbound',
        sender: '2341',
        message: 'Hello',
        message_id: 'message-1',
        channel: 'whatsapp',
      },
      churchId,
    );
    expect(response.type).toHaveBeenCalledWith('text/xml');
    expect(prisma.message.updateMany).not.toHaveBeenCalled();
  });

  it('refuses Twilio callbacks with a missing origin, non-string fields or invalid signatures', async () => {
    const req = signed('twilio', {});
    config.get.mockReturnValueOnce(undefined);
    await expect(receive({}, req)).rejects.toThrow('Public API origin');
    await expect(receive({ Body: ['injected'] }, req)).rejects.toThrow(
      'Invalid Twilio callback form',
    );
    req.headers['x-twilio-signature'] = undefined;
    await expect(receive({}, req)).rejects.toThrow('Invalid provider signature');
    req.headers['x-twilio-signature'] = 'x'.repeat(28);
    await expect(receive({}, req)).rejects.toThrow('Invalid provider signature');
    expect(whatsapp.processWebhook).not.toHaveBeenCalled();
    expect(prisma.message.updateMany).not.toHaveBeenCalled();
  });

  it('does not accept a Twilio signature issued for a different request path', async () => {
    const req = signed('twilio', {});
    req.originalUrl += '/foreign';
    await expect(receive({}, req)).rejects.toThrow('Invalid provider signature');
  });

  it('refuses Twilio inbound messages after switching accounts', async () => {
    const body = { From: 'whatsapp:2341', Body: 'Hello' };
    const req = signed('twilio', body);
    prisma.integrationChannel.findUnique.mockResolvedValue({ mode: 'custom', account_id: 'other' });
    await expect(receive(body, req)).rejects.toThrow('no longer active');
    expect(whatsapp.processWebhook).not.toHaveBeenCalled();
  });

  it('handles Twilio inbound messages without an optional message ID', async () => {
    const body = { From: 'whatsapp:2341', Body: 'Hello' };
    await receive(body, signed('twilio', body));
    expect(whatsapp.processWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ sender: '2341', message_id: '' }),
      churchId,
    );
  });

  it.each([
    { MessageSid: 'message-1', MessageStatus: 'delivered' },
    { CallSid: 'call-1', CallStatus: 'completed' },
  ])('keeps Twilio receipts scoped to the account church: %j', async (body) => {
    await expect(receive(body, signed('twilio', body))).resolves.toBe('<Response/>');
    expect(prisma.message.updateMany).toHaveBeenCalledWith({
      where: {
        church_id: churchId,
        metadata: { path: ['provider_id'], equals: body.MessageSid ?? body.CallSid },
      },
      data: { status: body.MessageStatus ?? body.CallStatus },
    });
    expect(whatsapp.processWebhook).not.toHaveBeenCalled();
  });

  it('acknowledges unrecognized Twilio receipts without mutating messages', async () => {
    await expect(receive({}, signed('twilio', {}))).resolves.toBe('<Response/>');
    expect(prisma.message.updateMany).not.toHaveBeenCalled();
  });

  it.each([{ message_id: 'receipt-1' }, { id: 'receipt-1' }])(
    'scopes Termii SMS receipts to both church and integration account: %j',
    async (identifier) => {
      const body = { ...identifier, status: 'delivered' };
      prisma.integrationChannel.findUnique.mockResolvedValue(null);
      await expect(receive(body, signed('termii', body))).resolves.toEqual({ received: true });
      expect(prisma.message.updateMany).toHaveBeenCalledWith({
        where: {
          church_id: churchId,
          AND: [
            { metadata: { path: ['provider_id'], equals: 'receipt-1' } },
            { metadata: { path: ['integration_account_id'], equals: id } },
          ],
        },
        data: { status: 'delivered' },
      });
    },
  );

  it('acknowledges Termii receipts without an identifier without touching messages', async () => {
    const body = { status: 'delivered' };
    await expect(receive(body, signed('termii', body))).resolves.toEqual({ received: true });
    expect(prisma.message.updateMany).not.toHaveBeenCalled();
  });

  it.each(['generic', 'dnd'])(
    'does not route Termii SMS channel %s into WhatsApp',
    async (channel) => {
      const body = { type: 'inbound', channel };
      prisma.integrationChannel.findUnique.mockResolvedValue(null);
      await expect(receive(body, signed('termii', body))).resolves.toEqual({ received: true });
      expect(whatsapp.processWebhook).not.toHaveBeenCalled();
    },
  );

  it('requires the active custom account for Termii WhatsApp inbound messages', async () => {
    const body = { type: 'inbound', channel: 'whatsapp', message: 'Hello' };
    const req = signed('termii', body);
    prisma.integrationChannel.findUnique.mockResolvedValueOnce(null);
    await expect(receive(body, req)).rejects.toThrow('no longer active');
    await expect(receive(body, req)).resolves.toEqual({ processed: 1 });
    expect(whatsapp.processWebhook).toHaveBeenCalledTimes(1);
    expect(whatsapp.processWebhook).toHaveBeenCalledWith(body, churchId);
  });

  it('refuses providers without messaging callbacks', async () => {
    await expect(receive({}, signed('resend', {}))).rejects.toThrow('no messaging callback');
    expect(prisma.integrationChannel.findUnique).not.toHaveBeenCalled();
  });
});
