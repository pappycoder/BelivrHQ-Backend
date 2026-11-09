# BelivrHQ system email design

All nine system templates share one email frame: welcome, subscription activation, renewal, upgrade, staff invitation, password reset, sign-in code, signup confirmation and giving receipt.

## Logo and layout

The header uses the existing `/brand/belivrhq-logo.png` master. This PNG has an opaque white background, so its navy mark stays legible without depending on client CSS to supply a background. The visible BelivrHQ wordmark is live text beside the image, preserving the sender identity when remote images are blocked. No brand image was edited or generated.

The frame uses the Paper palette, serif headings, readable body text, compact detail rows, a clear green action and a quieter footer. Mobile rows stack and long references wrap. Sign-in codes have a dedicated selectable monospace panel that preserves leading zeroes. Light/dark styles are explicit; inline colors, presentation tables, background attributes and an Outlook width wrapper provide the fallback when head styles are stripped. Rounded corners are decorative, and can remain square in clients that do not support them.

Giving receipts retain the church sender and original PDF attachment. Their HTML and plain-text bodies contain the church, giving category, amount and receipt number. Church-authored broadcasts/messages retain their authored content. Account/reset/invitation links, the Supabase confirmation variable, escaping, sender selection and outbox idempotency remain in place. Workspace links now use the current `/home` destination.

## Deploy

Deploy the backend API and email worker together. No new migration, environment variable or frontend code change is needed. The existing frontend must serve the public logo asset at the configured `WEB_URL` origin; local previews use that same repository asset.

For Supabase-managed signup confirmations, upload `docs/previews/company-emails/signup-confirmation.html` in Authentication > Email Templates > Confirm signup and keep the existing subject and `{{ .ConfirmationURL }}` variable. Backend deployment does not replace Supabase's stored template. No provider settings or real emails were changed or sent during this work.

Outbox notifications already hold immutable HTML/text snapshots. Existing queued/sent messages retain their original payloads, so retries do not violate provider idempotency. Newly generated emails use this design.

## Previews and validation

Run `npm run email:preview` to regenerate the nine HTML samples. [Preview index](previews/company-emails/README.md) links to each HTML and desktop PNG; the activation mobile PNG is also refreshed. All sample tokens, codes and payment references are fictional.

Validation: 336 focused unit tests across company emails, giving, notifications and delivery passed, together with TypeScript and scoped lint. Browser checks rendered all nine templates at desktop, 320px mobile and dark mode, tested blocked images and inline-style fallbacks, and checked a long church name: 46 checks passed with all external network requests blocked. These are local browser renders, not evidence of real inbox placement or rendering in every email client. No database or credential changes were made.

## Plain-text delivery references

Receipt alternatives are passed explicitly through the church provider adapters. Provider payloads retain the original HTML, sender and attachment, and include plain text only when the caller supplies a complete alternative. [Resend](https://resend.com/docs/api-reference/emails/send-email), [SendGrid](https://www.twilio.com/docs/sendgrid/api-reference/mail-send/mail-send) and [Mailgun](https://documentation.mailgun.com/docs/mailgun/user-manual/sending-messages/send-http) document these message parts. Transport tests inspect each provider payload without sending an email.
