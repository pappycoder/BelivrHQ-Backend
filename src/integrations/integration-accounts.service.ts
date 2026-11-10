import { assertPlanFeature, churchEntitlements } from '../billing/entitlements';
import { PlanFeature } from '../billing/plans';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { isEmail } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLoggingService } from '../common/services/audit-logging.service';
import {
  Channel,
  CHANNELS,
  channel,
  definition,
  ProviderId,
  PROVIDERS,
  validateCredentials,
} from './provider-catalog';
import {
  ProviderTransportService,
  ProviderAccountSecret,
  DeliveryInput,
} from './provider-transport.service';
export interface ResolvedIntegration extends ProviderAccountSecret {
  accountId: string;
  settings: Record<string, string>;
}
export interface ChannelInput {
  mode: 'custom' | 'disabled';
  provider?: string;
  accountId?: string;
  settings?: Record<string, string>;
}
const SAFE_SELECT = {
  id: true,
  provider: true,
  label: true,
  verification_status: true,
  verified_at: true,
  archived_at: true,
  created_at: true,
} as const;

@Injectable()
export class IntegrationAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditLoggingService,
    private readonly transport: ProviderTransportService,
  ) {}
  private key() {
    const value = this.config.get<string>('INTEGRATIONS_ENCRYPTION_KEY');
    if (!value || !/^[a-fA-F0-9]{64}$/.test(value))
      throw new ServiceUnavailableException('Integration encryption is not configured');
    return Buffer.from(value, 'hex');
  }
  encrypt(churchId: string, accountId: string, provider: string, input: Record<string, string>) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    cipher.setAAD(Buffer.from(`${churchId}:${accountId}:${provider}:v1`));
    const data = Buffer.concat([cipher.update(JSON.stringify(input), 'utf8'), cipher.final()]);
    return [
      'v1',
      iv.toString('base64'),
      cipher.getAuthTag().toString('base64'),
      data.toString('base64'),
    ].join('.');
  }
  decrypt(
    churchId: string,
    accountId: string,
    provider: string,
    value: string,
  ): Record<string, string> {
    try {
      const [v, iv, tag, data, extra] = value.split('.');
      if (v !== 'v1' || extra || !iv || !tag || !data) throw new Error();
      const cipher = createDecipheriv('aes-256-gcm', this.key(), Buffer.from(iv, 'base64'));
      cipher.setAAD(Buffer.from(`${churchId}:${accountId}:${provider}:v1`));
      cipher.setAuthTag(Buffer.from(tag, 'base64'));
      return JSON.parse(
        Buffer.concat([cipher.update(Buffer.from(data, 'base64')), cipher.final()]).toString(
          'utf8',
        ),
      ) as Record<string, string>;
    } catch {
      throw new ServiceUnavailableException('Integration credentials cannot be decrypted');
    }
  }
  private channelFeature(kind: Channel): PlanFeature {
    return kind === 'payment' ? 'giving' : kind === 'voice' ? 'calls' : kind;
  }
  private async assertProviderPlan(churchId: string, provider: ProviderId) {
    const entitlement = await churchEntitlements(this.prisma, churchId);
    const supported = definition(provider).channels.map((kind) => this.channelFeature(kind));
    if (
      !entitlement.active ||
      !supported.some((feature) => entitlement.features.includes(feature))
    ) {
      await assertPlanFeature(this.prisma, churchId, supported[0]);
    }
  }
  async list(churchId: string) {
    const entitlement = await churchEntitlements(this.prisma, churchId);
    const eligibleChannels = CHANNELS.filter(
      (kind) =>
        (entitlement.active || entitlement.readOnly) &&
        entitlement.features.includes(this.channelFeature(kind)),
    );
    const providers = PROVIDERS.filter((provider) =>
      provider.channels.some((kind) => eligibleChannels.includes(kind)),
    );
    const [accounts, channels] = await Promise.all([
      this.prisma.integrationAccount.findMany({
        where: { church_id: churchId },
        select: SAFE_SELECT,
        orderBy: { created_at: 'desc' },
      }),
      this.prisma.integrationChannel.findMany({ where: { church_id: churchId } }),
    ]);
    return {
      providers,
      accounts: accounts.filter((account) =>
        providers.some((provider) => provider.id === account.provider),
      ),
      channels: eligibleChannels.map((kind) => {
        const saved = channels.find((item) => item.channel === kind);
        return saved?.mode === 'custom'
          ? saved
          : {
              channel: kind,
              mode: 'disabled',
              provider: null,
              account_id: null,
              settings: {},
              updated_at: saved?.updated_at ?? null,
            };
      }),
    };
  }
  async create(
    churchId: string,
    providerValue: string,
    label: string,
    credentials: Record<string, string>,
    userId: string,
  ) {
    const provider = definition(providerValue).id;
    await this.assertProviderPlan(churchId, provider);
    validateCredentials(provider, credentials);
    if (!label?.trim() || label.length > 80 || /[\x00-\x1f]/.test(label))
      throw new BadRequestException('Provide an account label of 1–80 characters');
    const id = randomUUID();
    const ciphertext = this.encrypt(churchId, id, provider, credentials);
    const row = await this.prisma.integrationAccount.create({
      data: { id, church_id: churchId, provider, label: label.trim(), ciphertext },
      select: SAFE_SELECT,
    });
    await this.audit.log({
      churchId,
      userId,
      entity: 'integration_account',
      entityId: id,
      action: 'CREATE',
      newValues: { provider },
    });
    return row;
  }
  async account(churchId: string, id: string, historical = false): Promise<ProviderAccountSecret> {
    const row = await this.prisma.integrationAccount.findFirst({
      where: { id, church_id: churchId, ...(historical ? {} : { archived_at: null }) },
    });
    if (!row) throw new NotFoundException('Provider account not found');
    return {
      provider: definition(row.provider).id,
      credentials: this.decrypt(churchId, row.id, row.provider, row.ciphertext),
    };
  }
  async verify(churchId: string, id: string, userId: string) {
    const account = await this.account(churchId, id);
    await this.assertProviderPlan(churchId, account.provider);
    const result = await this.transport.verify(account);
    await this.prisma.integrationAccount.update({
      where: { id, church_id: churchId },
      data: { verification_status: result.status, verified_at: new Date() },
    });
    await this.audit.log({
      churchId,
      userId,
      entity: 'integration_account',
      entityId: id,
      action: 'UPDATE',
      newValues: { verification: result.status },
    });
    return result;
  }
  settings(
    provider: ProviderId,
    kind: Channel,
    input: Record<string, string> = {},
  ): Record<string, string> {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new BadRequestException('Invalid channel settings');
    const allowed =
      kind === 'email' ? ['from', 'senderName', 'replyTo'] : kind === 'payment' ? [] : ['from'];
    if (Object.keys(input).some((key) => !allowed.includes(key)))
      throw new BadRequestException('Unexpected channel setting');
    for (const value of Object.values(input))
      if (typeof value !== 'string' || value.length > 254 || /[\x00-\x1f\x7f<>]/.test(value))
        throw new BadRequestException('Invalid channel setting');
    if (
      kind === 'email' &&
      (!isEmail(input.from ?? '') || (input.replyTo && !isEmail(input.replyTo)))
    )
      throw new BadRequestException('A valid sender email and reply-to email are required');
    if (['voice', 'sms', 'whatsapp'].includes(kind) && provider !== 'meta') {
      if (
        !input.from ||
        (provider === 'twilio' && !/^\+[1-9]\d{7,14}$/.test(input.from)) ||
        (provider === 'termii' && !/^[a-zA-Z0-9_+ -]{1,128}$/.test(input.from))
      )
        throw new BadRequestException(
          'Configure a valid sender number, sender ID or WhatsApp device ID',
        );
    }
    return input;
  }
  async configure(churchId: string, kindValue: string, input: ChannelInput, userId: string) {
    const kind = channel(kindValue);
    if (!['custom', 'disabled'].includes(input.mode))
      throw new BadRequestException('Invalid channel mode');
    let provider: ProviderId | null = null;
    let accountId: string | null = null;
    let settings: Record<string, string> = {};
    if (input.mode === 'custom') {
      await assertPlanFeature(this.prisma, churchId, this.channelFeature(kind));
      if (!input.accountId) throw new BadRequestException('Choose a provider account');
      const row = await this.prisma.integrationAccount.findFirst({
        where: { id: input.accountId, church_id: churchId, archived_at: null },
      });
      if (!row) throw new NotFoundException('Provider account not found');
      provider = definition(row.provider).id;
      if (!definition(provider).channels.includes(kind))
        throw new BadRequestException('Provider does not support this channel');
      if (input.provider && input.provider !== provider)
        throw new BadRequestException('Provider does not match the chosen account');
      if (!['verified', 'limited'].includes(row.verification_status))
        throw new BadRequestException(
          'Check the provider credentials before selecting this account',
        );
      const credentials = this.decrypt(churchId, row.id, provider, row.ciphertext);
      if (
        provider === 'termii' &&
        kind === 'whatsapp' &&
        (!credentials.webhookSecret || credentials.webhookSecret.length < 32)
      )
        throw new BadRequestException('WhatsApp needs the Termii webhook signing key');
      accountId = row.id;
      settings = this.settings(provider, kind, input.settings);
    } else if (input.accountId || input.provider || Object.keys(input.settings ?? {}).length)
      throw new BadRequestException(
        'Account and sender settings are accepted only for church-owned channels',
      );
    await this.prisma.integrationChannel.upsert({
      where: { church_id_channel: { church_id: churchId, channel: kind } },
      create: {
        church_id: churchId,
        channel: kind,
        mode: input.mode,
        provider,
        account_id: accountId,
        settings,
      },
      update: { mode: input.mode, provider, account_id: accountId, settings },
    });
    await this.audit.log({
      churchId,
      userId,
      entity: 'integration_channel',
      action: 'UPDATE',
      newValues: { channel: kind, mode: input.mode, provider, accountId },
    });
    return { saved: true };
  }
  async resolve(churchId: string, kind: Channel): Promise<ResolvedIntegration | null> {
    if (!churchId) return null;
    await assertPlanFeature(
      this.prisma,
      churchId,
      kind === 'payment' ? 'giving' : kind === 'voice' ? 'calls' : kind,
    );
    const row = await this.prisma.integrationChannel.findUnique({
      where: { church_id_channel: { church_id: churchId, channel: kind } },
    });
    if (!row || row.mode !== 'custom')
      throw new ServiceUnavailableException(`${kind} is disabled for this church`);
    if (!row.account_id) throw new ServiceUnavailableException('Channel account is unavailable');
    const account = await this.account(churchId, row.account_id);
    if (!definition(account.provider).channels.includes(kind))
      throw new ServiceUnavailableException('Provider channel mismatch');
    return {
      ...account,
      accountId: row.account_id,
      settings: row.settings as Record<string, string>,
    };
  }
  deliver(
    account: ResolvedIntegration,
    kind: 'email' | 'sms' | 'whatsapp' | 'voice',
    input: DeliveryInput,
  ) {
    return this.transport.deliver(account, kind, input);
  }
  async archive(churchId: string, id: string, userId: string) {
    await this.account(churchId, id);
    // Archive blocks all future sends. Historical payment verification still uses the pinned record.
    await this.prisma.integrationAccount.update({
      where: { id, church_id: churchId },
      data: { archived_at: new Date() },
    });
    await this.audit.log({
      churchId,
      userId,
      entity: 'integration_account',
      entityId: id,
      action: 'ARCHIVE',
    });
    return { archived: true };
  }
  async test(churchId: string, kindValue: string, to: string, userId: string) {
    const kind = channel(kindValue);
    if (kind === 'payment')
      throw new BadRequestException(
        'Use credential verification; payment tests must use an ordinary checkout in test mode',
      );
    if (kind === 'email' ? !isEmail(to) : !/^\+[1-9]\d{7,14}$/.test(to))
      throw new BadRequestException('Provide a valid test destination');
    const account = await this.resolve(churchId, kind);
    if (!account)
      throw new BadRequestException('Select a church-owned account before testing here');
    const staff =
      kind === 'voice'
        ? await this.prisma.profile.findFirst({
            where: { church_id: churchId, user_id: userId },
            select: { phone: true },
          })
        : null;
    if (kind === 'voice' && !staff?.phone)
      throw new BadRequestException(
        'Set your staff phone number on your profile before testing live calls',
      );
    const id = await this.transport.deliver(account, kind, {
      staffPhone: staff?.phone ?? undefined,
      ...account.settings,
      from: account.settings.from ?? '',
      to,
      subject: 'BelivrHQ connection test',
      text: 'Your BelivrHQ connection test was accepted.',
      html: '<p>Your BelivrHQ email connection is working.</p>',
    });
    await this.prisma.message.create({
      data: {
        church_id: churchId,
        phone: to,
        direction: 'outbound',
        channel: kind,
        content: 'BelivrHQ connection test',
        status: 'sent',
        metadata: {
          provider: account.provider,
          provider_id: id,
          integration_account_id: account.accountId,
        },
      },
    });
    await this.audit.log({
      churchId,
      userId,
      entity: 'integration_channel',
      action: 'UPDATE',
      newValues: { channel: kind, testAccepted: true },
    });
    return {
      accepted: true,
      message:
        'Provider accepted the test. Confirm receipt; acceptance is not delivery confirmation.',
    };
  }
}
