# Local environment setup

The backend loads `BelivrHQ-Backend/.env`; the web app loads `BelivrHQ-Web/.env.local`. The backend `.env.local` belongs to Vercel tooling and is not the Nest configuration file. Local secrets stay ignored by Git. Restart both development servers after edits; hosted deployments need their own environment settings.

## Flutterwave subscription testing

1. Open your Flutterwave **test-mode** dashboard and copy the v3 test secret key into backend `FLUTTERWAVE_SECRET_KEY`. Never put it in a `NEXT_PUBLIC_` setting. The current server-hosted checkout does not consume Flutterwave public or encryption keys.
2. Set backend `FLUTTERWAVE_WEBHOOK_SECRET` to a random secret hash, and save the identical value in the test dashboard webhook settings. This is different from the API key. A fresh hash can be generated with `openssl rand -hex 32`; keep the output private.
3. Register `https://YOUR-PUBLIC-API/api/v1/billing/webhooks/flutterwave` as the subscription webhook. A local API needs a public HTTPS tunnel for Flutterwave callbacks. Set `PUBLIC_API_URL` to that origin without `/api/v1`; keep `WEB_URL` pointed at the frontend used for checkout.
4. Restart the backend. Use Plan & Billing to start a test payment. `SUBSCRIPTION_FLUTTERWAVE_CURRENCIES=NGN` is the conservative default. Add other collection currencies only after enabling them on the merchant account.

Environment gateway credentials cover **BelivrHQ subscriptions**. Church giving and paid events require that church's own Flutterwave account and payment channel under Settings → Integrations; they do not inherit the platform key. Test payments can update subscription/giving records in the connected database, so choose a designated test church.

No payment, webhook registration or provider credential validation is performed by environment-file setup. Flutterwave test keys must be supplied by the account owner.

## Values that may remain blank

| Setting | What supplies it |
| --- | --- |
| `OPENAI_API_KEY` | Your OpenAI API project; optional while AI is disabled. |
| `ASK_BELIVRHQ_MODEL` | Your selected Responses API model. |
| `ASK_BELIVRHQ_INPUT_USD_PER_MILLION`, `ASK_BELIVRHQ_OUTPUT_USD_PER_MILLION` | That model's current published USD price per million tokens. No prices are guessed. |
| `FLUTTERWAVE_WEBHOOK_SECRET` | A secret hash you choose and configure in both the backend and Flutterwave dashboard. |
| `INTEGRATIONS_ENCRYPTION_KEY` | Existing deployment's 64-character hex key used to encrypt church provider accounts. |
| `TWO_FACTOR_ENCRYPTION_KEY` | Existing deployment's 64-character hex key used for enrolled authenticators. |
| `SENTRY_DSN` | Optional Sentry project configuration. |
| `GOOGLE_SITE_VERIFICATION`, `BING_SITE_VERIFICATION` (web) | Optional ownership verification tokens from the respective webmaster tools. |

Ask BelivrHQ remains in reference mode with `ASK_BELIVRHQ_AI_ENABLED=false`; the model/key/rates can stay blank. Daily cost defaults are USD 0.25 per church and USD 2 across the platform, with a 2,000-request platform cap. These settings only apply when AI is enabled.

The local backend currently connects to a remote database. Recover existing encryption keys from the environment that wrote encrypted data. Do not generate replacements for existing encrypted accounts, authenticators or pastoral notes. For a genuinely fresh isolated environment, generate separate keys with `openssl rand -hex 32`. Pastoral notes currently retain the development fallback when their key is absent; moving them to a new key requires the documented note re-encryption process.

`RESEND_FROM` must match a sender/domain verified in your Resend account. Storage bucket defaults name buckets; they do not create or verify them. Existing database, Supabase, Redis, mail, monitoring and push credentials are preserved. The web app receives only the Supabase URL and public anonymous key, never the service-role key.

## Integration key setup on October 20

A read-only check confirmed zero `integration_accounts` in the configured database.
A cryptographically random 32-byte integration key was generated into the ignored
backend `.env` (64 hex characters, file permissions 0600). An AES-256-GCM
encryption/decryption check passed without database writes. The key was not printed
or committed. Copy that exact `INTEGRATIONS_ENCRYPTION_KEY` into any API/worker
deployment sharing this database before storing integration accounts there, and
restart the API/worker after setting it. This application key is separate from
Flutterwave API credentials and webhook hashes. Existing authenticator and pastoral
encryption keys were preserved.

## Official references

- [Flutterwave v3 authentication and test keys](https://developer.flutterwave.com/v3.0.0/docs/authentication)
- [Flutterwave v3 webhook secret hashes](https://developer.flutterwave.com/v3.0.0/docs/webhooks)
