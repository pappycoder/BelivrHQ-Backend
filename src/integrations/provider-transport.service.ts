import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ProviderId } from './provider-catalog';
export interface ProviderAccountSecret {
  accountId?: string;
  provider: ProviderId;
  credentials: Record<string, string>;
}
export interface DeliveryInput {
  staffPhone?: string;
  to: string;
  from: string;
  senderName?: string;
  replyTo?: string;
  text: string;
  subject?: string;
  html?: string;
  plainText?: string;
  templateId?: string;
  variables?: Record<string, string>;
  attachment?: { filename: string; content: Buffer };
}
export interface Verification {
  status: 'verified' | 'limited' | 'rejected';
  message: string;
}

@Injectable()
export class ProviderTransportService {
  constructor(private readonly config: ConfigService = new ConfigService()) {}
  async request(
    url: string,
    init: RequestInit,
  ): Promise<{ response: Response; data: Record<string, unknown> }> {
    try {
      const response = await fetch(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
      const text = await response.text();
      let data: Record<string, unknown> = {};
      if (text) {
        try {
          data = JSON.parse(text) as Record<string, unknown>;
        } catch {
          if (response.ok && response.status !== 202) throw new Error();
        }
      }
      return { response, data };
    } catch {
      throw new ServiceUnavailableException('Provider request failed or timed out');
    }
  }
  private basic(user: string, password: string) {
    return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
  }

  async verify({ provider, credentials: c }: ProviderAccountSecret): Promise<Verification> {
    let url: string;
    let authorization: string;
    if (provider === 'termii')
      return {
        status: 'limited',
        message:
          'Credential format checked. Confirm account access with a controlled SMS or WhatsApp test; no API key is placed in a verification URL.',
      };
    if (provider === 'resend') {
      url = 'https://api.resend.com/domains';
      authorization = `Bearer ${c.apiKey}`;
    } else if (provider === 'sendgrid') {
      url = 'https://api.sendgrid.com/v3/scopes';
      authorization = `Bearer ${c.apiKey}`;
    } else if (provider === 'mailgun') {
      url = `https://${c.region === 'eu' ? 'api.eu.mailgun.net' : 'api.mailgun.net'}/v4/domains/${encodeURIComponent(c.domain)}`;
      authorization = this.basic('api', c.apiKey);
    } else if (provider === 'twilio') {
      url = `https://api.twilio.com/2010-04-01/Accounts/${c.accountSid}.json`;
      authorization = this.basic(c.accountSid, c.authToken);
    } else if (provider === 'meta') {
      url = `https://graph.facebook.com/v23.0/${c.phoneNumberId}?fields=id,display_phone_number`;
      authorization = `Bearer ${c.accessToken}`;
    } else if (provider === 'paystack') {
      url = 'https://api.paystack.co/balance';
      authorization = `Bearer ${c.secretKey}`;
    } else {
      url = 'https://api.flutterwave.com/v3/balances';
      authorization = `Bearer ${c.secretKey}`;
    }
    const { response, data } = await this.request(url, {
      headers: { Authorization: authorization },
    });
    if (response.status === 401)
      return { status: 'rejected', message: 'The selected provider rejected these credentials.' };
    if (response.status === 403)
      return {
        status: 'limited',
        message:
          'The provider denied account inspection. This may be a restricted key; authentication is not confirmed. Use a controlled channel test or adjust key permissions.',
      };
    if (!response.ok)
      throw new ServiceUnavailableException(
        'Provider could not complete verification; retry later',
      );
    if (
      provider === 'sendgrid' &&
      !(Array.isArray(data.scopes) && data.scopes.includes('mail.send'))
    )
      return {
        status: 'rejected',
        message: 'This SendGrid key does not have Mail Send permission.',
      };
    if (provider === 'twilio' && (data.sid !== c.accountSid || data.status !== 'active'))
      return {
        status: 'rejected',
        message: 'Twilio account is inactive or does not match the Account SID.',
      };
    if (provider === 'meta' && data.id !== c.phoneNumberId)
      return { status: 'rejected', message: 'The token cannot access this WhatsApp phone number.' };
    if (
      (provider === 'paystack' && data.status !== true) ||
      (provider === 'flutterwave' && data.status !== 'success')
    )
      return { status: 'rejected', message: 'The payment provider rejected account access.' };
    if (
      (provider === 'resend' || provider === 'paystack' || provider === 'flutterwave') &&
      !Array.isArray(data.data)
    )
      throw new ServiceUnavailableException('Provider returned an invalid account response');
    if (provider === 'mailgun' && (data.domain as { name?: string } | undefined)?.name !== c.domain)
      throw new ServiceUnavailableException('Mailgun did not confirm the configured domain');
    return {
      status: 'verified',
      message:
        'Provider account access verified. Sender approval, channel permissions and actual delivery still require a channel test.',
    };
  }

  async deliver(
    account: ProviderAccountSecret,
    channel: 'email' | 'sms' | 'whatsapp' | 'voice',
    input: DeliveryInput,
  ): Promise<string> {
    const { provider, credentials: c } = account;
    let url: string;
    let body: BodyInit;
    let headers: Record<string, string> = {};
    let externalId: (response: Response, data: Record<string, unknown>) => string = (
      _response,
      data,
    ) => String(data.id ?? data.sid ?? data.message_id ?? data.request_id ?? '');
    if (provider === 'resend' && channel === 'email') {
      url = 'https://api.resend.com/emails';
      headers = { Authorization: `Bearer ${c.apiKey}`, 'Content-Type': 'application/json' };
      body = JSON.stringify({
        from: input.senderName ? `${input.senderName} <${input.from}>` : input.from,
        to: [input.to],
        subject: input.subject,
        html: input.html ?? input.text,
        ...(input.plainText ? { text: input.plainText } : {}),
        ...(input.replyTo ? { reply_to: input.replyTo } : {}),
        ...(input.attachment
          ? {
              attachments: [
                {
                  filename: input.attachment.filename,
                  content: input.attachment.content.toString('base64'),
                },
              ],
            }
          : {}),
      });
    } else if (provider === 'sendgrid' && channel === 'email') {
      url = 'https://api.sendgrid.com/v3/mail/send';
      headers = { Authorization: `Bearer ${c.apiKey}`, 'Content-Type': 'application/json' };
      body = JSON.stringify({
        personalizations: [{ to: [{ email: input.to }] }],
        from: { email: input.from, ...(input.senderName ? { name: input.senderName } : {}) },
        ...(input.replyTo ? { reply_to: { email: input.replyTo } } : {}),
        subject: input.subject,
        content: [
          ...(input.plainText ? [{ type: 'text/plain', value: input.plainText }] : []),
          { type: 'text/html', value: input.html ?? input.text },
        ],
        ...(input.attachment
          ? {
              attachments: [
                {
                  filename: input.attachment.filename,
                  content: input.attachment.content.toString('base64'),
                  disposition: 'attachment',
                },
              ],
            }
          : {}),
      });
      externalId = (response) => response.headers.get('x-message-id') ?? '';
    } else if (provider === 'mailgun' && channel === 'email') {
      url = `https://${c.region === 'eu' ? 'api.eu.mailgun.net' : 'api.mailgun.net'}/v3/${encodeURIComponent(c.domain)}/messages`;
      headers.Authorization = this.basic('api', c.apiKey);
      const form = new FormData();
      form.set('from', input.senderName ? `${input.senderName} <${input.from}>` : input.from);
      form.set('to', input.to);
      form.set('subject', input.subject ?? 'ChurchOS');
      form.set('html', input.html ?? input.text);
      if (input.plainText) form.set('text', input.plainText);
      if (input.replyTo) form.set('h:Reply-To', input.replyTo);
      if (input.attachment)
        form.set(
          'attachment',
          new Blob([new Uint8Array(input.attachment.content)]),
          input.attachment.filename,
        );
      body = form;
    } else if (provider === 'twilio') {
      url = `https://api.twilio.com/2010-04-01/Accounts/${c.accountSid}/${channel === 'voice' ? 'Calls' : 'Messages'}.json`;
      headers = {
        Authorization: this.basic(c.accountSid, c.authToken),
        'Content-Type': 'application/x-www-form-urlencoded',
      };
      const form = new URLSearchParams({
        To:
          channel === 'voice'
            ? (input.staffPhone ?? '')
            : channel === 'whatsapp'
              ? `whatsapp:${input.to}`
              : input.to,
        From: channel === 'whatsapp' ? `whatsapp:${input.from}` : input.from,
      });
      if (channel === 'voice') {
        if (
          !/^\+[1-9]\d{7,14}$/.test(input.staffPhone ?? '') ||
          !/^\+[1-9]\d{7,14}$/.test(input.to) ||
          !/^\+[1-9]\d{7,14}$/.test(input.from)
        )
          throw new BadRequestException('Valid staff, member and caller numbers are required');
        form.set(
          'Twiml',
          `<Response><Dial callerId="${input.from}" timeout="20" timeLimit="600"><Number>${input.to}</Number></Dial></Response>`,
        );
        form.set('Timeout', '20');
        form.set('TimeLimit', '660');
      } else if (input.templateId) {
        if (!/^HX[a-fA-F0-9]{32}$/.test(input.templateId))
          throw new BadRequestException('Use a Twilio Content SID for WhatsApp templates');
        form.set('ContentSid', input.templateId);
        if (input.variables) form.set('ContentVariables', JSON.stringify(input.variables));
      } else form.set('Body', input.text);
      const origin = this.config.get<string>('PUBLIC_API_URL');
      if (origin && account.accountId) {
        form.set(
          'StatusCallback',
          `${origin.replace(/\/$/, '')}/api/v1/integrations/webhooks/${account.accountId}`,
        );
      }
      body = form;
    } else if (provider === 'meta' && channel === 'whatsapp') {
      url = `https://graph.facebook.com/v23.0/${c.phoneNumberId}/messages`;
      headers = { Authorization: `Bearer ${c.accessToken}`, 'Content-Type': 'application/json' };
      body = JSON.stringify({
        messaging_product: 'whatsapp',
        to: input.to.replace(/^\+/, ''),
        ...(input.templateId
          ? {
              type: 'template',
              template: {
                name: input.templateId,
                language: { code: input.variables?.language ?? 'en' },
                ...(input.variables
                  ? {
                      components: [
                        {
                          type: 'body',
                          parameters: Object.entries(input.variables)
                            .filter(([key]) => key !== 'language')
                            .map(([, text]) => ({ type: 'text', text })),
                        },
                      ],
                    }
                  : {}),
              },
            }
          : { type: 'text', text: { body: input.text } }),
      });
      externalId = (_response, data) =>
        String((data.messages as { id?: string }[] | undefined)?.[0]?.id ?? '');
    } else if (provider === 'termii' && (channel === 'sms' || channel === 'whatsapp')) {
      const origin = ['https://api.termii.com', 'https://api.ng.termii.com'].includes(c.baseUrl)
        ? c.baseUrl
        : '';
      if (!origin) throw new BadRequestException('Unsupported Termii API origin');
      url = `${origin}/api/${input.templateId ? 'send/template' : 'sms/send'}`;
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(
        input.templateId
          ? {
              api_key: c.apiKey,
              phone_number: input.to.replace(/^\+/, ''),
              device_id: input.from,
              template_id: input.templateId,
              data: input.variables ?? {},
            }
          : {
              api_key: c.apiKey,
              to: input.to.replace(/^\+/, ''),
              from: input.from,
              sms: input.text,
              type: 'plain',
              channel: channel === 'sms' ? 'generic' : 'whatsapp',
            },
      );
    } else throw new BadRequestException('This provider does not support the selected channel');
    const { response, data } = await this.request(url, { method: 'POST', headers, body });
    if (!response.ok)
      throw new BadRequestException(
        `Provider rejected the ${channel} request (HTTP ${response.status})`,
      );
    const id = externalId(response, data);
    if (!id) throw new ServiceUnavailableException('Provider did not confirm acceptance');
    return id;
  }
}
