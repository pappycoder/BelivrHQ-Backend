import { BillingCycle, SubscriptionPlan } from '@prisma/client';

export type CompanyEmailKind = 'welcome' | 'activation' | 'renewal' | 'upgrade';
export interface CompanyEmailInput {
  kind: CompanyEmailKind;
  churchName: string;
  firstName?: string;
  plan: SubscriptionPlan;
  cycle: BillingCycle;
  amount?: number;
  currency?: string;
  reference?: string;
  paidUntil?: Date;
  requiresEmailConfirmation?: boolean;
}
export interface CompanyEmailContent {
  subject: string;
  html: string;
  text: string;
}
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const planNames: Record<SubscriptionPlan, string> = {
  essentials: 'Essentials',
  community: 'Community',
  network: 'Network',
  enterprise: 'Enterprise',
};

/** Table-based, inline-styled HTML remains readable when email clients block images/CSS. */
export function companyEmail(input: CompanyEmailInput, webUrl: string): CompanyEmailContent {
  const origin = new URL(webUrl);
  if (!['https:', 'http:'].includes(origin.protocol) || origin.username || origin.password)
    throw new Error('Invalid ChurchOS website URL');
  const actionUrl = new URL(
    input.kind === 'welcome' ? '/subscription' : '/dashboard',
    origin.origin,
  ).href;
  const billingUrl = new URL('/subscription', origin.origin).href;
  const helpUrl = new URL('/help', origin.origin).href;
  const logoUrl = new URL('/brand/churchos-emblem.png', origin.origin).href;
  const welcome = input.kind === 'welcome';
  const titles = {
    welcome: 'Welcome to ChurchOS.',
    activation: 'Your church is ready to grow.',
    renewal: 'Here’s to another chapter.',
    upgrade: 'More room for your ministry.',
  };
  const subjects = {
    welcome: 'Welcome to ChurchOS: your next chapter starts here',
    activation: 'Your ChurchOS subscription is active',
    renewal: 'Your ChurchOS renewal is confirmed',
    upgrade: 'Your ChurchOS plan upgrade is confirmed',
  };
  const title = titles[input.kind];
  const subject = subjects[input.kind];
  const greeting = input.firstName ? `Hello ${input.firstName},` : 'Hello,';
  const lead = welcome
    ? `Thank you for choosing ChurchOS for ${input.churchName}. Your account and church workspace have been created. We’re glad you’re here.`
    : input.kind === 'renewal'
      ? `Thank you for renewing ChurchOS for ${input.churchName}. Your payment has been confirmed and your new subscription period is in place.`
      : input.kind === 'upgrade'
        ? `Your payment has been confirmed and ${input.churchName} has moved to the ${planNames[input.plan]} plan. Your team can now use the features included in your new plan.`
        : `Your payment has been confirmed and the ${planNames[input.plan]} plan is now active for ${input.churchName}. Your team can start using your church workspace.`;
  const rows: [string, string][] = [
    ['Church', input.churchName],
    [welcome ? 'Selected plan' : 'Plan', planNames[input.plan]],
    ['Billing cycle', input.cycle === 'annual' ? 'Yearly' : 'Monthly'],
  ];
  if (!welcome) {
    if (
      input.amount === undefined ||
      !input.currency ||
      !input.reference ||
      !input.paidUntil ||
      !Number.isFinite(input.paidUntil.getTime())
    )
      throw new Error('Confirmed billing details are required');
    rows.push([
      'Amount paid',
      new Intl.NumberFormat('en-NG', {
        style: 'currency',
        currency: input.currency,
        currencyDisplay: 'code',
      }).format(input.amount),
    ]);
    rows.push(['Payment reference', input.reference]);
    rows.push([
      'Access through',
      new Intl.DateTimeFormat('en-NG', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'Africa/Lagos',
      }).format(input.paidUntil),
    ]);
  }
  const next = welcome
    ? `${input.requiresEmailConfirmation ? 'Complete the email verification requested at registration, then sign in. ' : ''}Choose or review your plan and complete payment to activate your workspace. You can then add your people, record attendance and giving, and invite your team.`
    : input.kind === 'upgrade'
      ? 'Your current billing cycle and renewal date stay the same. Review your updated plan and access period in Plan & Billing.'
      : 'Your renewal is manual. When your next renewal is due, open Plan & Billing to review your plan and complete payment.';
  const cta = welcome ? 'Review your plan' : 'Open your workspace';
  const preheader = welcome
    ? 'A stronger foundation for the people behind your ministry.'
    : `${planNames[input.plan]} · ${input.kind === 'renewal' ? 'Renewal confirmed' : 'Payment confirmed'} · ${input.churchName}`;
  return companyEmailFrame({
    subject,
    title,
    greeting,
    lead,
    rows,
    next,
    cta,
    preheader,
    actionUrl,
    billingUrl,
    helpUrl,
    logoUrl,
    showBillingLink: !welcome,
    headerTag: welcome ? 'WELCOME TO YOUR NEXT CHAPTER' : 'PAYMENT CONFIRMED',
    sectionHeading: welcome ? 'A simple next step' : 'What happens next',
  });
}

