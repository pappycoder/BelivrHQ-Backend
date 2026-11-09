import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  companyEmail,
  givingReceiptEmail,
  CompanyEmailKind,
  invitationEmail,
  passwordResetEmail,
  signInCodeEmail,
  signupConfirmationEmail,
} from '../src/company-email/company-email.templates';
const webUrl = 'https://church-os-web.vercel.app';
const directory = join(process.cwd(), 'docs', 'previews', 'company-emails');
mkdirSync(directory, { recursive: true });
for (const kind of ['welcome', 'activation', 'renewal', 'upgrade'] as CompanyEmailKind[]) {
  const content = companyEmail(
    {
      kind,
      churchName: 'Grace Community Church',
      firstName: 'Grace',
      plan: kind === 'upgrade' ? 'community' : 'essentials',
      cycle: 'monthly',
      amount: 10,
      currency: 'USD',
      reference: 'BHQSUB_' + 'a'.repeat(32),
      paidUntil: new Date('2026-11-22T12:00:00.000Z'),
      requiresEmailConfirmation: true,
    },
    webUrl,
  );
  writeFileSync(join(directory, kind + '.html'), content.html + '\n');
}
const invitation = invitationEmail(
  {
    churchName: 'Grace Community Church',
    firstName: 'Ada',
    inviterName: 'Grace Admin',
    roleLabel: 'Church Admin',
    acceptUrl: 'https://church-os-web.vercel.app/accept-invitation#token_hash=preview-only',
  },
  'https://church-os-web.vercel.app',
);
writeFileSync(join(directory, 'invitation.html'), invitation.html + '\n');
console.log(`Email previews written to ${directory}`);

for (const [name, content] of [
  [
    'password-reset',
    passwordResetEmail(`${webUrl}/reset-password?token_hash=preview-only`, webUrl),
  ],
  [
    'sign-in-code',
    signInCodeEmail(
      { churchName: 'Grace Community Church', code: '123456', expiresInMinutes: 10 },
      webUrl,
    ),
  ],
  ['signup-confirmation', signupConfirmationEmail(webUrl)],
  [
    'giving-receipt',
    givingReceiptEmail(
      {
        churchName: 'Grace Community Church',
        firstName: 'Ada',
        categoryName: 'Tithe',
        amount: 25000,
        currency: 'NGN',
        receiptNumber: '2026/TIT/0001',
      },
      webUrl,
    ),
  ],
] as const)
  writeFileSync(join(directory, `${name}.html`), content.html + '\n');
