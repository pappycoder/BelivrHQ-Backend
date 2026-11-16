# Backend production readiness implementation plan

Date: 2026-11-16 (Africa/Lagos)
Branch: `fix/backend-production-readiness`
Baseline: `525bb51`
Status: Implementation in progress; local source changes prepared, hosted rollout pending. See [project security audit](PROJECT-SECURITY-AUDIT-2026-11-16.md) for confirmed findings, remediation and remaining verification.

Worker rollout decision, 2026-11-16: hosting and activation are on hold. Retain the implemented worker code and disabled template; do not activate consumers until the operator resumes rollout. API worker enforcement is now opt-in through `REQUIRE_QUEUE_WORKERS=true`, with explicit worker diagnostics in deferred mode. Git deployments remain enabled; candidate promotion is opt-in and refuses concurrent Git deployment mode. This deferral does not close the remaining coverage, container, schema migration, recovery and hosted release checks. The branch remains unmerged.

## Current implementation evidence

- Baseline registration fixtures and maintenance-script types are repaired. Non-mutating lint/typecheck and unchanged 80% coverage gates are wired into CI. Coverage remains below target; this phase is incomplete and release must remain blocked.
- Private Docker-context exclusions and a real-engine regression are implemented. Docker is unavailable locally; CI must verify the context and worker image.
- Worker capability leases, privacy-filtered telemetry, shutdown limits, optional process liveness and bounded HTTP readiness are implemented. A compiled API/worker smoke against isolated PostgreSQL/Redis verified processing, worker-loss HTTP 503, independent HTTP 200 liveness and restart recovery.
- Transactional webhook intent, dispatch leases/crash recovery, terminal failure retention and audited generation-aware webhook retry are implemented and covered by unit/database regressions. Migrations have only been applied to disposable databases.
- A candidate-before-promotion release gate and simulated refusal tests are prepared; see `BACKEND-RELEASE.md`. Tokens/environment policies and a hosted rehearsal are outstanding. Git auto-deployment stays enabled while gated promotion is deferred; a later explicit switch must disable Git deployment before enabling candidate promotion.
- Backup tooling now preserves privileges and refuses automatic restoration of legacy ACL-less archives. Supabase recovery inventory/drill and representative staging capacity work are documented in `RECOVERY-AND-CAPACITY.md`; hosted backup coverage and recovery targets are unverified.
- The operator confirmed no persistent worker exists and uses Supabase. A disabled Vercel daemon template is prepared; no worker host or paid resource has been activated. Separately, the legacy test backend's Redis configuration was repaired and its existing source redeployed; that incident did not activate consumers or deploy this branch.

## Objective and evidence

Close the concrete reliability, deployment and validation gaps found in the backend review without changing business permissions, payment facts or existing encryption formats. Keep changes in independently reviewable commits on this branch.

The baseline review found 2,507 passing tests and five registration-test failures after sandbox-blocked suites were rerun. Those five failures originate from a ConfigService mock returning a web URL for the previous-key JSON setting; they do not establish a live registration defect. Application TypeScript passed; the maintenance-scripts project has errors in `scripts/delete-data.ts`. Database-backed E2E tests were not rerun during the review.

Production health returned healthy after the key and Redis connection fixes. A later read-only Redis snapshot detected no named workers on the eight queues. Treat worker availability as unconfirmed until a supervised worker and an actual controlled processing check are verified; Redis client naming alone is not a reliable readiness contract.

## Scope boundaries

- Backend only; change the web repository only if a discovered health consumer needs a coordinated compatibility update.
- Keep secrets and environment values outside Git. Preserve the explicitly requested pull redaction and empty-value push behavior.
- Do not regenerate keys, clear databases, replay real payments, send real customer communications or migrate existing records as incidental implementation steps.
- Separate source implementation from hosted deployment and provider configuration. Never infer provider readiness from a passing mock or an empty queue.
- Builds remain free of production data repair and key rotation. Destructive database operations retain existing backup and target safeguards.
- Do not provision a worker hosting account, incur a new paid service or choose a backup policy without the required operational information.

## Implementation sequence

### 1. Establish green, non-mutating quality checks

Files: `test/unit/auth/auth.service.spec.ts`, `scripts/delete-data.ts`, `package.json`, `.github/workflows/ci.yml`, `jest.config.ts`.

1. Make registration ConfigService mocks return values only for known settings, including valid empty previous-key lists. Add a regression for current/previous signing-key configuration.
2. Correct the maintenance script's Prisma typing using explicit checked model operations; preserve deletion order, target confirmation, dry-run behavior and backup protections. Never validate it by clearing a real database.
3. Add explicit application and maintenance-script typecheck commands and include both in CI.
4. Separate lint checking from automatic local formatting fixes so CI cannot silently rewrite and accept source changes.
5. Measure coverage first. Enable coverage collection in CI and enforce the existing 80% thresholds; if a real gap appears, add meaningful missing behavioral tests rather than lowering thresholds or excluding difficult code to pass.

