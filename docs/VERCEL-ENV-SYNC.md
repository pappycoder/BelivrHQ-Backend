# Local Preview and Production environment sync

Use these private files in the backend repository:

| File | Purpose |
| --- | --- |
| `.env` | Existing local runtime configuration; splitting and pulling leave it unchanged |
| `.env.vercel.shared` | Shared application encryption/signing keys and overlap lists, Redis connection/token, Sentry DSN, and explicitly shared defaults |
| `.env.vercel.preview` | Preview database/Supabase credentials, origins, provider test credentials and cache/queue namespace |
| `.env.vercel.production` | Existing live database/Supabase credentials, origins and provider credentials |

Real files and pre-pull backups are Git-ignored and created with private permissions (0600). The files under `config/vercel/*.env.example` contain placeholders only and may be committed. A nonempty environment-specific value overrides the shared value. **An explicit empty environment-specific value also overrides the shared value.** An absent assignment is different from an empty assignment.

## Commands

Run from `BelivrHQ-Backend`:

| Command | Action |
| --- | --- |
| `npm run env:vercel:init` | Create missing private files; seed shared/live fields from existing `.env` without generating keys or overwriting existing files |
| `npm run env:vercel:split` | Fill missing shared/live assignments from `.env`; retain all existing deployment values, including explicit empty assignments and keep local HTTP/loopback origins, migration-only keys and namespace settings local |
| `npm run env:vercel:plan` | Review both targets locally; show variable names, source files, types, explicit empty assignments and missing required settings, never secret values |
| `npm run env:vercel:plan:preview` | Review Preview only |
| `npm run env:vercel:plan:production` | Review Production only |
| `npm run env:vercel:pull` | Pull readable values for both targets into the appropriate files |
| `npm run env:vercel:pull:preview` | Pull Preview only; preserve Production's file and shared values that Production may still need |
| `npm run env:vercel:pull:production` | Pull Production only; preserve Preview's file |
| `npm run env:vercel:push` | Push both targets after validating the complete local input |
| `npm run env:vercel:push:preview` | Push Preview only |
| `npm run env:vercel:push:production` | Push Production only |
| `npm run env:git:check` | Check that no private env/cache/backup files are tracked |
| `npm run env:git:install` | Install this clone's commit/push guards without replacing existing custom hooks |

Vercel CLI 65.9+ is required for push. The installed CLI is the interface; nonempty values are sent on stdin, never shell commands or command-line arguments. Empty strings use an explicit empty CLI argument to avoid an interactive value prompt; they contain no secret. A linked backend project and authorized Vercel account are required for both remote operations:

```sh
vercel login
vercel link
npm run env:vercel:pull
npm run env:vercel:plan
```

Choose the existing **backend** project when linking. The script binds every operation to the project and organization IDs in this directory's `.vercel/project.json`. Do not link the web project here. There is no automatic push, deployment or database write during ordinary builds or env pulls.

## Empty values and removals

`SETTING=` is intentional data:

- Push uploads an empty string as readable Config (there is no secret content), replacing that target's hosted value with empty. It does not substitute a shared value or skip the assignment.
- Pull writes a readable empty hosted value as empty. It does not substitute local defaults, the original `.env`, another environment's value or a nonempty shared value.
- Removing an assignment from a local file does not delete the hosted variable. Host-side deletion is a separate explicit Vercel operation.
- Required runtime blanks produce a visible warning during the plan. Explicit push still applies requested blank values; a missing production pastoral/HMAC/database key can prevent startup. Invalid **nonempty** encryption keys are rejected before any hosted updates.

Review `EMPTY` entries before pushing. An empty slot originally copied from a template is still an explicit empty assignment when pushed.

## Pull reconciliation and write-only secrets

Vercel Config values are readable; Vercel Secret values cannot be retrieved after saving. Pull therefore lists metadata/available values through `vercel env list --json` and never assumes a placeholder is the original secret. Old `sensitive` entries receive the same protection as current `secret` entries. Local secret copies are preserved and reported as **not verified against Vercel**. If no nonempty local copy exists, the script reports the variable name; recover it from your secret manager. A pull cannot recover a deleted encryption key or determine whether an unreadable remote Secret is empty. It never replaces real local keys with `redactedkey` or similar CLI placeholders.

