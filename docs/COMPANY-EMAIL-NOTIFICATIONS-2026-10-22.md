# BelivrHQ company email notifications — 22 October 2026

Registration now creates a branded welcome notification for the registering administrator. It confirms account/workspace creation, names the selected plan/cycle and directs the user to verification and Plan & Billing. It does not imply that payment succeeded or that an unpaid workspace is active. Supabase's existing email-verification flow remains separate.

A verified, applied subscription payment creates one company confirmation. The first paid period receives an activation email; later periods receive a renewal email; an applied upgrade receives an upgrade email. The message shows the church, plan, billing cycle, actual amount/currency paid, payment reference and access-through date. Renewals remain manual. Upgrade emails explain that the existing renewal date stays in place. Pending, failed, reversed, mismatched or review-only payments do not generate activation confirmations.

## Branding and recipients

The templates use the official BelivrHQ emblem, deep teal/lime palette, responsive table layout, plain-text alternative, and workspace/billing/help links derived exclusively from server-configured WEB_URL. All account-supplied text is HTML-escaped. No passwords, tokens, provider credentials or payment authorization details are included. Dates use Africa/Lagos and the amount uses the immutable payment's currency and value.

Registration mail goes to the signup email. New checkouts freeze the authenticated payer's email in subscription_payments.billing_email. Pending legacy attempts without that field fall back to the church's billing/contact email. A legacy payment without a valid recipient still applies successfully and logs a generic review warning instead of manufacturing a recipient.

These are organization account emails, available on every plan including unpaid registration and Essentials. They use RESEND_API_KEY/RESEND_FROM, independently of church-owned email integration settings and Community's communication feature. They do not create church Message rows or send to the entire staff list.

## Reliability

The company_email_notifications outbox is written in the same transaction as church/profile registration or the verified subscription update. A rollback removes the notification too. Unique event keys prevent duplicate registration/payment events. Delivery happens only after commit, with a best-effort immediate attempt so a healthy serverless request can send without waiting for a worker. Failures cannot undo committed registration or payment activation.

The persistent worker scans due notifications every minute, in bounded batches. Atomic database leases prevent simultaneous sends by HTTP instances/workers. Each message freezes its recipient, sender, subject, HTML and text so retries reuse the exact same provider payload and a stable idempotency key. A worker can recover an expired lease after a process restart.

Resend retains idempotency keys for 24 hours: see [Resend's idempotency documentation](https://resend.com/changelog/idempotency-keys). Automatic retries stop after eight attempts or 23 hours from the first attempt, whichever comes first. Expired/failed notifications stay available for operator review; inspect provider acceptance before any manual requeue. Missing sender credentials leave notifications pending without consuming attempts. Status "sent" means the provider accepted the email, not proof that it reached the recipient's inbox.

The table is server-only, has RLS enabled and denies anon/authenticated database roles. It contains email contents and must be treated as private account data. There is no public read/replay endpoint. Existing successfully applied payments predating this feature are not retroactively emailed.

## Deployment

1. Apply migration 20261022180000_company_email_notifications and regenerate Prisma Client before deploying code. It adds the nullable billing-email snapshot and the private outbox table.
2. Configure the organization's RESEND_API_KEY and a verified-domain RESEND_FROM (for example, BelivrHQ <noreply@your-verified-domain>). Set WEB_URL to the public HTTPS web origin so email buttons and branding work outside local development.
3. Deploy API and persistent worker together. The existing worker command sets ENABLE_QUEUE_WORKERS=true and runs the retry scheduler. A serverless HTTP deployment alone sends immediate attempts but cannot guarantee background recovery.
4. Monitor pending/failed outbox entries and provider delivery results. Email failure does not change account/subscription state.

No live migration, registration, payment, email delivery, provider configuration or deployment was performed during implementation. PostgreSQL checks ran only against an isolated local test database, and all email/payment providers were mocked.

## Previews and validation

Run npm run email:preview to regenerate the standalone example HTML files in docs/previews/company-emails. The samples use fictional account details and a sample payment reference. Desktop PNGs and a mobile activation preview are also available in that directory. Local visual checks mocked the public logo asset and blocked external network requests; the 375px-wide preview has no horizontal overflow.

Validation covers registration/billing flow regressions, template escaping/plain text, organization sender/idempotency transport, duplicate callback races, transaction rollback, concurrent sender claims, retry-scheduler recovery, payer selection, and denial of ordinary database-role reads. The backend production build and targeted lint/type checks passed.