interface CompanyEmailFrameInput {
  subject: string;
  title: string;
  greeting: string;
  lead: string;
  rows: [string, string][];
  next: string;
  cta: string;
  preheader: string;
  actionUrl: string;
  billingUrl: string;
  helpUrl: string;
  logoUrl: string;
  headerTag: string;
  sectionHeading: string;
  showBillingLink: boolean;
}
function companyEmailFrame({
  subject,
  title,
  greeting,
  lead,
  rows,
  next,
  cta,
  preheader,
  actionUrl,
  billingUrl,
  helpUrl,
  logoUrl,
  headerTag,
  sectionHeading,
  showBillingLink,
}: CompanyEmailFrameInput): CompanyEmailContent {
  const details = rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding:12px 16px;border-bottom:1px solid #dfe8e5;color:#55716b;font-size:13px;vertical-align:top;width:38%">${escape(label)}</td><td style="padding:12px 16px;border-bottom:1px solid #dfe8e5;color:#123c35;font-size:14px;font-weight:600;overflow-wrap:anywhere">${escape(value)}</td></tr>`,
    )
    .join('');
  const html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${escape(subject)}</title></head><body style="margin:0;padding:0;background:#eef4f1;color:#123c35;font-family:Arial,Helvetica,sans-serif"><div style="display:none;max-height:0;overflow:hidden;opacity:0">${escape(preheader)}</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#eef4f1"><tr><td align="center" style="padding:32px 16px"><table role="presentation" width="600" cellspacing="0" cellpadding="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid #dfe8e5;border-radius:20px;overflow:hidden"><tr><td style="height:6px;background:#c8f169"></td></tr><tr><td style="padding:28px 32px;background:#123c35"><table role="presentation" cellspacing="0" cellpadding="0"><tr><td style="padding-right:12px"><table role="presentation" cellspacing="0" cellpadding="0" bgcolor="#ffffff" style="background-color:#ffffff;border-radius:9px"><tr><td bgcolor="#ffffff" style="padding:6px;background-color:#ffffff;border-radius:9px"><img src="${escape(logoUrl)}" width="38" height="38" alt="" style="display:block;border:0;background-color:#ffffff"></td></tr></table></td><td style="font-size:25px;font-weight:700;letter-spacing:-1px;color:#ffffff">ChurchOS<span style="color:#c8f169">.</span></td></tr></table><p style="margin:17px 0 0;font-size:11px;letter-spacing:2px;font-weight:700;color:#c8f169">${escape(headerTag)}</p></td></tr><tr><td style="padding:32px"><h1 style="margin:0 0 24px;font-size:30px;line-height:1.2;letter-spacing:-1px;color:#123c35">${escape(title)}</h1><p style="margin:0 0 12px;font-size:16px;line-height:1.7;color:#244d45">${escape(greeting)}</p><p style="margin:0 0 24px;font-size:16px;line-height:1.7;color:#42645c">${escape(lead)}</p><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #dfe8e5;border-radius:12px;background:#f7faf8">${details}</table><h2 style="margin:28px 0 10px;font-size:17px;color:#123c35">${escape(sectionHeading)}</h2><p style="margin:0 0 26px;font-size:14px;line-height:1.8;color:#55716b">${escape(next)}</p><table role="presentation" cellspacing="0" cellpadding="0"><tr><td style="background:#c8f169;border-radius:9px"><a href="${escape(actionUrl)}" style="display:inline-block;padding:15px 23px;color:#123c35;font-size:14px;font-weight:700;text-decoration:none">${escape(cta)} &rarr;</a></td></tr></table>${!showBillingLink ? '' : `<p style="margin:20px 0 0;font-size:13px;color:#55716b"><a href="${escape(billingUrl)}" style="color:#12665a">View Plan &amp; Billing</a> for your payment history and renewal details.</p>`}<p style="margin:28px 0 0;font-size:14px;line-height:1.7;color:#55716b">With you in the work,<br><strong style="color:#123c35">The ChurchOS team</strong></p></td></tr><tr><td style="padding:22px 32px;background:#f7faf8;border-top:1px solid #dfe8e5"><p style="margin:0 0 8px;color:#55716b;font-size:12px;line-height:1.7">Built for the people behind your ministry.</p><p style="margin:0;color:#6b817b;font-size:11px;line-height:1.8">This is an account notification from ChurchOS. <a href="${escape(helpUrl)}" style="color:#12665a">Visit the Help Centre</a> or use Contact support in your workspace.</p></td></tr></table></td></tr></table></body></html>`;
  const text = `${subject}\n\n${greeting}\n\n${lead}\n\n${rows.map(([label, value]) => `${label}: ${value}`).join('\n')}\n\n${next}\n\n${cta}: ${actionUrl}\n${showBillingLink ? `Plan & Billing: ${billingUrl}\n` : ''}Help Centre: ${helpUrl}\n\nThe ChurchOS team\nBuilt for the people behind your ministry.`;
  return { subject, html, text };
}

export interface InvitationEmailInput {
  churchName: string;
  firstName: string;
  inviterName: string;
  roleLabel: string;
  acceptUrl: string;
}

