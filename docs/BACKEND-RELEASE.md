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

Local validation passed: 148 backend unit suites / 2,696 tests; 33 PostgreSQL 16 suites / 226 tests; compiled API/worker smoke; 14 operations integration checks; actual Docker context export, worker-image build and packaged Prisma/sharp/runtime import checks. Twenty-three release/profile/workflow refusal tests plus three audit-policy regressions pass in each repository. The browser suite passes all 18 checks; the web unit suite passes 687 tests. No worker host was activated.

Backend coverage still fails the unchanged 80% thresholds (last measured statements 64.97%, branches 59.80%, lines 65.44%, functions 61.26%). The required check must stay red until meaningful tests close the gap. Do not lower thresholds, bypass protection or claim all production-readiness work is complete. Supabase backup/PITR, offsite object/key recovery, restore ownership, provider acceptance, alert recipients and representative hosted capacity still require actual evidence and operator configuration. See `RECOVERY-AND-CAPACITY.md`.

No main/staging merge, application deployment or hosted schema migration was performed in this CI-gating pass. Hosted promotion remains to be rehearsed after checks pass. Migrations must remain compatible with the previously deployed API; never automatically roll back schemas, encrypted data or keys.

References: [Vercel Git controls](https://vercel.com/docs/project-configuration/git-configuration), [project Git provider controls](https://vercel.com/docs/rest-api/projects/update-an-existing-project).

Database integration suites share one schema and run with one Jest worker; deliberate transaction/concurrency checks inside each suite remain concurrent. The RLS migration skips redundant ENABLE operations on already-protected tables. Tables that still need RLS enabled require the normal exclusive DDL lock, so review migration timing for active workloads.

The unit job always retains `backend-unit-coverage` for seven days when a coverage report was generated, including threshold failures. All 2,696 unit assertions currently pass; the coverage gate still exits nonzero. New webhook network and provider-callback regressions improve coverage but do not complete the required global coverage remediation.
