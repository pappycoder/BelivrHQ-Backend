# Progressive authentication and platform subscriptions

Registration now collects church details, the administrator account, a plan and a review in four animated steps. Values survive moving back; passwords and challenge secrets remain in memory only. After creating the account, sign in (and confirm email/complete MFA if required), then continue to `/subscription`. Existing authenticator enrollment, recovery codes, password recovery and the requested seeded-account picker remain available. The responsive auth shell follows the dashboard teal/cream/lime theme, with reduced-motion support and accessible progress/field labels.

## Organization checkout

- Self-service plans: Essentials ₦10,000/month or ₦108,000/year; Community ₦20,000/month or ₦216,000/year; Network ₦40,000/month or ₦432,000/year. Enterprise exists in `SubscriptionPlan` but requires an agreed quote and cannot be purchased through this fixed-price endpoint.
- `SubscriptionPlan`, `BillingCycle`, `SubscriptionGateway` and `SubscriptionPaymentStatus` are Prisma/PostgreSQL enums. Gateway/status are specific to the platform ledger; church giving also supports manual transactions. Prices live in `src/billing/plans.ts`, keyed by the enum. Never accept an amount from the browser. Frontend wire types are local so each repository builds independently.
- `PlatformSubscription` belongs to the church; `SubscriptionPayment` is a separate organization ledger. Nothing enters church giving reports, and no church integration account is resolved. The platform providers use only server `PAYSTACK_SECRET_KEY` or `FLUTTERWAVE_SECRET_KEY`. Browser-facing database roles cannot access the ledger tables.
- New registrations create an unpaid subscription atomically with church/profile records. Middleware blocks workspace API access until paid and again after expiry. Session/MFA/recovery, own-profile and billing endpoints remain available. All churches require an explicit paid subscription. The development cleanup migration enrolls existing churches as unpaid Essentials/monthly; no previous-workspace exemption remains.
- `billing:read` and `billing:update` protect the API, page actions and account-menu link. Reserved billing grants are removed from all other roles/custom overrides, including HQ. Tenant identity comes from the verified profile, never the request body. Apply the permission migration; the permissions cache namespace is v28.
- Hosted checkout URLs use HTTPS and exact provider host allowlists. Amount, NGN currency, reference and successful provider status must match before activation. A callback URL or `status=success` query cannot grant access. Signed webhooks independently reverify with the provider. Row locks and an atomic claim prevent simultaneous callback/browser retries from extending the period twice.
- Only one pending checkout is allowed per church. Resume that checkout to avoid accidental duplicate payment. An initialization failure releases the slot; an interrupted initialization without a URL releases after two minutes. Its reference remains reconcilable if the provider reports a late successful payment. Returning without a callback still offers “I’ve paid — check payment.” Provider outages preserve the account and offer a retry.
- Periods are prepaid calendar months/years, clamped at month end. Renewal is manual after expiry; there are no automatic card charges or saved authorizations. Plan switching during an active period, refunds/chargebacks and commercial feature/member/staff/branch quota enforcement are not implemented by this change. The marketing plan capacities are not database limits; these require a separate entitlement rollout before treating them as enforced paid-production contracts.

## Deploy

1. Apply `20261019000000_platform_subscriptions` and `20261019010000_remove_legacy_integrations` using the backend migration console (or `npx prisma migrate deploy --config .config/prisma.config.ts`) before deploying the new API. Deploy web/API together.
2. Set `WEB_URL` to the exact frontend origin and configure the **BelivrHQ organization** payment keys on the backend. Configure `FLUTTERWAVE_WEBHOOK_SECRET` when using Flutterwave. No secret belongs in a `NEXT_PUBLIC_` variable.
3. Configure platform merchant callbacks at `PUBLIC_API_URL/api/v1/billing/webhooks/paystack` or `/flutterwave`. The hosted redirect is derived server-side as `WEB_URL/subscription`. Church-specific payment callbacks remain separate. If retiring a previous organization webhook, reconcile its outstanding transactions before switching it.
4. Run test-mode provider acceptance for successful, declined, cancelled and asynchronous payments on the deployed origins, including sign-in/email confirmation/MFA and a browser closed before redirect. Automated tests use provider fixtures and cannot prove live merchant account readiness.
5. Retire seeded credentials before a real production launch as previously planned. Their picker is preserved at the user's explicit request for current testing.

## Development cleanup

`MessagingIntegration`, its credential resolver/controllers/DTOs/modules, old WhatsApp webhook routes, obsolete messaging permissions and the frontend shim are removed. `EmailDeliveryService` handles organization Resend email explicitly and church email through the unified provider account resolver. `MessagingDeliveryService` handles church SMS/WhatsApp/templates through the same resolver. Church payments require their recorded integration account, including settlement after a key rotation; they cannot use organization environment keys. Archived account access for an outstanding payment is part of the current merchant-pinning design, not a compatibility fallback.

Only `INTEGRATIONS_ENCRYPTION_KEY` is used for church account encryption. Set it on API and worker. If development accounts were encrypted using the former key fallback, configure this variable with that same key before use or recreate those test provider accounts. Obsolete `MESSAGING_ENCRYPTION_KEY` and organization Termii environment selectors are removed. Platform authentication email and subscription merchant keys remain.

Historical migration files remain as migration history, so databases already migrated can still deploy. The new cleanup migration drops the obsolete table and permission rows. No deployed database was modified during implementation.

## Schema organization

Enums are grouped at the top. Models are grouped by church/branch structure, platform subscriptions, identity/access, people/households, services/attendance, giving, events, departments/groups, communication, provider accounts, media, pastoral care, assets, forms, offline synchronization and system/webhooks. Reordering was verified with `prisma migrate diff` against the pre-reorder schema: empty migration. Existing model fields/relations are preserved.

## Validation

Backend unit suite, frontend Vitest suite, production builds and targeted lint/type checks. Isolated PostgreSQL migration/HTTP tests cover both organization gateways, signed callbacks, permissions, cross-tenant references, price tampering, currency mismatches, simultaneous initialization/verification, enums and browser-role database denial. Playwright covers the four-step form, edits/retry/validation, billing selection, callback verification/resume, missing gateways, non-billing roles, password recovery/MFA, seeded login and responsive auth/marketing pages. Screenshots are local test artifacts.

Provider contracts: [Paystack verification](https://paystack.com/docs/payments/verify-payments/) and [Flutterwave Standard](https://developer.flutterwave.com/docs/flutterwave-standard-1).

### Final verification

- Backend: production build and scoped lint pass; 1,510 unit tests across 82 suites pass.
- Fresh local PostgreSQL: the complete migration chain and all 126 database/HTTP tests across 12 suites pass; the temporary database was stopped afterward. No deployed data was changed.
- Frontend: production build, TypeScript and scoped lint pass; all 308 Vitest tests pass. The navigation/control audit reports no issues.
- Production-browser fixtures: 36 auth/marketing/integration checks pass, including responsive screenshots, seeded login visibility, MFA/recovery, password reset, registration, checkout and consolidated provider settings. All 17 auth checks also pass after the final login cleanup, which removes an unused Remember Me control and duplicate copyright and aligns the recovery link with the teal theme.
- Provider calls are fixtures. Real merchant acceptance on the deployed origins remains a deployment step. Plan capacity/feature quotas and automated renewals/refunds are separate work.
