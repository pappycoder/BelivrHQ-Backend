# Local Vercel environment sync

Edit one private, Git-ignored file: **`.env.vercel.json`**. It separates common settings from Preview and Production settings:

```json
{
  "shared": {
    "NODE_ENV": "production",
    "INTEGRATIONS_ENCRYPTION_KEY": "",
    "INTEGRATIONS_ENCRYPTION_KEY_PREVIOUS_KEYS": [],
    "SENTRY_DSN": ""
  },
  "preview": {
    "WEB_URL": "",
    "PUBLIC_API_URL": "",
    "DATABASE_URL": "",
    "REDIS_URL": "",
    "UPSTASH_REDIS_TOKEN": ""
  },
  "production": {
    "WEB_URL": "",
    "PUBLIC_API_URL": "",
    "DATABASE_URL": "",
    "REDIS_URL": "",
    "UPSTASH_REDIS_TOKEN": ""
  }
}
```

This is a shortened example; the actual file includes all existing settings and six current-key/previous-key-list pairs. See `config/vercel/env.example.json` for the full placeholder template. Keep actual values out of source control. The local runtime `.env` is separate and remains unchanged.

## Sections and values

`shared` applies to both environments. `preview` and `production` override shared assignments, **including explicit empty strings**. Keep `WEB_URL`, `PUBLIC_API_URL`, `DATABASE_URL`, `REDIS_URL` and `UPSTASH_REDIS_TOKEN` in their target sections; the tool refuses to push them from shared. Supabase connections, provider test/live credentials and origins should match the appropriate database/environment.

Values are normally strings. Previous-key lists can be JSON arrays of strings, which are serialized correctly for Vercel. A deliberately empty list representation pulled from a hidden Secret remains `""`; a newly added list defaults to `[]`. Only actual old keys belong in a previous-key list. The tool never generates or guesses them. Numeric/boolean JSON settings are converted to env strings.

## Commands

Run from `BelivrHQ-Backend`:

| Command | Action |
| --- | --- |
| `npm run env:vercel:init` | Create/validate the single private file |
| `npm run env:vercel:migrate` | Consolidate the old three files into JSON and archive the originals privately |
| `npm run env:vercel:keys` | Ensure all shared current-key and previous-key-list slots exist |
| `npm run env:vercel:split` | Explicitly fill missing assignments from local `.env`; existing assignments, including empty values, remain unchanged |
| `npm run env:vercel:plan` | Review both targets locally; show names, types, source sections and explicit empty assignments, never values |
| `npm run env:vercel:plan:preview` | Review Preview only |
| `npm run env:vercel:plan:production` | Review Production only |
| `npm run env:vercel:pull` | Pull both targets into the corresponding sections |
| `npm run env:vercel:pull:preview` | Pull Preview only |
| `npm run env:vercel:pull:production` | Pull Production only |
| `npm run env:vercel:push` | Push both targets |
| `npm run env:vercel:push:preview` | Push Preview only |
| `npm run env:vercel:push:production` | Push Production only |
| `npm run env:git:check` | Check that private env/cache/backup files are not tracked |
| `npm run env:git:install` | Install this clone's private-env commit/push guards |

Existing sync commands automatically consolidate legacy files if JSON does not yet exist. Migration preserves plain-text values and empty assignments, adds missing key/list slots, and clears recognized Vercel encrypted-storage payloads that the earlier pull incorrectly wrote as values. Originals remain under ignored `.ops/vercel-env-*` backups. Once JSON exists it is authoritative; the three old files are no longer edited or recreated. Initialization/migration does not prefill credentials from `.env`.

## Project linking and remote access

Vercel CLI 65.9+ and an authorized account are required. Link this directory to the existing backend project:

```sh
vercel login
vercel link
npm run env:vercel:pull
npm run env:vercel:plan
```

The tool supports `.vercel/project.json` and repository mappings in `.vercel/repo.json`, including exact directory mappings in ancestor repositories. Per-directory links take precedence. Ambiguous, malformed and mismatched links are rejected. Every CLI operation specifies the linked backend project and organization explicitly; do not link the web project here.

No ordinary build triggers env sync, hosted deployment or database re-encryption. After a push, redeploy the selected environment for its new settings to take effect.

## Readable exports and hidden Secrets

`vercel env list --json` is used for **metadata only**. Its `value` field can contain an encrypted storage envelope, even for readable Config settings; it is not a plaintext export. Readable values are obtained through Vercel's supported `vercel env pull` command into a fresh private temporary file. No existing local values are supplied to that export. The temporary directory is removed afterward, and CLI output is suppressed. The tool rejects encrypted envelopes instead of saving them as URLs or settings. A missing expected readable export aborts the pull before replacing configuration.

Write-only Secret values cannot be retrieved from Vercel. As requested, every hidden/unreadable Secret becomes an **empty local assignment** with no fallback to `.env`, existing JSON values or backups. Legacy `sensitive` types and secret visibility receive the same treatment. Empty represents an unavailable value here; it does not prove the hosted Secret itself is empty. Export placeholders are never stored as usable credentials.