Acceptance: all 2,512 baseline unit checks pass, new regressions pass, both TypeScript projects compile, lint leaves a clean tree, and the coverage gate actually runs. Run database-backed E2E tests against a disposable database with the full migration history before release.

### 2. Prevent private build artifacts from entering Docker contexts

Files: `.dockerignore`, `Dockerfile`, `test/ops/`.

1. Exclude `.ops/`, `.vercel/`, temporary exports and private credential artifacts while keeping placeholder examples and required build inputs available.
2. Review the full context and final image boundaries; do not assume multi-stage copying protects the uploaded build context.
3. Add a focused context regression with fake backup/config canaries and build the image without private environment files.

Acceptance: private canaries are absent from the effective build context and image; the image builds and starts with test configuration. Never print real secret contents during inspection.

### 3. Make worker readiness measurable and prepare supervised operation

Files: `src/worker.ts`, `src/queues/`, `src/redis/`, worker operations documentation and tests.

1. Add expiring, environment-namespaced worker heartbeats with instance identity and enabled queue/scheduler capabilities. Use a bounded query for health aggregation and expire stale instances automatically.
2. Emit readiness only after worker initialization succeeds; stop renewing on shutdown. An API producer must never satisfy a worker heartbeat check.
3. Add sanitized startup/failure telemetry for workers and reuse the HTTP application's telemetry privacy rules. Bound connection, startup and shutdown behavior.
4. Prepare the persistent worker launch configuration, restart policy, resource/pool budgets and required variable-name checklist. Match `QUEUE_REDIS_URL`, database, namespace and current/retained application keys with the corresponding API environment.
5. Verify scheduler behavior with more than one worker. Use distributed claiming or stable job identities where necessary; process-local flags alone must not imply exclusive execution.

Acceptance: tests distinguish producer-only, active, stale, wrong-environment and partially initialized workers. In staging, a harmless controlled job completes and heartbeats disappear after the worker stops. A supervised production deployment remains a rollout dependency, not something source tests can establish.

### 4. Correct health semantics and bound dependency checks

Files: `src/health/health.controller.ts`, supporting health service/tests, operations health consumer and Docker healthcheck where needed.

1. Preserve `/api/v1/health` and its existing response envelope and fields; document any HTTP-status behavior change for consumers.
2. Add separate liveness and readiness routes. Liveness checks only that the process responds. Readiness checks database, cache, queue transport and required worker freshness.
3. Return HTTP 503 when readiness requirements are unmet; never return a success status with an unhealthy readiness result.
4. Run independent checks concurrently with explicit deadlines and bounded Redis retries/offline behavior. A timeout must not leave an unbounded accumulation of background checks.
5. Distinguish Redis connectivity, queue accessibility, consumer availability and backlog health. Report sanitized reasons and check latency without exposing credentials or member data.

Acceptance: database/Redis outages, absent/stale workers and hanging queue calls produce truthful bounded responses; liveness stays responsive during dependency failure. Existing response consumers retain a documented compatibility path.

### 5. Recover outbound webhooks across database/Redis failures

Files: `src/webhooks/`, Prisma schema/migration if necessary, integration tests.

1. Reuse the existing company-email lease/recovery design as a reference, without rewriting its working delivery behavior.
2. Make the persisted webhook delivery record the durable dispatch source. Add a bounded recovery scan with a lease, stable queue job identity and clear dispatch/delivery states.
3. Persist the event and delivery intent atomically where the calling domain transaction requires it. Explicitly document any remaining event-creation boundaries.
4. Retry dispatch after Redis failure or a crash between persistence and queue acceptance. Handle ambiguous queue responses and stale leases without inventing exactly-once delivery guarantees.
5. Recheck current subscription/endpoint eligibility before sending and preserve existing HMAC verification contracts, URL safety checks and tenant isolation.

Acceptance: fault-injection tests cover crashes before/after enqueue, Redis outages, duplicate scans, competing workers, restart recovery, disabled endpoints and eventual delivery. Retries must not generate unrelated delivery records or silently drop pending work.

### 6. Complete failed-job handling and controlled recovery

Files: queue processors, `src/queues/processors/dead-letter.processor.ts`, authorized operator tooling and tests.

1. Route exhausted, eligible jobs to durable dead-letter records or a deduplicated dead-letter queue with original queue/job identifiers and sanitized failure metadata.
2. Remove raw job-data logging; recipient addresses, bodies, credentials and tokens must not enter generic failure logs.
3. Provide inspection and narrowly authorized replay with audit records, target validation and current eligibility checks.
4. Define replay policy per job type. Do not apply generic replay to payment/recurring-charge jobs; use the domain's reconciliation/idempotency contract. Preserve the existing WhatsApp SMS fallback behavior.
5. Configure retention, backlog age/failure signals and an operator response procedure.

