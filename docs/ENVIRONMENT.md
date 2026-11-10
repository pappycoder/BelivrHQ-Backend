# Environment configuration

Copy `.env.example` to `.env` and configure the required connections. The active file should contain credentials, deployment-specific origins, custom buckets and deliberate overrides. Standard defaults do not need entries in the active file. The example is a full reference with required connections, explicit key slots, feature-specific credentials and supported reusable defaults. Missing unique secrets are blank slots, not generated values.

## Runtime defaults

| Setting | Default |
| --- | --- |
| `NODE_ENV` | `development`; production hosting must set `production` |
| `PORT` | `3001` |
| `DB_POOL_MAX` | `10` for persistent processes |
| `DB_SERVERLESS_POOL_MAX` | `1` on serverless hosts |
| `DB_IDLE_TIMEOUT_MS` | `10000` for persistent processes; `1000` on serverless hosts |
| `DB_CONNECT_TIMEOUT_MS` | `15000` |
| `SUPABASE_STORAGE_BUCKET` | `media` |
| `SUPABASE_PRIVATE_STORAGE_BUCKET` | `media-private` |
| `RESEND_FROM` | `noreply@churchos.app`; override with a verified sender when needed |
| `SUBSCRIPTION_PAYSTACK_CURRENCIES` | `NGN` |
| `SUBSCRIPTION_FLUTTERWAVE_CURRENCIES` | `NGN` |
| `ENABLE_SMS_FALLBACK` | Off; explicit `true` enables fallback through the church's SMS account |
| `ASK_BELIVRHQ_AI_ENABLED` | Off |
| `ASK_BELIVRHQ_CHURCH_DAILY_USD` | `0.25` |
| `ASK_BELIVRHQ_GLOBAL_DAILY_USD` | `2` |
| `ASK_BELIVRHQ_GLOBAL_DAILY_REQUESTS` | `2000` |
| `LOG_LEVEL` | `info` |
| `ENABLE_SWAGGER` | Off in production; documentation is available in development |
| `ENABLE_QUEUE_WORKERS` | On for persistent processes, off on detected serverless hosts; `start:worker` enables processors explicitly |

Database validation and runtime pooling share the same defaults. Explicit overrides are still supported. Do not copy persistent-process idle defaults into a serverless environment unless that override is intentional.

## Required and environment-specific values

Keep `DATABASE_URL`, Supabase URL/service-role/anon credentials, `REDIS_URL` and `ALTCHA_HMAC_KEY`. Keep `WEB_URL` explicitly configured: company emails require it, and production links must use a public HTTPS origin. `PUBLIC_API_URL` is required for provider signature validation and automatic callback URLs when those integrations are used. Custom storage buckets and verified sender addresses must remain explicit.

An HTTPS Upstash connection also requires `UPSTASH_REDIS_TOKEN`. This REST endpoint does not supply BullMQ's TCP transport. The outstanding production worker/TCP configuration is described in the rebrand rollout notes; this cleanup does not provision it.

Preserve encryption keys for existing data. `PASTORAL_ENCRYPTION_KEY` is required in production, `INTEGRATIONS_ENCRYPTION_KEY` enables encrypted provider accounts, and `TWO_FACTOR_ENCRYPTION_KEY` enables backend authenticator setup/verification. Blank optional keys do not enable those features. Do not replace an existing key with a newly generated one during configuration cleanup.

Organization Flutterwave, historical Paystack verification, Resend and optional AI credentials are needed only for enabled features. Church-owned messaging/payment credentials belong in Integrations, not global environment variables. AI model/rate settings have no guessed defaults: paid answers require an explicit model and valid current rates.

## Removed settings

`SUPABASE_JWT_SECRET`, `PAYSTACK_PUBLIC_KEY` and `MAX_FILE_SIZE_MB` were only declared in the validation schema, with no runtime consumer. JWT verification uses JWKS, hosted checkout uses server secret keys, and upload limits are enforced by upload policies. Unused global Termii/360dialog settings were also removed from the active file. Existing provider accounts and payment records were not changed.

Default-valued entries remain omitted from the active file. Production and feature-specific credential slots are explicitly listed, including blank slots awaiting configuration. Retained active values were compared byte-for-byte after dotenv parsing. Private originals were saved under `.ops/env-cleanup-*` before editing. Generated `.env.vercel-pull` snapshots and separate load-test files were left untouched because they are not the active app configuration.

This cleanup changes local configuration and example/source files. It does not delete or replace hosted environment variables, rotate credentials, or deploy new infrastructure.

## Production key slots

The active file includes slots for pastoral/MFA encryption, the matched private proxy secret, historical Paystack keys, optional AI configuration and monitoring. Existing non-empty bot-protection, provider encryption, Resend and Flutterwave credentials were retained. Missing keys were left blank; no encryption keys were generated, copied from a different environment or rotated. Use the correct existing keys for encrypted data. A blank pastoral key is accepted for local development but remains a startup error with `NODE_ENV=production`. Other blank optional slots mean unconfigured, and their features remain unavailable until configured.

`PUBLIC_API_URL`, the verified sender, gateway keys/webhook secrets and AI model/rates are deployment- or account-specific settings. They have no universal production values. Default budgets, pool settings, feature flags, ports and bucket names are shown in the example for reference and remain implemented in code. Automatic defaults such as serverless idle time and worker enablement are commented to avoid overriding host detection.


