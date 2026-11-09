import { ConfigService } from '@nestjs/config';
import { AccountEmailService } from '../../../src/company-email/account-email.service';
import {
  companyEmail,
  givingReceiptEmail,
  invitationEmail,
  passwordResetEmail,
  signInCodeEmail,
  signupConfirmationEmail,
} from '../../../src/company-email/company-email.templates';

const webUrl = 'https://church-os-web.vercel.app';

describe('Company account emails', () => {
  const generateLink = jest.fn();
  const sendEmail = jest.fn();
  const service = new AccountEmailService(
    { client: { auth: { admin: { generateLink } } } } as never,
    new ConfigService({ WEB_URL: webUrl }),
    { sendEmail } as never,
  );
  beforeEach(() => {
    jest.clearAllMocks();
    generateLink.mockResolvedValue({
      data: { properties: { hashed_token: 'one-time-hash' } },
      error: null,
    });
    sendEmail.mockResolvedValue('provider-id');
  });
  it('sends branded recovery with the configured host and usable reset route', async () => {
    await service.sendPasswordReset('person@example.org');
    expect(generateLink).toHaveBeenCalledWith({ type: 'recovery', email: 'person@example.org' });
    const [to, subject, html, churchId, , options] = sendEmail.mock.calls[0];
    expect(to).toBe('person@example.org');
    expect(subject).toBe('Reset your ChurchOS password');
    expect(churchId).toBe('');
    expect(html).toContain(`${webUrl}/reset-password?token_hash=one-time-hash`);
    expect(html).toContain('bgcolor="#ffffff"');
    expect(html).not.toContain('localhost');
    expect(options.text).toContain('one-time-hash');
  });
  it.each([
    { data: null, error: { message: 'unknown user' } },
    { data: { properties: {} }, error: null },
  ])('does not send incomplete recovery links', async (result) => {
    generateLink.mockResolvedValue(result);
    await expect(service.sendPasswordReset('person@example.org')).rejects.toThrow();
    expect(sendEmail).not.toHaveBeenCalled();
  });
  it('reports provider failure to administrator callers', async () => {
    sendEmail.mockRejectedValue(new Error('mail unavailable'));
    await expect(service.sendPasswordReset('person@example.org')).rejects.toThrow(
      'mail unavailable',
    );
  });
  it('escapes church names and presents the code in HTML and plain text', () => {
    const content = signInCodeEmail(
      { churchName: '<script>bad()</script>', code: '012345', expiresInMinutes: 10 },
      webUrl,
    );
    expect(content.html).not.toContain('<script>');
    expect(content.html).toContain('&lt;script&gt;');
    expect(content.text).toContain('Sign-in code: 012345');
    expect(content.html).toContain('ACCOUNT SECURITY');
  });
  it('preserves the Supabase confirmation variable inside the shared design', () => {
    const content = signupConfirmationEmail(webUrl);
    expect(content.html).toContain('href="{{ .ConfirmationURL }}"');
    expect(content.html).toContain('bgcolor="#ffffff"');
  });
  it.each([
    'https://other.example/reset-password?token_hash=x',
    `${webUrl}/auth/reset-password?token_hash=x`,
    `${webUrl}/reset-password`,
    'javascript:alert(1)',
  ])('rejects invalid recovery destinations %s', (link) => {
    expect(() => passwordResetEmail(link, webUrl)).toThrow();
  });
});

describe('shared system email design', () => {
  const samples = [
    ...(['welcome', 'activation', 'renewal', 'upgrade'] as const).map(
      (kind) =>
        [
          kind,
          companyEmail(
            {
              kind,
              churchName: 'Grace Church',
              firstName: 'Ada',
              plan: 'essentials',
              cycle: 'monthly',
              amount: 10,
              currency: 'USD',
              reference: 'COSUB_example',
              paidUntil: new Date('2026-12-09'),
            },
            webUrl,
          ),
        ] as const,
    ),
    [
      'invitation',
      invitationEmail(
        {
          churchName: 'Grace Church',
          firstName: 'Ada',
          inviterName: 'Grace',
          roleLabel: 'Usher',
          acceptUrl: `${webUrl}/accept-invitation#token_hash=sample`,
        },
        webUrl,
      ),
    ],
    ['password reset', passwordResetEmail(`${webUrl}/reset-password?token_hash=sample`, webUrl)],
    [
      'sign-in code',
      signInCodeEmail({ churchName: 'Grace Church', code: '012345', expiresInMinutes: 10 }, webUrl),
    ],
    ['signup confirmation', signupConfirmationEmail(webUrl)],
    [
      'giving receipt',
      givingReceiptEmail(
        {
          churchName: 'Grace Church',
          firstName: 'Ada',
          categoryName: 'Tithe',
          amount: 25000,
          currency: 'NGN',
          receiptNumber: '2026/TIT/0001',
        },
        webUrl,
      ),
    ],
  ] as const;
  it.each(samples)(
    'gives %s an opaque brand asset, usable fallback link, responsive details and plain text',
    (_name, content) => {
      expect(content.html).toContain(`${webUrl}/brand/churchos-logo.png`);
      expect(content.html).not.toContain('churchos-emblem.png');
      expect(content.html).toContain('ChurchOS<span');
      expect(content.html).toContain('bgcolor="#ffffff"');
      expect(content.html).toContain('max-width:480px');
      expect(content.html).toContain('prefers-color-scheme:dark');
      expect(content.html).toContain('Use this link');
      expect(content.html).toContain('<!--[if mso]>');
      expect(content.html).toContain('role="presentation"');
      expect(content.text).toContain('Help Centre:');
      expect(content.text).not.toContain('<table');
    },
  );
  it('makes leading-zero sign-in codes prominent without repeating them in HTML', () => {
    const content = signInCodeEmail(
      { churchName: 'Church', code: '012345', expiresInMinutes: 10 },
      webUrl,
    );
    expect(content.html).toContain('font-family:Consolas');
    expect(content.html).toContain('letter-spacing:7px');
    expect(content.html.match(/012345/g)).toHaveLength(1);
    expect(content.text).toContain('Sign-in code: 012345');
  });
  it('escapes giving details and keeps the church as the receipt sender', () => {
    const content = givingReceiptEmail(
      {
        churchName: '<Church>',
        firstName: '<Ada>',
        categoryName: '<Tithe>',
        amount: 25000,
        currency: 'NGN',
        receiptNumber: '<receipt>',
      },
      webUrl,
    );
    expect(content.html).not.toContain('<Church>');
    expect(content.html).toContain('&lt;Tithe&gt;');
    expect(content.html).toContain('Your PDF receipt is attached');
    expect(content.html).toContain('Sent by &lt;Church&gt; through ChurchOS.');
    expect(content.text).toContain('Thank you for supporting the ministry,\n<Church>');
  });
});
