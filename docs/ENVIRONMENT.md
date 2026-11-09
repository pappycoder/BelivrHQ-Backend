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
