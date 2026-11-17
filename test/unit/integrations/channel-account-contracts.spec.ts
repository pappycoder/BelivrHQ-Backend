import { ConfigService } from '@nestjs/config';
import { IntegrationAccountsService } from '../../../src/integrations/integration-accounts.service';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { AuditLoggingService } from '../../../src/common/services/audit-logging.service';
import { ProviderTransportService } from '../../../src/integrations/provider-transport.service';
import type { ChannelInput } from '../../../src/integrations/integration-accounts.service';
import { createPrismaMock } from '../../helpers/prisma-mock.helper';

describe('Church-owned channel configuration contracts', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let service: IntegrationAccountsService;
  let audit: { log: jest.Mock };
  let transport: { verify: jest.Mock; deliver: jest.Mock };
  const credentials = { apiKey: 're_synthetic_provider_key' };
  beforeEach(() => {
    prisma = createPrismaMock();
    prisma.platformSubscription.findUnique.mockResolvedValue({
      plan: 'network',
      paid_until: new Date('2099-01-01'),
    });
    audit = { log: jest.fn() };
    transport = {
      verify: jest.fn().mockResolvedValue({ status: 'verified' }),
      deliver: jest.fn().mockResolvedValue('accepted'),
    };
    service = new IntegrationAccountsService(
      prisma as unknown as PrismaService,
      new ConfigService({ INTEGRATIONS_ENCRYPTION_KEY: 'ab'.repeat(32) }),
      audit as unknown as AuditLoggingService,
      transport as unknown as ProviderTransportService,
    );
    prisma.integrationAccount.findFirst.mockResolvedValue({
      id: 'account',
      provider: 'resend',
      verification_status: 'verified',
      ciphertext: service.encrypt('church', 'account', 'resend', credentials),
    });
  });
  it.each(['', ' ', 'x'.repeat(81), 'bad\nlabel'])(
    'refuses an invalid provider label %j',
    async (label) => {
      await expect(service.create('church', 'resend', label, credentials, 'actor')).rejects.toThrow(
        'account label',
      );
      expect(prisma.integrationAccount.create).not.toHaveBeenCalled();
    },
  );
  it('stores encrypted credentials and selects only safe account fields', async () => {
    prisma.integrationAccount.create.mockResolvedValue({ id: 'account', label: 'Office' });
    expect(await service.create('church', 'resend', ' Office ', credentials, 'actor')).toEqual({
      id: 'account',
      label: 'Office',
    });
    const args = prisma.integrationAccount.create.mock.calls[0][0];
    expect(args.data.label).toBe('Office');
    expect(args.select).not.toHaveProperty('ciphertext');
    expect(service.decrypt('church', args.data.id, 'resend', args.data.ciphertext)).toEqual(
      credentials,
    );
    expect(audit.log.mock.calls[0][0].newValues).toEqual({ provider: 'resend' });
  });
  it('verifies and archives only the tenant-owned account', async () => {
    expect(await service.verify('church', 'account', 'actor')).toEqual({ status: 'verified' });
    expect(transport.verify).toHaveBeenCalledWith({ provider: 'resend', credentials });
    expect(await service.archive('church', 'account', 'actor')).toEqual({ archived: true });
    expect(prisma.integrationAccount.update).toHaveBeenLastCalledWith({
      where: { id: 'account', church_id: 'church' },
      data: { archived_at: expect.any(Date) },
    });
  });
  it.each([null, { mode: 'disabled' }, { mode: 'custom', account_id: null }])(
    'refuses sends from unavailable saved channels %j',
    async (row) => {
      prisma.integrationChannel.findUnique.mockResolvedValue(row);
      await expect(service.resolve('church', 'email')).rejects.toThrow();
      expect(transport.deliver).not.toHaveBeenCalled();
    },
  );
  it('refuses a mismatched provider channel before delivery', async () => {
    prisma.integrationChannel.findUnique.mockResolvedValue({
      mode: 'custom',
      account_id: 'account',
      settings: {},
    });
    await expect(service.resolve('church', 'sms')).rejects.toThrow('Provider channel mismatch');
  });
  it.each([
    { mode: 'custom' },
    {
      mode: 'custom',
      accountId: 'account',
      provider: 'twilio',
      settings: { from: 'a@example.invalid' },
    },
    { mode: 'disabled', accountId: 'account' },
    { mode: 'disabled', provider: 'resend' },
    { mode: 'disabled', settings: { from: 'a@example.invalid' } },
  ] as ChannelInput[])('refuses inconsistent channel assignments %j', async (input) => {
    await expect(service.configure('church', 'email', input, 'actor')).rejects.toThrow();
    expect(prisma.integrationChannel.upsert).not.toHaveBeenCalled();
  });
  it.each(['verified', 'limited'])(
    'allows a checked provider account (%s)',
    async (verification_status) => {
      prisma.integrationAccount.findFirst.mockResolvedValue({
        id: 'account',
        provider: 'resend',
        verification_status,
        ciphertext: service.encrypt('church', 'account', 'resend', credentials),
      });
      expect(
        await service.configure(
          'church',
          'email',
          {
            mode: 'custom',
            accountId: 'account',
            provider: 'resend',
            settings: { from: 'a@example.invalid' },
          },
          'actor',
        ),
      ).toEqual({ saved: true });
      expect(prisma.integrationChannel.upsert.mock.calls[0][0].create).toEqual({
        church_id: 'church',
        channel: 'email',
        mode: 'custom',
        provider: 'resend',
        account_id: 'account',
        settings: { from: 'a@example.invalid' },
      });
    },
  );
  it('disables a channel by clearing its provider and settings', async () => {
    await service.configure('church', 'email', { mode: 'disabled' }, 'actor');
    expect(prisma.integrationChannel.upsert.mock.calls[0][0].update).toEqual({
      mode: 'disabled',
      provider: null,
      account_id: null,
      settings: {},
    });
  });
  it.each(['pending', 'failed'])(
    'refuses unverified credentials (%s)',
    async (verification_status) => {
      prisma.integrationAccount.findFirst.mockResolvedValue({
        id: 'account',
        provider: 'resend',
        verification_status,
      });
      await expect(
        service.configure('church', 'email', { mode: 'custom', accountId: 'account' }, 'actor'),
      ).rejects.toThrow('Check the provider credentials');
      expect(prisma.integrationChannel.upsert).not.toHaveBeenCalled();
    },
  );
  it.each(['short', undefined])(
    'requires a Termii signing secret before enabling WhatsApp (%s)',
    async (webhookSecret) => {
      prisma.integrationAccount.findFirst.mockResolvedValue({
        id: 'account',
        provider: 'termii',
        verification_status: 'verified',
        ciphertext: service.encrypt('church', 'account', 'termii', {
          apiKey: 'fixture',
          ...(webhookSecret ? { webhookSecret } : {}),
        }),
      });
      await expect(
        service.configure('church', 'whatsapp', { mode: 'custom', accountId: 'account' }, 'actor'),
      ).rejects.toThrow('signing key');
      expect(prisma.integrationChannel.upsert).not.toHaveBeenCalled();
    },
  );
  it.each(['not-an-email', 'x\n@example.invalid'])(
    'refuses unsafe test email destinations (%j)',
    async (to) => {
      await expect(service.test('church', 'email', to, 'actor')).rejects.toThrow(
        'test destination',
      );
      expect(transport.deliver).not.toHaveBeenCalled();
    },
  );
  it('records an accepted test delivery without exposing provider credentials', async () => {
    prisma.integrationChannel.findUnique.mockResolvedValue({
      mode: 'custom',
      account_id: 'account',
      settings: { from: 'a@example.invalid' },
    });
    await service.test('church', 'email', 'recipient@example.invalid', 'actor');
    expect(transport.deliver).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'account' }),
      'email',
      expect.objectContaining({ to: 'recipient@example.invalid', from: 'a@example.invalid' }),
    );
    expect(JSON.stringify(prisma.message.create.mock.calls)).not.toContain(credentials.apiKey);
  });
});
