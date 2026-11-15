# Key generation and rotation

This release supports a current key plus up to five retained keys per purpose. New ciphertext, signatures and proxy requests use the current key. Retained keys only decrypt or verify. Existing ciphertext formats, tenant/provider/user binding and authenticator recovery hashes are preserved. No schema migration is needed.

A key is not recoverable from ciphertext. Back up existing keys in a secret manager before rotation; store key backups separately from database backups. Removing keys from Vercel does not delete encrypted data. If a key was lost, restore it from a backup or recover/reconfigure the affected feature through its existing authorized recovery process. A new key cannot repair old ciphertext.

## Generate and validate

Run from the backend repository:

```sh
npm run --silent keys:generate
npm run keys:check
```

Generate separately for each purpose and save the output privately. The generation command prints only one random 32-byte key encoded as 64 hex characters; it does not edit local or hosted settings. `keys:check` loads the local `.env` without overriding already supplied environment variables. It checks only application-owned keys and lists validity and retained-key counts, never values. Supply the exact target environment through your secret manager when validating production. It does not verify database readability, provider API credentials or deployed Vercel settings.

| Current setting | Format | Retained keys setting | Retirement condition |
| --- | --- | --- | --- |
| `INTEGRATIONS_ENCRYPTION_KEY` | Exactly 64 hex characters | `INTEGRATIONS_ENCRYPTION_KEY_PREVIOUS_KEYS` | Re-encrypt and verify **all** provider account versions, including archived/historical accounts |
| `TWO_FACTOR_ENCRYPTION_KEY` | Exactly 64 hex characters | `TWO_FACTOR_ENCRYPTION_KEY_PREVIOUS_KEYS` | Re-encrypt and verify enrolled authenticators after old writers drain; keep overlap up to 10 minutes if pending setups must finish |
| `PASTORAL_ENCRYPTION_KEY` | At least 16 characters; generate 64 hex for new deployments | `PASTORAL_ENCRYPTION_KEY_PREVIOUS_KEYS` | Re-encrypt and verify all notes, including archived notes |
| `ALTCHA_HMAC_KEY` | At least 32 characters | `ALTCHA_HMAC_KEY_PREVIOUS_KEYS` | At least 24 hours after the last old-key writer stops; covers 20-minute bot proofs and 24-hour signup billing capabilities |
| `INTERNAL_PROXY_SECRET` | At least 32 characters, identical on web/API | `INTERNAL_PROXY_SECRET_PREVIOUS_KEYS` on API | Every web/API instance uses the current key; drain old requests/deployments |
| `MEDIA_UPLOAD_SIGNING_KEY` | At least 32 characters | `MEDIA_UPLOAD_SIGNING_KEY_PREVIOUS_KEYS` | At least 1 hour after the last old-key writer stops; covers direct-upload completion grants |

Each previous-key setting is a JSON **array of strings**, for example `["OLD_KEY_VALUE"]` in Vercel's value field. This is a format example, not a usable value. Do not wrap the entire array or current value in extra quotes in Vercel. For a dotenv file, wrap the JSON in single quotes: `NAME_PREVIOUS_KEYS='["OLD_KEY_VALUE"]'`. Unset it after retirement or use `[]`. A previous-key setting requires a current key. Invalid entries, oversized lists and missing required keys fail configuration validation; errors never include key values. Surrounding whitespace on hexadecimal keys is normalized, while passphrases/signing secrets preserve their exact bytes. Quotes, Base64 instead of hex and literal `\n` in hex keys are rejected.

Run `keys:check` before deploying the target settings. Optional integrations and authenticator keys may be absent, but their protected operations then remain unavailable. Do not remove a configured encryption key merely to make startup succeed. Malformed configured keys still fail startup; validation is not bypassed to keep the health endpoint green.

## Roll out overlap before changing writers

1. Deploy this code to every API and worker instance using the existing current keys. Keep old deployment URLs from receiving traffic after cutover; Vercel environment edits do not retrofit old deployments.
2. Add the **next** key to each instance's corresponding `_PREVIOUS_KEYS` array while leaving the existing current key in place. Redeploy/restart every instance. This lets old writers and new writers coexist safely in the next step.
3. Promote the next key to the current variable, and retain the old key plus any still-needed historical keys in `_PREVIOUS_KEYS`. Redeploy/restart every instance again. New writes now use the next key. For the proxy secret, update the API to accept both first, then update the web sender, and keep both accepted until old web deployments and requests drain. The web only sends its current `INTERNAL_PROXY_SECRET` and needs no previous-key setting.
4. For stored-data keys, back up the database and perform the migration below. For signing/proxy keys, observe the retirement conditions above. Keep previous keys during all restarts and retries.
5. Verify current-key-only readability after all old writers and pending authenticator setups have drained. Remove the retired key from runtime settings, redeploy/restart, and retain it in protected historical backup storage for restoring old database backups.

This is planned rotation. If a key is compromised, retaining it also retains the ability to decrypt/forge with it. Stop affected traffic, revoke outstanding grants if necessary, migrate under controlled writers and retire it promptly instead of applying normal overlap windows. Rolling back application code must use the original current key or a release that understands retained keys; pre-release code cannot read data written with a different current key.

## Re-encrypt stored data

Run against the intended database with the **new current keys and all needed old keys**, without changing hosted settings from the script. One invocation can migrate all three encrypted-data tables:

```sh
npm run keys:rotate:dry
npm run keys:rotate:apply
```

The first command is read-only. The apply command first checks **every selected table** before writing anything, then re-encrypts affected records, then reads every selected table again and verifies it using **only the current keys**. Completion is reported only after the final verification passes. To repeat the retirement check independently:

```sh
npm run keys:rotate -- all --verify-current
```

