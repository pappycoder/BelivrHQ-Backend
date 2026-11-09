# Offline API rollout

Deploy backend and web together after applying `20261010200000_offline_receipts`. The migration was exercised on an isolated local PostgreSQL database; it has not been applied to the application database. Run the permissions seed to apply `offline:read` to staff templates and remove member event management grants.

The first browser release prepares one branch and supports member/visitor contact create/edit plus published form answer drafts/submissions. `offline:read` is required for all offline API access. Existing `members:all:read`, `members:new:create`, `members:all:update`, `visitors:list:read`, `visitors:new:create`, `visitors:list:update` and `forms:list:read` permissions govern access. Admin HQ may choose any church branch; other profiles are pinned to their branch.

## API contract

- `GET /api/v1/offline/snapshot?branchId=<uuid>` returns account/branch identity, current permissions, a seven-day lease and contact/form records. It rejects oversized snapshots rather than truncating them.
- `POST /api/v1/offline/push` requires `{profileId, churchId, mutations}`. A batch has 1–25 operations. Each has a stable UUID `mutationId`, UUID `entityId`/`branchId`, entity (`member`, `visitor`, `submission`), action (`create`, `update`), optional original server `baseVersion`, optional `formId` and `data`.
- Each operation returns `{mutationId, status, version?, message?}`. `accepted` operations may be removed from the local outbox only after a durable local commit. `conflict`/`rejected` operations remain for review. `retry` indicates a temporary/infrastructure failure and preserves the original mutation ID.
- Receipts are scoped by church, profile and mutation ID. Their payload hash prevents reusing an ID with different content; advisory locks handle concurrent replays. A new ID is required after manually resolving a conflict. Receipts remain independent of the expiring legacy sync queue.
- Conditional writes compare server `updated_at`; client wall-clock time does not choose the winner. Effects, acknowledgements and audit entries commit atomically.
- Form submissions recheck the current definition, publication/archive status, schema version, field validation, authenticated-user deduplication, unique field and capacity. Attachments require the online domain API.
- Snapshot refreshes are complete and bounded, so browser clients do not depend on the legacy feed cursor/retention. Existing mobile `/sync` APIs are unchanged.

The browser encrypts IndexedDB with a local passphrase and preserves pending changes across logout. Server login and authenticator verification still need internet. Revocation takes effect at the next online check; a disconnected encrypted copy cannot be remotely erased immediately. Full UX and limitations are documented in `BelivrHQ-Web/docs/OFFLINE-WORKSPACE.md`.

## Running the suites

```sh
npm test -- --runInBand
npm run build
TEST_DATABASE_URL=postgresql://user@127.0.0.1:55439/belivrhq_offline_tests npm run test:e2e -- --runInBand
```

Create and migrate an **isolated local test database** first. E2E setup rejects non-local hosts and databases without `test` in their name. Apply migrations to that database using an explicit `DATABASE_URL` override. Tests never require seeding the application database or real Supabase identities.

New tests cover transaction/replay concurrency, payload rebinding, version conflicts, permissions, branch isolation, form validation and durable acknowledgements. Unit tests cover the API DTO bounds and changed-account rejection. Existing suites now use current request context dependencies, effective ownership permissions, cache identity/version contracts, restricted media paths and the authenticator/recovery flow. Additional authenticator tests cover secret encryption, one-use TOTP/recovery codes, attempt budgets and session approvals.
