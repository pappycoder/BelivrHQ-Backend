# CI-controlled backend releases

The operator requested that failed CI must not deploy automatically to Vercel. Root `vercel.json` disables Git deployments. Read-only provider checks verified `gitProviderOptions.createDeployments=disabled` on both main BelivrHQ Vercel projects. GitHub Actions is the deployment path; the updated workflow still needs to land before it can run this release sequence.

Only the primary `belivrhq` projects are enabled in the workflow matrix. The latest operator instruction selected one shared deployment token for this organization. Legacy release profiles remain documented in `config/releases.json`, but legacy CI deployment is on hold and no legacy token is used. Do not enable its matrix profile without separately verifying its credentials, isolated database, domains and hosted Git-deployment controls. This pass did not verify the legacy project's current hosted Git setting with the primary account.

Workers remain on hold. No active daemon is configured; template instances remain zero. `REQUIRE_QUEUE_WORKERS` defaults to false: dependency failures still fail readiness, and missing workers remain visible without blocking an otherwise healthy API. Set it true only after separately authorized worker hosting and controlled processing verification.

## Validation and release order

1. Lint, both TypeScript projects, unit tests with the unchanged 80% thresholds, disposable PostgreSQL/Redis integration/smoke/restore checks, dependency security and the real Docker context/image checks must succeed.
2. `Required backend checks` rejects any failed, skipped, cancelled or missing validation result. Main/staging GitHub branch protection requires this check, up-to-date branches and resolved review conversations, enforces the rules for administrators and denies force pushes/deletion. Existing review requirements were preserved; no new independent human reviewer is claimed.
3. Only pushes to `main`/`staging` enter release preparation; PR and feature-branch runs do not release. Release runs are serialized and active main/staging runs are not automatically cancelled.
4. Preflight validates the checked branch head, reviewed project/team profile, working tree, credential access and disabled hosted Git auto-deployments before hosted migrations. Credentials are supplied only to the steps that need them; dependency installation uses no deployment credential and a dummy database URL.
5. Apply committed migrations and the insert-only reference seed using the matching GitHub environment database secret. Build an unaliased Vercel candidate from that checked source. Verify candidate project, target, commit metadata and readiness.
6. Upload only the nonsecret candidate manifest as a one-day workflow artifact. Promotion waits for every enabled candidate preparation to succeed, downloads the current run's manifest, revalidates identity/readiness and rechecks the branch head before moving a domain.
7. Main promotes its Production candidate; staging aliases only `staging-api.belivrhq.com`. Verify readiness after promotion. An error after traffic moves is a deployment incident, not proof that traffic never moved.

### Database targets

| Trigger | GitHub environment / database secret | Hosted release |
| --- | --- | --- |
| Push to `main`, after checks pass | `production.DATABASE_URL` | Primary Production API |
| Push to `staging`, after checks pass | `staging.DATABASE_URL` | Primary Preview API |
| PR or another branch | Disposable CI database only | None |
| Legacy test project | No enabled release job; stored legacy secret unused | On hold |

A release runs migrations and the reference seed against its one selected database, not every database configured in GitHub. Primary deployment credentials do not enable the separate legacy team or its release profile.

The wrapper intentionally has separate `preflight`, `prepare` and `promote` commands. The simulated `publish` function is retained only for isolated library regressions; CI does not invoke a combined upload-and-promote command.

## GitHub configuration

Each repository uses environments `production` and `staging`. Environment branch policies restrict their secrets to `main` and `staging`, respectively, preventing feature/PR workflows from requesting deployment credentials. Configure `VERCEL_PROJECT_ID` and `VERCEL_ORG_ID` as variables; the checked-in profiles pin their expected values. The backend also needs `DATABASE_URL` in each environment. Existing primary database secrets were preserved. The operator-approved legacy test connection was stored only in `legacy-production`, which remains outside the enabled deployment matrix.

The supplied deployment token was verified against both primary Vercel projects and has no expiration. It is stored as environment secret `VERCEL_TOKEN` in Production and Staging in both repositories. Vercel metadata identifies it as account-scoped; workflow profile validation restricts these automatic releases to the two primary project IDs. No token value is stored in source, browser assets, logs or receipts. The temporary token file was removed after all four transfers and secret-presence checks succeeded. Revoke/replace through Vercel and GitHub if access must change or compromise is suspected.

The workflow sets its release-enabled flag explicitly; a missing secret/configuration stops the release rather than silently falling back to Git deployment. CLI is pinned at 65.9.0 and GitHub actions use immutable official tag commit SHAs. Weekly Dependabot PRs cover npm and GitHub Actions; updates must pass the same checks.

## Dependency audit policy

`npm run security:audit` checks the full dependency tree and fails closed for registry errors, malformed reports and unresolved advisories. Glob/minimatch were updated to publisher-patched versions. The withdrawn deepmerge advisory is no longer reported. The remaining npm report overmatches publisher-patched `@hono/node-server` 1.19.19 and its Prisma parent chain. A dated, exact-advisory/exact-installed-and-locked-version exception expires on 16 December 2026; any new advisory, changed version or expired review fails the gate. This review date is separate from the non-expiring deployment credential. See `config/security/audit-exceptions.json` and the linked publisher advisory. The web has no active exceptions.