Acceptance: one exhausted job creates one reviewable failure entry, safe retry does not replay completed business effects, unauthorized or stale replay is rejected, and log-privacy tests pass.

### 7. Coordinate CI, migrations and application promotion

Files: `.github/workflows/ci.yml`, deployment workflow/configuration, rollout documentation.

1. Inspect actual Vercel deployment/check settings before selecting a release gate; do not assume dashboard protection is absent.
2. Establish one auditable sequence: checks and disposable-database E2E -> artifact build -> target migration/reference seed -> target deployment -> smoke/readiness check -> traffic promotion.
3. Prefer a tested candidate deployment before production domain promotion. Prevent the independent Git integration from bypassing the chosen release gate.
4. Serialize releases per environment, keep Preview/Production credentials isolated, and preserve the current insert-only reference-seeding policy.
5. Plan worker rollout together with API changes. Use backward-compatible migrations and document rollback limits; do not automatically reverse production schemas or key rotations.

Acceptance: a failing check or migration prevents promotion, staging uses its own database/Redis namespace, the promoted release identifies the checked commit, and failure leaves the previous production release serving traffic where schema compatibility permits.

### 8. Verify recovery and capacity operationally

Files: operations and load-test runbooks, narrowly scoped tooling where required.

1. Inventory actual provider backups/PITR, retention, encryption, offsite copies and restoration access. Existing CLI backup tooling is not proof that hosted recovery is configured.
2. Agree recovery-time/recovery-point targets, owners and retention requirements. Restore a backup into an isolated environment and validate application data, storage references and access boundaries.
3. Account for Supabase Auth, stored objects, Redis/queued work and historical encryption keys alongside the PostgreSQL public schema. Never restore over production as a drill.
4. Repeat representative capacity tests in staging with controlled data: concurrent tenants, authenticated reads/writes, provider latency, queue throughput and worker failures. Record percentile latency, errors, pool waits, backlog age and recovery.
5. Set thresholds from measured results. Historical 2026-10-24 load results must not be presented as current capacity or converted into a concurrent-user claim.

Acceptance: a dated restore drill meets agreed recovery targets; capacity results and alert thresholds have reproducible evidence. Production load tests, paid infrastructure changes and real external sends require a concrete operational scope before execution.

## Dependencies and commit boundaries

- Commit 1: registration test fixtures and maintenance-script typing.
- Commit 2: effective CI type/lint/coverage checks.
- Commit 3: Docker context exclusions and regression.
- Commit 4: worker heartbeat, lifecycle and telemetry.
- Commit 5: bounded liveness/readiness and consumer compatibility.
- Commit 6: durable webhook dispatch/recovery and migration if needed.
- Commit 7: dead-letter routing, safe operator recovery and privacy.
- Commit 8: release gating and staged rollout documentation/configuration.
- Commit 9: recovery/capacity runbooks and recorded staging evidence.

Steps 1 and 2 can be completed before worker hosting is chosen. Step 4 depends on the worker heartbeat contract. Step 6 depends on delivery recovery semantics. Release gating must be ready before promoting any additive schema changes. Recovery and capacity verification follow a working staging deployment.

## Required operational information

Gather during implementation; these do not prevent local code and tests from starting:

- Persistent worker host and deployment access; whether a worker already exists outside this repository.
- Vercel Git-deployment/check configuration and deployment-token storage in CI.
- Current backup/PITR coverage for database, Auth and storage; recovery targets, retention and owners.
- Staging test identities and safe external-provider fixtures or sandbox accounts.
- Alert destination and owner, plus acceptable latency/backlog thresholds.

## Rollout and completion checklist

- [ ] Baseline failures fixed; all required checks and disposable-database E2E pass.
- [ ] Docker context excludes private snapshots and credentials.
- [ ] Worker heartbeat, bounded health checks and telemetry verified in staging.
- [ ] Webhook dispatch and dead-letter recovery pass crash/retry/concurrency tests.
- [ ] Release gate demonstrably blocks failed checks and migrations.
- [ ] Staging exercises complete without real customer messages or payment side effects.
- [ ] Target database backup and migration compatibility reviewed before deployment.
- [ ] Supervised production worker and API deployed in the documented order.
- [ ] Public readiness is healthy; controlled processing and failure alerts verified.
- [ ] Isolated restore drill and current capacity results recorded.

Completion requires evidence for the checklist. A healthy API response, passing unit tests or a successful deployment alone does not complete this plan.
