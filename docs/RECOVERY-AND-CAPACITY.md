# Recovery and capacity verification

Supabase is the confirmed database/Auth/storage provider. Subscription plan, backup retention, PITR, recovery owners and alert recipients are unconfirmed. The checks below are a preparation checklist, not evidence of hosted protection or measured production capacity.

## Inventory recovery assets

Record the project and region for each environment, backup retention and latest successful backup, restoration access, recovery owner, recovery-point target and recovery-time target. Verify the actual dashboard configuration. Supabase database backup coverage depends on the plan and PITR configuration; consult [Supabase backups](https://supabase.com/docs/guides/platform/backups) rather than assuming it is enabled.

Database backups contain Storage metadata, not the stored object bytes. Arrange object backups and validate restoration of representative private/public objects, sizes and access policies. Include Auth identities/configuration, provider callback configuration, migrations, role grants/RLS, current and historical encryption keys, environment secrets and deployment artifacts in the recovery inventory. Store secret/key recovery copies in an access-controlled secret manager. Lost encryption keys cannot be reconstructed by replacing them with new random values.

Redis contains pending jobs and ephemeral state. Document whether a restored queue should be resumed, reconciled against persisted domain records or discarded under an approved policy. Never replay payments or customer communications indiscriminately after a restore. Use persisted webhook intent and reviewed retry procedures for webhook recovery.

## CLI backup scope and privilege preservation

The operations console backs up only the PostgreSQL `public` schema. Its archive is not a complete Supabase project backup and excludes Auth and object contents. Private archives and hash manifests stay under ignored `.ops/backups` with restricted permissions; hashes detect corruption, not malicious replacement of both archive and manifest. Copy verified recovery artifacts off the application workstation under the agreed retention/access policy.

New manifest version 2 records privilege preservation. Backup and restore retain ACLs, including revocations on SECURITY DEFINER functions. Target roles referenced by grants must exist; restore is atomic and fails on errors. Rehearse with matching PostgreSQL tools and target roles in isolation. Do not discard security policies or use `--no-acl` to force a restore through.

Legacy version 1 archives remain useful for isolated recovery, but automatic console restore refuses them because they were created without ACL preservation. Preserve those archives. Restore them only into an isolated environment, reapply reviewed grants/revocations/RLS from trusted migrations and validate access before any application cutover. Never relabel an old manifest as version 2.

## Isolated restore drill

1. Agree a dated scope and recovery targets; create an isolated project/database with no production outbound providers or consumers.
2. Restore a verified backup using the provider procedure or compatible tooling. Restore object bytes, Auth/configuration and secrets through their separate procedures.
3. Compare representative tenant totals, relationships, financial facts, encrypted-record decryption and Storage object access. Verify cross-tenant denial, anonymous denial of privileged functions, Auth login and expected RLS/grants.
4. Run the API and one worker against isolated Redis, with external sends/charges disabled or routed to approved sandboxes. Verify readiness, controlled processing, failure retention and recovery.
5. Record backup timestamp, recovered point, elapsed recovery time, verification results, missing assets and owner sign-off. Delete drill resources only under the agreed retention policy.

The local operations integration regression checks archive restoration and function privilege preservation against a disposable loopback database and fake Auth service. It cannot establish hosted backup coverage, an end-to-end Supabase restore or a business recovery-time objective.

## Capacity rehearsal

Use a working staging API and persistent worker with isolated data and provider sandboxes. Define tenant count, data volumes, authenticated roles, read/write mix, duration and concurrency before running. Exercise tenant/branch authorization, representative writes, database pool contention, provider delay, queue processing and worker loss/restart. Collect p50/p95/p99 latency, error rates, pool waits, oldest waiting job, throughput and recovery time. Confirm alerts reach a named operator.

The local mock load server and historical October results are not evidence of current application capacity. The compiled API/worker readiness smoke proves controlled processing and outage detection, not supported concurrent users. Run `npm run readiness:smoke` only with explicit disposable loopback `SMOKE_DATABASE_URL` (a test database) and `SMOKE_REDIS_URL`; it rejects hosted targets and cleans only its random Redis namespace.

Do not derive production thresholds or concurrent-user promises until representative measurements exist. Production load generation, real provider sends and charges require an explicitly agreed operational scope.