When both targets return a readable shared setting with the same value (including empty), it is stored once in the shared file. If the values differ, both are stored explicitly in their target files; neither is arbitrarily promoted as the common value. A one-target pull stores differing values in that target file so the other environment's effective settings remain unchanged. Branch-specific Preview overrides and Vercel-managed variables are not imported into the default files. Existing local-only assignments are kept. Pre-pull copies are saved under ignored `.ops/vercel-env-*` directories before any replacement.

If the Vercel team enforces Separate Production Secret Values, shared nonempty Secrets may be rejected by Vercel. Keep those values separate or use the team-approved policy; the sync tool never downgrades a nonempty credential to readable Config to bypass that restriction.

Preview and Production credentials may already differ. Pull preserves that difference. Making existing encryption keys shared still requires the rotation process on **each affected database**; env sync does not re-encrypt stored records or silently change keys.

## Shared Redis and Sentry

The connection/token may be shared. Preview cache, counters, challenges, rate limits, AI usage budgets and BullMQ queues use the namespace `belivrhq-preview` by default. Production keeps the previous unprefixed cache keys and `bull` queue prefix, preserving existing jobs. `REDIS_NAMESPACE` can explicitly choose a different isolated namespace using letters/numbers/underscores/hyphens. Configure persistent staging workers with the same namespace as the Preview API. Production workers and API must also match. Never put the same namespace on both environments sharing one Redis service. Deploy the namespace-aware code before sharing Redis, stop old Preview workers during cutover, and restart all corresponding APIs/workers with matching settings. Existing jobs are not moved between namespaces. Local development using that same Redis should set its own namespace, such as `belivrhq-local`.

Namespaces prevent accidental cache/queue crossover; anyone holding the shared Redis credentials still has access to the shared service. Sharing cryptographic keys also couples the security and rotation of both environments. Sentry may use the same DSN; API events are tagged with `VERCEL_ENV` so Preview and Production can be filtered separately. BullMQ still needs a supported TCP Redis connection on its persistent worker; an Upstash HTTPS REST URL alone is not a TCP transport.

## Git protection

`.gitignore` and `.vercelignore` exclude actual env files and private backups from Git/deployment uploads. Installed `.githooks/pre-commit` rejects private env files even if force-added. `.githooks/pre-push` scans outgoing commit history as well as the current index, catching a private file committed and then deleted before pushing. CI also checks tracked filenames. Install the hooks in each clone with `env:git:install`; an existing custom hooks directory must integrate these guards instead of being overwritten. These are accidental-leak guards: Git's `--no-verify` can bypass local hooks, and filename checks do not detect a secret pasted into arbitrary source files. Example files must remain placeholders only.

## Current local setup

Existing `.env` values have been split without changing the local runtime file or rotating keys. Shared fields were copied once; remaining deployable values filled Production's initial slots. Future splitting preserves explicit empty values as intentional data. The local-only API origin was left out of the live configuration. Preview-specific database and Supabase settings were not guessed or copied from Production. The Vercel CLI currently returns `Not authorized`; authenticate with the correct team/account and link the backend project before performing a real pull. No hosted environment value has been changed.

The local integration and authenticator key values were found to contain 128 characters; both must be corrected to valid 64-character hex values before pushing. They were preserved, not truncated or regenerated. Existing encrypted records still need their original keys for migration. The pastoral key is blank and must be configured before production runtime can start.

References: [Vercel CLI env commands](https://vercel.com/docs/cli/env), [Config and Secret value behavior](https://vercel.com/changelog/environment-variables-now-use-config-and-secret-types), [BullMQ connection and prefix behavior](https://docs.bullmq.io/guide/connections). After pushing, redeploy the selected environment: settings changes apply to new deployments. Follow [Key rotation](KEY-ROTATION.md) separately when changing encryption keys.

## Validation

182 focused unit/HTTP/Git checks passed across env reconciliation, explicit blanks, placeholder protection, isolated Redis operations, queues, caching, authentication and outgoing Git history. Production build passed with polling enabled for this host's watcher limit. Application/scoped script TypeScript, scoped lint, package alias help checks and diff checks passed. Remote push/pull protocol was tested with captured mock CLI responses; a real remote pull remains blocked by Vercel's Not authorized response. No live deployment, hosted env mutation or database migration was performed.
