import { BadRequestException } from '@nestjs/common';
export const CHANNELS = ['email', 'whatsapp', 'sms', 'voice', 'payment'] as const;
export type Channel = (typeof CHANNELS)[number];
export type ProviderId =
  'resend' | 'sendgrid' | 'mailgun' | 'termii' | 'twilio' | 'meta' | 'paystack' | 'flutterwave';
export interface ProviderField {
  key: string;
  label: string;
  secret?: boolean;
  optional?: boolean;
  options?: string[];
}
export interface ProviderDefinition {
  id: ProviderId;
  label: string;
  channels: Channel[];
  fields: ProviderField[];
  help: string;
}
export const PROVIDERS: ProviderDefinition[] = [
  {
    id: 'resend',
    label: 'Resend',
    channels: ['email'],
    fields: [{ key: 'apiKey', label: 'API key', secret: true }],
    help: 'Use a Resend API key. Sending-only keys may need a delivery test instead of account verification.',
  },
  {
    id: 'sendgrid',
    label: 'SendGrid',
    channels: ['email'],
    fields: [{ key: 'apiKey', label: 'API key', secret: true }],
    help: 'Use a SendGrid API key with Mail Send permission and an authenticated sender.',
  },
  {
    id: 'mailgun',
    label: 'Mailgun',
    channels: ['email'],
    fields: [
      { key: 'apiKey', label: 'API key', secret: true },
      { key: 'domain', label: 'Sending domain' },
      { key: 'region', label: 'Region', options: ['us', 'eu'] },
    ],
    help: 'Choose the region where your Mailgun sending domain is registered.',
  },
  {
    id: 'termii',
    label: 'Termii',
    channels: ['sms', 'whatsapp'],
    fields: [
      { key: 'apiKey', label: 'API key', secret: true },
      {
        key: 'baseUrl',
        label: 'API origin',
        options: ['https://api.ng.termii.com', 'https://api.termii.com'],
      },
      { key: 'webhookSecret', label: 'Webhook signing key', secret: true, optional: true },
    ],
    help: 'One Termii account can serve SMS and WhatsApp. WhatsApp callbacks need the signing key from the provider.',
  },
  {
    id: 'twilio',
    label: 'Twilio',
    channels: ['sms', 'whatsapp', 'voice'],
    fields: [
      { key: 'accountSid', label: 'Account SID' },
      { key: 'authToken', label: 'Auth token', secret: true },
    ],
    help: 'Use the Account SID and Auth Token from the same Twilio account. Sender numbers must be enabled for the selected channel.',
  },
  {
    id: 'meta',
    label: 'Meta WhatsApp Cloud',
    channels: ['whatsapp'],
    fields: [
      { key: 'accessToken', label: 'System-user access token', secret: true },
      { key: 'phoneNumberId', label: 'WhatsApp phone number ID' },
      { key: 'appSecret', label: 'Meta app secret', secret: true },
      { key: 'verifyToken', label: 'Webhook verification token', secret: true },
    ],
    help: 'Requires a WhatsApp Business account, a registered number, and a token with WhatsApp messaging permissions.',
  },
  {
    id: 'paystack',
    label: 'Paystack',
    channels: ['payment'],
    fields: [
      { key: 'secretKey', label: 'Secret key', secret: true },
      { key: 'webhookSecret', label: 'Webhook signing secret', secret: true, optional: true },
      { key: 'publicKey', label: 'Public key', optional: true },
    ],
    help: 'Use matching test or live Paystack keys. Credential verification does not charge a card.',
  },
  {
    id: 'flutterwave',
    label: 'Flutterwave',
    channels: ['payment'],
    fields: [
      { key: 'secretKey', label: 'Secret key', secret: true },
      { key: 'publicKey', label: 'Public key', optional: true },
      { key: 'webhookSecret', label: 'Webhook secret hash', secret: true },
    ],
    help: 'Use Flutterwave v3 keys and the separate secret hash configured on your webhook.',
  },
];
export function definition(value: string): ProviderDefinition {
  const result = PROVIDERS.find((provider) => provider.id === value);
  if (!result) throw new BadRequestException('Unsupported provider');
  return result;
}
export function channel(value: string): Channel {
  if (!CHANNELS.includes(value as Channel)) throw new BadRequestException('Unsupported channel');
  return value as Channel;
}
export function validateCredentials(provider: ProviderId, input: Record<string, string>) {
  const spec = definition(provider);
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new BadRequestException('Provider credentials are required');
  const allowed = new Set(spec.fields.map((field) => field.key));
  if (Object.keys(input).some((key) => !allowed.has(key)))
    throw new BadRequestException('Unexpected credential field for this provider');
  for (const field of spec.fields) {
    const value = input[field.key];
    if (!value && field.optional) continue;
    if (typeof value !== 'string' || !value || value.length > 2048 || /[\x00-\x20\x7f]/.test(value))
      throw new BadRequestException(`Check ${field.label}`);
    if (field.options && !field.options.includes(value))
      throw new BadRequestException(`Check ${field.label}`);
  }
  const matches = (key: string, regex: RegExp) => {
    if (!regex.test(input[key] ?? ''))
      throw new BadRequestException(`Invalid ${spec.label} ${key}`);
  };
  if (input.apiKey && input.apiKey.length < 8)
    throw new BadRequestException('API key is too short');
  if (provider === 'resend') matches('apiKey', /^re_[a-zA-Z0-9_-]{8,}$/);
  if (provider === 'sendgrid') matches('apiKey', /^SG\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$/);
  if (provider === 'mailgun')
    matches('domain', /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/);
  if (provider === 'twilio') {
    matches('accountSid', /^AC[a-fA-F0-9]{32}$/);
    matches('authToken', /^[a-fA-F0-9]{32}$/);
  }
  if (provider === 'meta') {
    matches('phoneNumberId', /^\d{5,32}$/);
    if (input.appSecret.length < 16 || input.verifyToken.length < 24)
      throw new BadRequestException('Meta signing secret or verification token is too short');
  }
  if (provider === 'paystack') {
    matches('secretKey', /^sk_(test|live)_[a-zA-Z0-9]+$/);
    if (
      input.publicKey &&
      (!/^pk_(test|live)_[a-zA-Z0-9]+$/.test(input.publicKey) ||
        input.publicKey.split('_')[1] !== input.secretKey.split('_')[1])
    )
      throw new BadRequestException('Paystack public and secret key modes must match');
  }
  if (provider === 'flutterwave') {
    matches('secretKey', /^FLWSECK(?:_TEST)?-[a-zA-Z0-9_-]+$/);
    if (
      input.publicKey &&
      (!/^FLWPUBK(?:_TEST)?-[a-zA-Z0-9_-]+$/.test(input.publicKey) ||
        input.publicKey.includes('_TEST-') !== input.secretKey.includes('_TEST-'))
    )
      throw new BadRequestException('Flutterwave key modes must match');
    if (input.webhookSecret.length < 16)
      throw new BadRequestException('Use a webhook secret hash of at least 16 characters');
  }
}
