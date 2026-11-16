# Checked backend releases

Worker hosting is deferred. Root `vercel.json` explicitly keeps Git deployments enabled and contains no active daemon. API readiness defaults to requiring database, Redis and queue transport, while reporting absent workers with `workersRequired: false`. Merging this configuration does not start a worker or require a new Vercel CI token. See [Vercel Git configuration](https://vercel.com/docs/project-configuration/git-configuration).

The existing checked migration/reference-seed steps remain in CI. Candidate preflight, CLI installation and promotion run only when `BACKEND_RELEASE_ENABLED=true` is explicitly configured in the matching GitHub environment. Keep that flag unset/false while using Git deployments. Git deployments and CI migrations are independent in this mode: coverage or migration failures do not establish that Vercel stopped deploying. Review/apply the two new webhook migrations before deploying code that uses the new schema; worker deferral does not remove that dependency.

## Configuration before activation

For a later switch to gated promotion, configure separate GitHub environments named `staging` and `production`. Each needs secrets `DATABASE_URL` (PostgreSQL migration connection) and `VERCEL_TOKEN` (scoped deployment credential), plus variables `VERCEL_PROJECT_ID`, `VERCEL_ORG_ID` and `BACKEND_RELEASE_ENABLED=true`. Explicitly change root `git.deploymentEnabled` to false for that switch; preflight refuses gated promotion while Git deployments remain enabled. Review environment protection and branch rules. Keep runtime secrets in the matching Vercel target; the workflow does not upload the ignored local env JSON. Never copy production database/Redis credentials into staging.

Worker enforcement is a separate opt-in: after establishing and verifying a persistent worker per environment using `PERSISTENT-WORKER.md`, set runtime `REQUIRE_QUEUE_WORKERS=true`. Readiness then returns 503 when required consumers are absent. The release helper honors the API's explicit `workersRequired: false`; responses without that field retain strict worker checks. Existing queued jobs must be reviewed before starting a consumer. A first attached Vercel daemon starts on promotion, so it cannot satisfy a worker-required candidate gate before its initial promotion; bootstrap a separate worker service first or agree a supervised maintenance procedure.

## Release sequence

1. Lint, application/script typechecks, tests with unchanged coverage thresholds, database integration tests and a real Docker context/image check must pass.
2. Per-branch release serialization and checked-head validation reject stale commits before migrations.
3. Apply additive Prisma migrations and the insert-only production reference seed using the matching GitHub environment connection.
4. Build a Vercel candidate with domain assignment skipped. Verify its project, deployment target, ready state and checked-commit metadata.
5. Query protected candidate readiness through `vercel curl`. Database, Redis and all eight queues must be up. Worker capabilities must also be up unless the API explicitly reports `workersRequired: false`.
6. Recheck the branch head. Production promotes the candidate; staging assigns only `staging-api.belivrhq.com`. Check canonical-domain readiness afterward.

The release helper suppresses raw CLI failure output because it can contain credentials. Use the deployment dashboard and sanitized workflow result to investigate. Local release simulations run with `npm run release:test`; they do not deploy anything.

## Failure and rollback

A failed pre-promotion check leaves the existing domain assignment in place. Migrations have already run by then: schema compatibility with the previous API and worker is required. Do not automatically roll back schemas, encryption keys or data. A canonical check can fail after promotion; this is an incident requiring inspection and a deliberate compatible application rollback, not proof that traffic never moved.

Deploy worker releases with compatible API/schema contracts. Generation-aware webhook recovery must not be followed by a rollback to a consumer that ignores dispatch generations. Keep the prior compatible worker artifact available. Review `QUEUE-FAILURE-RECOVERY.md` before any replay.

## Verification still required

The workflow has local simulated release-boundary tests, not a hosted promotion rehearsal. Docker-engine verification must run in CI where Docker is available. Coverage remains below the repository's 80% thresholds; the gate must remain failing until meaningful coverage closes that gap. No release token, worker, GitHub environment policy or hosted auto-deployment setting has been configured by adding these files.