When both targets return matching shared values, including hidden values represented as empty, the value is stored in `shared` and stale scoped overrides are removed. If only one target lists a redacted shared key, its representation is still empty in shared, so a newly entered shared replacement is not shadowed by an obsolete scoped blank. Different pulled values stay environment-specific. URLs always stay in their target sections, even if both URL values happen to match. A one-target pull leaves the other target's effective settings unchanged.

Branch-specific Preview overrides and Vercel-managed variables are not imported into default target sections. Local-only assignments absent from hosted metadata remain, including newly prepared settings that have not been pushed. Pull does not seed any value from the runtime `.env`. Configuration is backed up privately before replacement.

## Empty assignments and secret updates

`"SETTING": ""` is intentional data. Pull preserves an empty readable value and represents a hidden Secret as empty. Push uploads that empty string and clears the target's hosted value; it does not skip it or fall back to shared. Removing a local assignment does not delete a hosted variable.

The plan marks empty assignments and warns about required runtime blanks. Explicit push still applies requested empty values. Missing database/HMAC/pastoral settings can prevent runtime startup; invalid nonempty encryption keys are rejected before push. Populate replacement values after pulling and review the plan before pushing. Pulling again will blank them again if Vercel stores them as hidden Secrets.

Nonempty credentials are sent on stdin using Vercel's Secret type, never shell interpolation or command-line arguments. Empty values use Config plus an explicit empty argument so they can be read back as empty without prompting. Config does not mean source-controlled: the complete JSON file remains private.

## Secret and Config classification

Secret: database URLs, Supabase service-role credentials, Redis connections/tokens, all encryption/signing keys and retained lists, provider API keys, webhook secrets and unknown nonempty settings. Config: app/Supabase origins, public Supabase anon keys, bucket names, sender address, modern public Sentry DSNs, environment labels, namespaces, ports, feature flags, models, budgets and pool options. Legacy Sentry DSNs with a password component remain Secret; Sentry auth tokens remain Secret if added.

Secret status does not prevent local updates. Existing unreadable secrets cannot be recovered merely by changing their type; supply the correct local value when replacing them. Vercel's Separate Production Secret Values team policy may reject shared nonempty Secrets; the tool never downgrades a nonempty credential to bypass that policy. Changing encryption keys requires the separate [rotation workflow](KEY-ROTATION.md) on every affected database.

## Environment-specific Redis and shared Sentry

Redis connections and tokens belong separately in `preview` and `production`, never in `shared`. The existing shared Redis URL/token were identified as Production credentials and moved there unchanged. Preview has its own slots for a separate Redis connection and token. Pull keeps both values scoped even if Vercel returns identical or hidden values for both environments; plan/push reject them in shared.

Preview still uses the `belivrhq-preview` cache/queue namespace by default. Production retains existing unprefixed caches and the `bull` queue prefix so current jobs remain available. Explicit `REDIS_NAMESPACE` values must match the API and workers for their respective environment. Redis credentials were moved in local configuration only; no queues or cached data were migrated or cleared. BullMQ still requires a supported TCP Redis connection; an HTTPS REST endpoint alone is not TCP transport.

Sentry DSNs may remain shared and are tagged with `VERCEL_ENV` so Preview and Production can be filtered separately.

## Private files and validation

`.env.vercel.json`, legacy env files, CLI exports and `.ops` backups are ignored by Git and deployment uploads; private files use permissions 0600. Installed pre-commit/pre-push guards block private env filenames even if force-added and scan outgoing history for files committed then deleted. CI also checks tracked files. Install guards in each clone with `env:git:install`; existing custom hooks are not overwritten. Deliberately bypassing hooks or pasting secrets into arbitrary source files is outside filename-based protection. Commit only placeholder templates.

References: [Vercel env commands](https://vercel.com/docs/cli/env), [Vercel Secret and Config types](https://vercel.com/changelog/environment-variables-now-use-config-and-secret-types), [BullMQ prefixes](https://docs.bullmq.io/guide/connections).

## Validation

56 focused checks passed: 42 env-sync regressions and 14 disposable-repository Git guard checks. Scoped script TypeScript/lint, single-file migration, actual file permissions/ignore checks and diff checks passed. A real Preview/Production pull succeeded and all four URL fields were verified as plaintext HTTPS URLs; hidden Secrets were represented as empty. No hosted settings, deployment or database records were modified.

### Queue transport

`QUEUE_REDIS_URL` is a target-specific Secret. When cache `REDIS_URL` uses an HTTPS Upstash REST endpoint, provide the separate Redis TCP/TLS URI from the dashboard for BullMQ. The REST token is not the TCP password. Plans warn when this connection is absent and reject HTTPS or local queue URLs. Queue initialization rejects REST URLs with a descriptive error rather than attempting a Unix socket connection. Existing TCP Redis deployments keep using `REDIS_URL` as the fallback.
