# Public account email design and password recovery

Public Forgot Password and the administrator Send Password Reset action both generate a recovery token through Supabase Admin without asking Supabase to email it. AccountEmailService sends the branded HTML and plain-text equivalent through the organization Resend account, independent of church subscription/email integrations. A successful administrator response follows provider acceptance; the public endpoint deliberately returns a uniform response when the account is missing or sending fails.

Links use the existing backend WEB_URL only, at `/reset-password?token_hash=…`. The reset page keeps the token in memory, removes it from the visible URL and submits it as a recovery-only token when the user saves a password. No password change occurs from opening the email. Local WEB_URL is now `https://church-os-web.vercel.app`.

Welcome, subscription activation/renewal/upgrade and staff invitations already use the company frame. Password recovery and legacy sign-in codes now use it too, including the opaque white-background logo, Paper layout, green action, footer, escaped dynamic text and plain text. The refreshed design and all nine templates are documented in [Email design](EMAIL-DESIGN-2026-11-09.md). Church-authored broadcasts and integration test messages are separate from public account mail and retain their existing contracts.

## Deploy and provider confirmation template

1. Deploy the backend. No new database migration or frontend change is required.
2. Set the hosted backend WEB_URL to `https://church-os-web.vercel.app`. Keep RESEND_API_KEY and RESEND_FROM configured with a verified sender. The local correction does not change hosted variables or verify sender DNS.
3. In Supabase Authentication → URL Configuration, set Site URL to `https://church-os-web.vercel.app` and allow `https://church-os-web.vercel.app/login` as a redirect. Signup explicitly requests that login destination after verification.
4. Supabase owns signup confirmation delivery when email confirmation is enabled. In Authentication → Email Templates → Confirm signup, set subject to `Confirm your BelivrHQ email address` and paste `docs/previews/company-emails/signup-confirmation.html`. Preserve `{{ .ConfirmationURL }}` exactly. Configure Supabase custom SMTP with the company's verified sender for production confirmation delivery. Do not disable email verification to avoid this step.
5. Verify a real account's forgot-password email reaches its inbox, opens the production reset page and accepts a new password. Check administrator resets, invalid/expired/reused tokens, sign-in codes and signup confirmation as well. Automated provider mocks cannot establish inbox placement.

`npm run email:preview` regenerates the shared HTML previews, including password-reset, sign-in-code and the ready-to-paste signup-confirmation provider template. These files use placeholder recovery tokens/codes, never live credentials.

Provider settings and inbox delivery were not changed or tested against live accounts in this task. Signup confirmation branding requires uploading the supplied template; deploying the API alone cannot change Supabase's stored template.

Provider references: [Supabase email templates](https://supabase.com/docs/guides/auth/auth-email-templates) and [custom SMTP setup](https://supabase.com/docs/guides/auth/auth-smtp).

Validation: 156 targeted backend tests, backend production build and six rendered email checks at 390px/900px passed. No horizontal overflow was observed.