## GitHub Actions database migrations

The backend CI runs the same validation jobs on pushes and pull requests. After lint/build, unit tests and E2E tests succeed, pushes to `main` or `staging` also run `prisma generate`, `prisma migrate deploy` and the insert-only production reference seed. Pull requests and other branches never deploy to a hosted database. Existing tests continue using disposable PostgreSQL services.

In the **BelivrHQ-Backend** repository, open **Settings → Environments** and configure these two environments. Limit each environment's deployment branches to its matching branch:

| Branch | GitHub environment | Environment secret | Value |
| --- | --- | --- | --- |
| `main` | `production` | `DATABASE_URL` | Production Supabase PostgreSQL migration connection string |
| `staging` | `staging` | `DATABASE_URL` | Separate staging Supabase PostgreSQL migration connection string |

Keep these secrets at environment scope. Do not create a repository-wide `DATABASE_URL` fallback, and do not reuse the production database for staging. The migration job maps `main` to `production` and `staging` to `staging`; a missing or non-PostgreSQL URL fails with a configuration error before dependencies or migrations run. Never paste connection strings into workflow YAML or commit an env file.

Use the Supabase **Connect** PostgreSQL URI with credentials allowed to apply this repository's migrations. Use a direct connection when the runner can reach it, or the session pooler on port **5432** for IPv4-compatible GitHub-hosted runners; do not use the transaction pooler on port 6543. This is not `SUPABASE_URL` (the HTTPS API origin), an anon key or a service-role API key. URL-encode special characters in the database password and retain the connection's TLS settings. See [Supabase's Prisma connection guidance](https://supabase.com/docs/guides/database/prisma).

`migrate deploy` applies committed migrations; it does not generate Prisma Client artifacts, hence the separate generate step. The migration command does not reset or seed databases. The following CI step runs the insert-only reference seed described below. Existing databases must already have their migration baseline, and existing applied migration files remain unchanged. See [Prisma migrate deploy](https://docs.prisma.io/docs/cli/v7/migrate/deploy).

Migration runs are serialized per branch and running migrations are not cancelled by newer pushes. GitHub environment protection rules still apply. Vercel continues deploying the API independently through its Git integration; this workflow does not make Vercel wait for migrations. Keep migrations compatible with the running API. Once both environment secrets are configured, push the branch or rerun its workflow to apply pending migrations. Adding a GitHub secret alone does not start a workflow. No hosted database is migrated by local workflow validation.


## Production reference seed: missing roles only

After a successful migration deployment on `main` or `staging`, CI runs `npm run prisma:seed-production` against that branch's selected database. The same policy applies to `npm run prisma:seed-perms` and the shared seed used during development.

- A missing **global default role** is created with its initial default grants. Missing permission records needed by that new role are inserted; existing permission records are reused without updates.
- An existing global role is skipped completely, including its label, description and grant set. Empty grants remain empty. Nothing is added back or removed, including mappings on an existing `super_admin` role.
- Church-owned roles and church-specific permission overrides are untouched. The runtime rule that `super_admin` always has full access remains unchanged.
- If all default roles already exist, the seed makes no data changes. Editing an existing role's matrix does not change its live grants; intentional permission changes require the appropriate reviewed administration or migration operation.
- New roles require entries in `DEFAULT_ROLES` and `DEFAULT_PERMISSION_MATRIX` in `prisma/seeds/shared/permissions.seed.ts`. Permission names must exist in the generated catalog. Only the new role receives those defaults.

The role/permission/mapping inserts share one transaction. A transaction-scoped database advisory lock serializes concurrent seed runs because PostgreSQL's nullable role uniqueness key does not itself prevent duplicate global roles. A failure rolls back new reference records instead of leaving a partially initialized role. Production seeding creates no churches, accounts, demo members, transactions or other church data.


## Subscription checkout returns and display name

`WEB_URL` is the canonical subscription return origin. New web clients also supply `callbackOrigin` so local `localhost`, `127.0.0.1` and IPv6 loopback checkouts return to the same browser origin as their registration cookie. Only the canonical origin is accepted in production; development/test additionally accept loopback HTTP(S) origins. Paths, credentials, query strings and unrelated hosts are rejected, and the return path stays `/subscription?payment_window=1`. Older clients without this field continue using `WEB_URL`.

New BelivrHQ subscription payments send Flutterwave `customizations.title = BelivrHQ` and a subscription description using the documented [Standard API customization fields](https://developer.flutterwave.com/docs/flutterwave-standard-1). Giving and ticket payments retain their merchant branding. Existing checkout URLs and payment records remain unchanged. This sets the checkout heading; legal merchant names, bank beneficiary names and account approval remain controlled by Flutterwave's merchant configuration. No provider dashboard settings are modified by this change.

Deploy this backend change before the updated web client, since older APIs reject the new `callbackOrigin` field. No migration or new environment variable is required. Existing payment links retain their original provider callback and display settings; they are not rewritten.

If checkout shows the account owner's personal name as the receiver/beneficiary, `customizations.title` does not change it. Ask Flutterwave to verify the merchant account tied to the active API keys, registered-business approval and beneficiary display name. See [Flutterwave business account guidance](https://www.flutterwave.com/cm/support/my-account/selecting-the-correct-flutterwave-business-account). This provider-managed name has not been verified or changed from this workspace.
