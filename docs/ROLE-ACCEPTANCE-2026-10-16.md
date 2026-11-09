# Role acceptance — 16 October 2026

**Latest follow-up:** Web `docs/GO-LIVE-VERIFICATION-2026-10-16.md` now confirms 51/51 matching migrations, the invalid trigger physically absent and the production login helper removed. Seeded privileged authentication still works, and health/worker readiness remains unverified; these remain go-live requirements.


## Confirmed defects and fixes

- Form lifecycle helpers checked church ownership but did not consistently check branch ownership. Central form lookups now reject another branch, covering update, delete, clone, archive, restore, link regeneration, close/reopen and authenticated submission. Submission detail/review also constrain the parent form to the actor's branch or an intentionally shared form. Existing shared forms remain shared.
- Cloning a branch form omitted its branch, creating a shared copy. Copies made by branch actors now belong to their branch; HQ copies retain the source ownership. HQ form creation also validates the selected branch against the current church, while branch creation pins the caller's branch.
- The legacy `set_updated_at_form_submissions` trigger calls a function assigning `NEW.updated_at`, but submissions have no such column. Authorized approval failed with PostgreSQL 42703 / Prisma P2022. Migration `20261016090000_fix_form_submission_update_trigger` removes that invalid trigger without deleting records or changing submission fields.
- The frontend Families statistics request used limit 200 while the API accepts at most 100. The web query now uses 100. The family list hook also omitted the selected branch from its API query despite including it in the cache key; it now sends the branch filter, with a request-level regression. These statistics retain the existing bounded-sample behavior.

- Service detail pages fetched giving transactions for service-only readers. The frontend now independently gates the fetch and giving panels with transaction-read permission, preserving authorized service/attendance views.

## Evidence

`test/unit/auth/role-acceptance-matrix.spec.ts` enumerates permission-decorated controller HTTP methods and exercises the production PermissionsGuard with actual Nest permission metadata for all ten seeded roles, each with and without HQ. Separate scope cases verify that HQ changes branch visibility but never supplies action permissions. An additional read-only grant set cannot satisfy create/update/delete requirements. These are guard/scope tests, not authenticated HTTP workflows.

`test/e2e/role-workflows.e2e-spec.ts` uses real Nest controllers, DTO validation, permission guards, services, request context and PostgreSQL for members, visitors, forms, assets, families and attendance services. All ten roles run with both HQ values. Cases exercise permitted and forbidden create/read/update/archive/restore/delete operations and verify persisted results, tenant boundaries and branch boundaries. Additional cases cover read-only HQ mutation denial, foreign-church branch assignment, pinned branch creation, seven forbidden cross-branch form operations, submission review and clone ownership. Test identity middleware replaces JWT verification only in this isolated server; audit/notification integrations are stubbed to avoid external side effects.

All **33 integration tests** pass against a new disposable PostgreSQL database with every migration applied. The test environment refuses non-local database hosts or a database name without `test`. No deployed business data was modified. Real deployed authentication is covered separately by the web acceptance runner.

- Backend unit suite: **1,325 tests / 69 suites passed**.
- Backend production build and changed-file ESLint passed.
- Frontend unit suite: **312 tests / 10 suites passed**; production build passed.

## Initial audit deployment status (superseded by follow-up)

These fixes are local and tested. No deployment, live database migration, role edit or permission reseed was performed. A read-only schema inspection of the configured cloud database found the invalid trigger enabled and confirmed the column is absent. This proves that database still needs the migration; it does not establish which environment a particular backend deployment uses.

Apply `20261016090000_fix_form_submission_update_trigger` through the normal database release process and deploy backend/web fixes. No permission seed is needed. Repeat form review and branch-boundary smoke tests in the release environment. The deployed site cannot yet receive an unconditional all-clear. The user confirmed real church data is present while seeded demo accounts remain active for testing. The web helper is now development-only locally; the seeded authentication accounts still need retirement as part of the user’s planned cleanup.

The frontend live acceptance report is `../BelivrHQ-Web/docs/ROLE-ACCEPTANCE-2026-10-16.md`. Static inventory and earlier browser regressions cover more UI surfaces than the six modules with real persisted mutation tests. This is neither a claim of exhaustive business-logic verification nor a load/performance benchmark.

## Reproduction

Use an isolated local PostgreSQL database whose name contains `test`, set `DATABASE_URL`, then run:

```sh
npx prisma migrate deploy
npx jest --config test/jest-e2e.json test/e2e/role-workflows.e2e-spec.ts --runInBand
npm test -- --runInBand
npm run build
```

Never point the mutation suite at deployed business data. Existing `test/e2e-env.ts` enforces the local test-database boundary.