## Verification and remaining release blockers

Local validation passed: 162 backend unit suites / 5,126 tests; 33 PostgreSQL 16 suites / 226 tests; compiled API/worker smoke; 14 operations integration checks; actual Docker context export, worker-image build and packaged Prisma/sharp/runtime import checks. Thirty-four release/profile/workflow/automatic-PR refusal tests pass in each repository; the prior three audit-policy regressions remain required. The browser suite passes all 18 checks; the web unit suite passes 687 tests. No worker host was activated.

The complete coverage command now exits successfully with all unchanged 80% thresholds: statements 87.92%, branches 80.01%, lines 88.33%, functions 83.75% (2026-11-17). Added behavioral tests cover HTTP authentication/tenant/permission boundaries, offline recovery, payment reversals, storage authorization, exports, filters and lifecycle failures. Regressions also fixed false query flags, default paid-ticket tier persistence and same-day birthday replies. Passing this gate does not complete all production-readiness work. Supabase backup/PITR, offsite object/key recovery, restore ownership, provider acceptance, alert recipients and representative hosted capacity still require actual evidence and operator configuration. See `RECOVERY-AND-CAPACITY.md`.

No main/staging merge, application deployment or hosted schema migration was performed in this CI-gating pass. Hosted promotion remains to be rehearsed after checks pass. Migrations must remain compatible with the previously deployed API; never automatically roll back schemas, encrypted data or keys.

References: [Vercel Git controls](https://vercel.com/docs/project-configuration/git-configuration), [project Git provider controls](https://vercel.com/docs/rest-api/projects/update-an-existing-project).

Database integration suites share one schema and run with one Jest worker; deliberate transaction/concurrency checks inside each suite remain concurrent. The RLS migration skips redundant ENABLE operations on already-protected tables. Tables that still need RLS enabled require the normal exclusive DDL lock, so review migration timing for active workloads.

The unit job always retains `backend-unit-coverage` for seven days when a coverage report was generated, including threshold failures. All 5,126 unit assertions and the global coverage gate now pass. Keep the thresholds and artifact retention unchanged. Automatic main/staging PR creation is prepared separately and remains inactive pending the explicit repository-setting approval described in `AUTOMATIC-PULL-REQUESTS.md`.


## Preview CLI compatibility — 2026-11-17

Vercel CLI 65.9.0 accepts `--skip-domain` only for Production. Preparation retains that flag for Production and uses the exact checked SHA in a detached checkout for Preview. The pinned CLI reports that snapshot's Git branch as `HEAD`, so it cannot claim the canonical domain bound to `staging`.

Before any migration or upload, Preview preflight verifies the detached checkout, the canonical staging domain's branch binding, absence of a domain bound to `HEAD`, and standard Preview variables without branch overrides. Both primary projects were checked read-only and satisfy this configuration. The checks run again immediately before upload. Explicit aliases or branch-metadata overrides in `vercel.json` are refused. Standard Preview variables supply the candidate; branch-specific overrides require a separate reviewed release design.

Candidate identity, target, checked SHA, readiness and the separate domain-promotion phase remain required. Error output identifies the command phase and exit status without printing CLI output, tokens or environment values. Actual pinned-CLI dry runs from a disposable detached checkout reproduced the old flag failure and accepted the corrected Preview arguments without creating a deployment.


Vercel installation is explicitly `npm ci --include=dev`, using the same `package-lock.json` as CI. Do not rely on package-manager auto-detection when old lockfiles exist. If `inspect --wait` fails, the release reports the deployment ID and allowlisted API build state, without printing raw build logs. A READY state must still pass the project/commit/target and application readiness gates before promotion.

Staging web readiness requires server-to-server access to `https://staging-api.belivrhq.com/api/v1/health`. A Vercel login redirect is not application health. The approved remediation is a protection exception for that API domain only; retain protection on generated deployment URLs and retain application authentication/authorization.

Verified the approved domain exception on 2026-11-17: staging API health and the existing staging web candidate return healthy JSON, unauthenticated `/api/v1/profiles/me` returns 401, and the generated backend deployment URL still redirects to Vercel login.

The Vercel wrapper inserts `--scope` and `--token` before any `--` passthrough delimiter. Everything after that delimiter is passed to curl; forwarding Vercel options there makes curl reject the probe before HTTP health can be checked. A retry of the old workflow still uses the old wrapper, so merge the corrected source before retrying releases.

Build-time installation explicitly includes devDependencies even under production/omit-dev settings, because Next/PostCSS and Nest compilation require them. Vercel also uses the explicit `npm run build` command. CI exercises the same install command with `NODE_ENV=production` and `NPM_CONFIG_OMIT=dev`; runtime remains production.
