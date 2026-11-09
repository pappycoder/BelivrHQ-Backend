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
  const actionUrl = new URL(input.kind === 'welcome' ? '/subscription' : '/home', origin.origin)
    .href;
  const billingUrl = new URL('/subscription', origin.origin).href;
  const helpUrl = new URL('/help', origin.origin).href;
  const logoUrl = new URL('/brand/churchos-logo.png', origin.origin).href;
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
  verificationCode?: string;
  signoff?: string;
  senderName?: string;
  footerNote?: string;
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
  verificationCode,
  signoff = 'With you in the work,',
  senderName = 'The ChurchOS team',
  footerNote = 'An account notification from ChurchOS. Need a hand?',
}: CompanyEmailFrameInput): CompanyEmailContent {
  const details = rows
    .filter(([label]) => !verificationCode || label !== 'Sign-in code')
    .map(([label, value], index, visibleRows) => {
      const border = index === visibleRows.length - 1 ? '' : 'border-bottom:1px solid #e0e7e2;';
      return `<tr>
        <td class="detail-label" width="36%" style="padding:13px 18px;${border}color:#52665e;font-size:13px;line-height:1.5;vertical-align:top">${escape(label)}</td>
        <td class="detail-value" style="padding:13px 18px;${border}color:#123c35;font-size:14px;line-height:1.5;font-weight:600;vertical-align:top;overflow-wrap:anywhere;word-break:break-word">${escape(value)}</td>
      </tr>`;
    })
    .join('');
  const html = `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <meta name="format-detection" content="telephone=no,date=no,address=no,email=no">
  <title>${escape(subject)}</title>
  <!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
  <style>
    :root { color-scheme: light dark; supported-color-schemes: light dark; }
    body, table, td, a { -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
    table { border-collapse:collapse; mso-table-lspace:0pt; mso-table-rspace:0pt; }
    img { -ms-interpolation-mode:bicubic; }
    a[x-apple-data-detectors] { color:inherit!important; text-decoration:none!important; }
    @media only screen and (max-width:480px) {
      .outer-pad { padding:20px 12px!important; }
      .content-pad { padding:24px 22px!important; }
      .brand-pad { padding:22px!important; }
      .email-title { font-size:30px!important; }
      .detail-label, .detail-value { display:block!important; width:auto!important; }
      .detail-label { padding:12px 16px 3px!important; border-bottom:0!important; font-size:12px!important; }
      .detail-value { padding:0 16px 12px!important; }
      .action-table, .action-cell, .action-link { width:100%!important; }
      .action-link { box-sizing:border-box!important; text-align:center!important; }
    }
    @media (prefers-color-scheme:dark) {
      .email-page { background-color:#16211d!important; }
      .email-card { background-color:#20312a!important; border-color:#3b5146!important; }
      .email-panel { background-color:#283e33!important; border-color:#3b5146!important; }
      .email-heading, .detail-value { color:#f4f6ef!important; }
      .email-copy, .detail-label { color:#c8d4cb!important; }
      .email-muted { color:#b0c2b5!important; }
      .email-link { color:#c8f169!important; }
      .email-tag { color:#c8f169!important; }
      .detail-label, .detail-value { border-color:#3b5146!important; }
      .email-footer, .brand-pad { border-color:#3b5146!important; }
    }
  </style>
</head>
<body class="email-page" bgcolor="#f4f4ee" style="margin:0;padding:0;width:100%;background-color:#f4f4ee;color:#123c35;font-family:Arial,Helvetica,sans-serif;overflow-wrap:anywhere;word-break:break-word">
  <div style="display:none!important;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all">${escape(preheader)}</div>
  <table role="presentation" class="email-page" width="100%" cellspacing="0" cellpadding="0" bgcolor="#f4f4ee" style="width:100%;background-color:#f4f4ee">
    <tr><td class="outer-pad" align="center" style="padding:40px 16px">
      <!--[if mso]><table role="presentation" width="600" cellspacing="0" cellpadding="0"><tr><td><![endif]-->
      <table role="presentation" class="email-card" width="100%" cellspacing="0" cellpadding="0" bgcolor="#ffffff" style="width:100%;max-width:600px;border-collapse:separate;border-spacing:0;background-color:#ffffff;border-collapse:separate;border-spacing:0;border:1px solid #e0e7e2;border-radius:16px">
        <tr><td class="brand-pad" style="padding:26px 36px;border-bottom:1px solid #e0e7e2">
          <table role="presentation" cellspacing="0" cellpadding="0"><tr>
            <td width="68" valign="middle" style="width:68px;padding-right:14px">
              <table role="presentation" cellspacing="0" cellpadding="0" bgcolor="#ffffff" style="background-color:#ffffff;border-collapse:separate;border-spacing:0;border:1px solid #e0e7e2;border-radius:12px"><tr>
                <td width="64" height="64" bgcolor="#ffffff" style="width:64px;height:64px;background-color:#ffffff;border-radius:12px">
                  <img src="${escape(logoUrl)}" width="64" height="64" alt="" style="display:block;width:64px;height:64px;border:0;border-radius:12px;background-color:#ffffff">
                </td>
              </tr></table>
            </td>
            <td valign="middle"><p class="email-heading" style="margin:0;font-size:27px;line-height:1.2;font-weight:700;letter-spacing:-1px;color:#123c35">ChurchOS<span style="color:#6f8d39">.</span></p><p class="email-muted" style="margin:5px 0 0;font-size:12px;line-height:1.5;color:#66796d">Your church, connected.</p></td>
          </tr></table>
        </td></tr>
        <tr><td class="content-pad" style="padding:30px 36px 34px">
          <p class="email-tag" style="margin:0 0 12px;font-size:10px;line-height:1.6;letter-spacing:1.6px;font-weight:700;color:#537c36">${escape(headerTag)}</p>
          <h1 class="email-title email-heading" style="margin:0 0 22px;font-family:Georgia,'Times New Roman',serif;font-size:36px;line-height:1.15;font-weight:400;letter-spacing:-1px;color:#123c35">${escape(title)}</h1>
          <p class="email-copy" style="margin:0 0 10px;font-size:16px;line-height:1.6;color:#314f42">${escape(greeting)}</p>
          <p class="email-copy" style="margin:0 0 22px;font-size:16px;line-height:1.6;color:#314f42">${escape(lead)}</p>
          ${!verificationCode ? '' : `<table role="presentation" class="email-panel" width="100%" cellspacing="0" cellpadding="0" bgcolor="#f3f7ee" style="width:100%;margin-bottom:14px;border-collapse:separate;border-spacing:0;background-color:#f3f7ee;border:1px solid #e0e7e2;border-radius:12px"><tr><td align="center" style="padding:22px 16px"><p class="email-muted" style="margin:0 0 10px;font-size:11px;letter-spacing:1px;color:#52665e">YOUR SIGN-IN CODE</p><p class="email-heading" dir="ltr" style="margin:0;font-family:Consolas,'Courier New',monospace;font-size:34px;font-weight:700;line-height:1.3;letter-spacing:7px;white-space:nowrap;color:#123c35">${escape(verificationCode)}</p></td></tr></table>`}
          <table role="presentation" class="email-panel" width="100%" cellspacing="0" cellpadding="0" bgcolor="#f7f9f4" style="width:100%;table-layout:fixed;border-collapse:separate;border-spacing:0;border:1px solid #e0e7e2;border-radius:12px;background-color:#f7f9f4">${details}</table>
          <h2 class="email-heading" style="margin:24px 0 8px;font-size:15px;line-height:1.5;font-weight:700;color:#123c35">${escape(sectionHeading)}</h2>
          <p class="email-copy" style="margin:0 0 24px;font-size:14px;line-height:1.65;color:#52665e">${escape(next)}</p>
          <table role="presentation" class="action-table" cellspacing="0" cellpadding="0" style="border-collapse:separate;border-spacing:0"><tr>
            <td class="action-cell" align="center" bgcolor="#123c35" style="background-color:#123c35;border:1px solid #123c35;border-radius:8px;mso-padding-alt:15px 24px">
              <a class="action-link" href="${escape(actionUrl)}" style="display:inline-block;padding:15px 24px;border:1px solid #123c35;border-radius:8px;background-color:#123c35;color:#ffffff;font-size:14px;line-height:1.4;font-weight:700;text-decoration:none;mso-padding-alt:0">${escape(cta)} &rarr;</a>
            </td>
          </tr></table>
          <p class="email-muted" style="margin:14px 0 0;font-size:12px;line-height:1.6;color:#66796d">Button not opening? <a class="email-link" href="${escape(actionUrl)}" style="color:#12665a;text-decoration:underline">Use this link</a>.</p>
          ${!showBillingLink ? '' : `<p class="email-muted" style="margin:14px 0 0;font-size:13px;line-height:1.6;color:#66796d"><a class="email-link" href="${escape(billingUrl)}" style="color:#12665a">View Plan &amp; Billing</a> for your payment history and renewal details.</p>`}
          <p class="email-copy" style="margin:26px 0 0;font-size:14px;line-height:1.6;color:#52665e">${escape(signoff)}<br><strong class="email-heading" style="color:#123c35">${escape(senderName)}</strong></p>
        </td></tr>
        <tr><td class="content-pad email-panel email-footer" bgcolor="#f7f9f4" style="padding:22px 36px;border-radius:0 0 15px 15px;background-color:#f7f9f4;border-top:1px solid #e0e7e2">
          <p class="email-heading" style="margin:0 0 8px;font-size:12px;line-height:1.6;font-weight:600;color:#123c35">A little more room for what matters.</p>
          <p class="email-muted" style="margin:0;font-size:11px;line-height:1.7;color:#66796d">${escape(footerNote)} <a class="email-link" href="${escape(helpUrl)}" style="color:#12665a">Help Centre</a></p>
        </td></tr>
      </table>
      <!--[if mso]></td></tr></table><![endif]-->
      <p class="email-muted" style="margin:18px 0 0;font-size:10px;line-height:1.6;color:#66796d">ChurchOS &middot; Built for the people behind your ministry.</p>
    </td></tr>
  </table>
</body></html>`.replace(/[ \t]+$/gm, '');
  const text = `${subject}\n\n${greeting}\n\n${lead}\n\n${rows.map(([label, value]) => `${label}: ${value}`).join('\n')}\n\n${sectionHeading}\n${next}\n\n${cta}: ${actionUrl}\n${showBillingLink ? `Plan & Billing: ${billingUrl}\n` : ''}Help Centre: ${helpUrl}\n\n${signoff}\n${senderName}\nBuilt for the people behind your ministry.`;
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
    logoUrl: new URL('/brand/churchos-logo.png', origin).href,
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
    logoUrl: new URL('/brand/churchos-logo.png', url.origin).href,
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
    verificationCode: input.code,
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

export function givingReceiptEmail(
  input: {
    churchName: string;
    firstName: string;
    categoryName: string;
    amount: number;
    currency: string;
    receiptNumber: string;
  },
  webUrl: string,
): CompanyEmailContent {
  return companyEmailFrame({
    ...accountEmailLinks(webUrl),
    subject: `Your receipt from ${input.churchName}`,
    title: 'Thank you for your generosity.',
    greeting: `Hello ${input.firstName},`,
    lead: `Your giving to ${input.churchName} has been received. Your PDF receipt is attached for your records.`,
    rows: [
      ['Church', input.churchName],
      ['Giving', input.categoryName],
      [
        'Amount',
        new Intl.NumberFormat('en-NG', {
          style: 'currency',
          currency: input.currency,
          currencyDisplay: 'code',
        }).format(input.amount),
      ],
      ['Receipt number', input.receiptNumber],
    ],
    next: 'Keep the attached receipt for your records. If you have a question about this gift, contact your church office.',
    cta: 'Open your workspace',
    preheader: `Your ${input.categoryName} receipt from ${input.churchName}.`,
    actionUrl: new URL('/home', webUrl).href,
    headerTag: 'GIVING RECEIPT',
    sectionHeading: 'Your receipt is attached',
    signoff: 'Thank you for supporting the ministry,',
    senderName: input.churchName,
    footerNote: `Sent by ${input.churchName} through ChurchOS.`,
  });
}