Use `integrations`, `authenticators` or `pastoral` instead of `all` to select one purpose. An unconfigured feature with no stored records passes as empty. If records exist without a usable current key, the command fails instead of skipping them.

Old keys can come from the normal `_PREVIOUS_KEYS` setting during planned overlap, or from an **operator-only** `_ROTATION_KEYS` JSON array. For example, supply the original integration key privately as `INTEGRATIONS_ENCRYPTION_KEY_ROTATION_KEYS`, while `INTEGRATIONS_ENCRYPTION_KEY` contains the replacement. The same suffix works for authenticators and pastoral notes. These variables are read by the migration command only; application services ignore them. Do not deploy them to API, worker or web instances, and do not paste secrets into shell command arguments or logs. The combined list is limited to five old keys per purpose. A current key is required whenever old keys are provided.

For a compromised key, restrict affected operations and drain old deployments/writers first. Keep the old encryption key in the isolated migration environment, migrate and verify, then bring up the application with only the new current key. This controlled cutover may interrupt affected operations briefly, but does not require retaining a compromised key in the live API's read/verify key list. A normal planned rotation can use staged overlap to keep requests working during migration.

The script scans batches of 100 across each selected table, checks authenticated decryption, skips records already readable with the current key, and verifies each replacement before writing. It includes archived notes and all historical provider-account versions. Each update compares the original ciphertext so a concurrent edit is never overwritten. It leaves roles, recovery hashes, TOTP replay counters, enrollment revisions, payment references and plaintext unchanged. This maintenance command intentionally covers every tenant; it is an operator command, not an application endpoint.

An unreadable record found during preflight prevents all writes. If a later database failure, concurrent change or failed final verification occurs, the command exits nonzero and does not report completed rotation. Earlier successful writes remain committed and readable with the keys supplied to the migrator; rerunning safely resumes without rewriting completed records. The three-table operation is resumable, not a single database transaction. Retire old keys only after a complete current-only verification succeeds. For a definitive retirement check, stop relevant writers or ensure all writers use the new key and old in-flight operations are drained.

Pending authenticator setup entries in Redis expire after 10 minutes. When overlap keys are available, activation decrypts the pending seed and **encrypts the final database record with the current key**; a pending setup can no longer introduce old-key ciphertext after migration. To let those pending setups finish without interruption, retain planned overlap through their expiry window after old writers stop. During emergency retirement without overlap, an old-key pending setup must be restarted. The migration command does not scan or mutate Redis; final verification covers persisted database records.

This repairs encryption of stored records. If an attacker already decrypted a provider credential or authenticator seed, also revoke/replace that underlying secret through the provider or MFA recovery flow. Re-encryption cannot revoke an attacker's existing plaintext copy. Signing/proxy secrets have no encrypted records to migrate: remove compromised verification keys immediately and reissue or restart affected temporary authorizations.

The legacy `pastoral:rotate-key` command delegates to this implementation. If supplied, `PASTORAL_OLD_ENCRYPTION_KEY` is added to the retained key list for that invocation. Prefer the common `keys:rotate` workflow for future rotations.

## Upload grant migration

Historically, upload grants were signed with `SUPABASE_SERVICE_ROLE_KEY`. For compatibility that remains the fallback when `MEDIA_UPLOAD_SIGNING_KEY` is absent. Configure a separate generated upload signing key to decouple future Supabase credential rotation from pending uploads. During the first transition, explicitly include the former signing value in `MEDIA_UPLOAD_SIGNING_KEY_PREVIOUS_KEYS`, then remove it after all old writers stop and the one-hour grant window passes. The Supabase service-role credential itself is never accepted as a fallback once the dedicated key is configured.

## Provider-issued and per-record secrets

Supabase, database, Redis, mail, AI and payment API credentials are issued by those services. Rotate them using their provider's process and update every consumer; application encryption-key rings do not replace provider credential management. Updating a provider account through Integrations writes a credential version encrypted with the current integration key. Historical account versions remain available for historical payment verification and must be covered by encryption migration.

Incoming payment/messaging webhook signatures use the provider's configured webhook secret/account credentials. Coordinate callback secret changes with the provider; do not add arbitrary old provider secrets as global accepted signatures. Outgoing webhook endpoint secrets are stored per endpoint and shared with the receiver: arrange receiver overlap first, drain/retry existing deliveries under the coordinated contract, then retire the old receiver key. Random intake tokens, ticket codes and authenticator recovery codes are per-record capabilities, not master encryption keys; replace/revoke them through their feature's authorized workflow. Supabase owns session/JWKS signing-key rotation. None of these external credentials, capabilities or provider dashboards are changed by this implementation.

## Implementation validation

205 targeted checks passed across encryption compatibility/rotation, configuration/CLI validation, service behavior, proxy overlap, media grants, signup capabilities and bot proofs, including five isolated HTTP checks. Tests cover independently generated legacy ciphertext, tenant/user binding, malformed/tampered input, current-only verification, dry-run behavior, concurrent-change refusal and resuming after partially committed progress. Production build passed with `CHOKIDAR_USEPOLLING=1` because the host's native watcher limit blocked the initial attempt. Scoped lint, rotation-script TypeScript and diff checks passed. The general scripts TypeScript check reports pre-existing errors in unchanged `scripts/delete-data.ts`. No production database scan/write, hosted key change or deployment was performed; validate target settings and execute the rollout against the intended environment separately.

The follow-up all-record command adds cross-table preflight, automatic persisted current-only verification after apply, and operator-only old-key inputs. Pending authenticator activation now persists new-key ciphertext even when setup began with an old key. Follow-up validation: 58 focused rotation/authenticator checks, application/scoped script TypeScript, scoped lint, CLI help smoke and diff checks passed. No production rotation was run.
