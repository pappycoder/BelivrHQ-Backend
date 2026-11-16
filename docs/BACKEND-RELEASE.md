# Checked backend releases

This branch prepares a release workflow; it has not changed hosted deployment settings. Do not merge the root `vercel.json` until the release credentials, worker hosting and required checks are ready. Its `git.deploymentEnabled: false` disables independent Git-triggered Vercel deployments when applied. See [Vercel Git configuration](https://vercel.com/docs/project-configuration/git-configuration).

## Configuration before activation

Configure separate GitHub environments named `staging` and `production`. Each needs secrets `DATABASE_URL` (PostgreSQL migration connection) and `VERCEL_TOKEN` (scoped deployment credential), plus variables `VERCEL_PROJECT_ID`, `VERCEL_ORG_ID` and `BACKEND_RELEASE_ENABLED=true`. Review environment protection and branch rules. Keep runtime secrets in the matching Vercel target; the workflow does not upload the ignored local env JSON. Never copy production database/Redis credentials into staging.

First establish and verify a persistent worker per environment using `PERSISTENT-WORKER.md`. The new readiness endpoint deliberately returns 503 when consumers are absent. Existing queued jobs must be reviewed before starting a consumer. A first attached Vercel daemon starts on promotion, so it cannot satisfy this workflow's candidate gate before its initial promotion; bootstrap a separate worker service first or agree a supervised maintenance procedure.

## Release sequence

1. Lint, application/script typechecks, tests with unchanged coverage thresholds, database integration tests and a real Docker context/image check must pass.
2. Per-branch release serialization and checked-head validation reject stale commits before migrations.
3. Apply additive Prisma migrations and the insert-only production reference seed using the matching GitHub environment connection.
4. Build a Vercel candidate with domain assignment skipped. Verify its project, deployment target, ready state and checked-commit metadata.
5. Query protected candidate readiness through `vercel curl`. Database, Redis, all eight queues and all eight worker capabilities must be up.
6. Recheck the branch head. Production promotes the candidate; staging assigns only `staging-api.belivrhq.com`. Check canonical-domain readiness afterward.

The release helper suppresses raw CLI failure output because it can contain credentials. Use the deployment dashboard and sanitized workflow result to investigate. Local release simulations run with `npm run release:test`; they do not deploy anything.

## Failure and rollback

A failed pre-promotion check leaves the existing domain assignment in place. Migrations have already run by then: schema compatibility with the previous API and worker is required. Do not automatically roll back schemas, encryption keys or data. A canonical check can fail after promotion; this is an incident requiring inspection and a deliberate compatible application rollback, not proof that traffic never moved.

Deploy worker releases with compatible API/schema contracts. Generation-aware webhook recovery must not be followed by a rollback to a consumer that ignores dispatch generations. Keep the prior compatible worker artifact available. Review `QUEUE-FAILURE-RECOVERY.md` before any replay.

## Verification still required

The workflow has local simulated release-boundary tests, not a hosted promotion rehearsal. Docker-engine verification must run in CI where Docker is available. Coverage remains below the repository's 80% thresholds; the gate must remain failing until meaningful coverage closes that gap. No release token, worker, GitHub environment policy or hosted auto-deployment setting has been configured by adding these files.