export function invitationEmail(input: InvitationEmailInput, webUrl: string): CompanyEmailContent {
  const origin = new URL(webUrl).origin;
  const accept = new URL(input.acceptUrl);
  if (
    accept.origin !== origin ||
    accept.pathname !== '/accept-invitation' ||
    !new URLSearchParams(accept.hash.slice(1)).get('token_hash')
  )
    throw new Error('Invalid ChurchOS invitation destination');
  return companyEmailFrame({
    subject: `You’re invited to ${input.churchName} on ChurchOS`,
    title: 'Your team is waiting.',
    greeting: `Hello ${input.firstName},`,
    lead: `${input.inviterName} has invited you to join ${input.churchName} on ChurchOS. We’re glad to help you serve your church together.`,
    rows: [
      ['Church', input.churchName],
      ['Your role', input.roleLabel],
    ],
    next: 'Accept your invitation and create your own password. Then sign in using this email address and your new password. This link can be used once. If it has expired, request a password link from the sign-in page. If you weren’t expecting this invitation, you can ignore this email.',
    cta: 'Accept invitation',
    preheader: `Join ${input.churchName} and set up your ChurchOS account.`,
    actionUrl: accept.href,
    billingUrl: new URL('/subscription', origin).href,
    helpUrl: new URL('/help', origin).href,
    logoUrl: new URL('/brand/churchos-emblem.png', origin).href,
    headerTag: 'YOU’RE INVITED',
    sectionHeading: 'Make yourself at home',
    showBillingLink: false,
  });
}

function accountEmailLinks(webUrl: string) {
  const url = new URL(webUrl);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Invalid ChurchOS website URL');
  return {
    billingUrl: new URL('/subscription', url.origin).href,
    helpUrl: new URL('/help', url.origin).href,
    logoUrl: new URL('/brand/churchos-emblem.png', url.origin).href,
    showBillingLink: false,
  };
}

export function passwordResetEmail(resetUrl: string, webUrl: string): CompanyEmailContent {
  const links = accountEmailLinks(webUrl);
  const reset = new URL(resetUrl);
  if (
    reset.origin !== new URL(webUrl).origin ||
    reset.pathname !== '/reset-password' ||
    !reset.searchParams.get('token_hash') ||
    reset.username ||
    reset.password
  )
    throw new Error('Invalid ChurchOS recovery destination');
  return companyEmailFrame({
    ...links,
    subject: 'Reset your ChurchOS password',
    title: 'A fresh start, securely.',
    greeting: 'Hello,',
    lead: 'We received a request to reset your ChurchOS password. Choose a new password to get back to your church workspace.',
    rows: [
      ['Request', 'Password reset'],
      ['Link', 'One-time use'],
    ],
    next: 'Select Reset password to choose your new password, then sign in with your email address. This link expires and can be used once. If it has expired, request a new link from the sign-in page. If you did not request this, ignore this email; your password will stay the same.',
    cta: 'Reset password',
    preheader: 'A secure link to reset your ChurchOS password.',
    actionUrl: reset.href,
    headerTag: 'ACCOUNT SECURITY',
    sectionHeading: 'Get back to your workspace',
  });
}

export function signInCodeEmail(
  input: { churchName: string; code: string; expiresInMinutes: number },
  webUrl: string,
): CompanyEmailContent {
  if (!/^\d{6}$/.test(input.code)) throw new Error('Invalid sign-in code');
  return companyEmailFrame({
    ...accountEmailLinks(webUrl),
    subject: 'Your ChurchOS sign-in code',
    title: 'Your secure sign-in code.',
    greeting: 'Hello,',
    lead: `Use this code to complete your sign-in to ${input.churchName}.`,
    rows: [
      ['Sign-in code', input.code],
      ['Expires in', `${input.expiresInMinutes} minutes`],
    ],
    next: 'Enter this code in the sign-in screen you already have open. Never share it with anyone. If you did not try to sign in, ignore this email.',
    cta: 'Go to sign in',
    preheader: 'Complete your ChurchOS sign-in securely.',
    actionUrl: new URL('/login', webUrl).href,
    headerTag: 'ACCOUNT SECURITY',
    sectionHeading: 'Keep your account safe',
  });
}

/** Upload this rendered HTML as the Supabase Confirm signup email template. */
export function signupConfirmationEmail(webUrl: string): CompanyEmailContent {
  return companyEmailFrame({
    ...accountEmailLinks(webUrl),
    subject: 'Confirm your ChurchOS email address',
    title: 'You’re one step closer.',
    greeting: 'Hello,',
    lead: 'Confirm your email address to continue setting up your ChurchOS account and church workspace.',
    rows: [['Request', 'Email confirmation']],
    next: 'Select Confirm email to verify your address. If this link has expired, return to the sign-in page for help. If you did not create a ChurchOS account, ignore this email.',
    cta: 'Confirm email',
    preheader: 'Confirm your email address to get started with ChurchOS.',
    actionUrl: '{{ .ConfirmationURL }}',
    headerTag: 'WELCOME TO CHURCHOS',
    sectionHeading: 'Verify your email address',
  });
}
