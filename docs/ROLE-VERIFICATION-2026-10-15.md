# Role verification — 15 October 2026

## Status

All ten built-in roles pass automated source-level permission/scope contracts. This is not a certification that every deployed account or every end-to-end workflow is correct. The read-only database audit could not connect or complete; persisted global templates, church overrides, custom roles and account assignments remain unverified. No live grants, accounts or database records were changed.

The canonical catalog contains 383 permission names. The cross-project audit checks 277 literal backend permission-decorator references and 321 literal frontend action/navigation references: zero unknown or missing catalog codes after correcting frontend catalog omissions. Dynamic permission expressions and service-level business rules still require their behavioral tests; matching a code alone is not proof of authorization correctness.

## Explicit default-role contracts checked

The table describes representative contracts, not an exhaustive feature list. API permissions are resolved through the real union/reserved-grant logic using source template fixtures; no live database grants are used by this matrix.

| Role | Representative allowed operations | Representative denied operations |
|---|---|---|
| `super_admin` | All catalog grants; protected account-management rules still apply | Cross-church access through tenant helpers |
| `church_admin` | Role/settings/branch management; full operational grants | Cross-church access; super-admin account restrictions remain |
| `senior_pastor` | Operational member/giving management, appointments, role viewing | Settings, branch creation, role/profile administration |
| `branch_pastor` | Same operational template as senior pastor | Same reserved administrative operations |
| `secretary` | Member creation, registrations, forms, reports, appointments | Attendance check-in, giving records, group giving, role/settings administration |
| `treasurer` | Giving records, financial reports/analytics, asset administration | Member directory, service creation, All Events, reserved settings/roles |
| `usher` | Treasurer baseline plus services, attendance records/reports, group details | Member directory, recording group giving, profile/role administration |
| `department_head` | Own department management, existing media updates, personal tickets | Department creation, media upload, new sermons, giving records, roles |
| `cell_leader` | Own group management, group meeting giving, personal tickets | Group deletion, general giving records, All Events, check-in, roles |
| `member` | Own member access, personal tickets, sermon/media reading | Member directory, profile/role/settings administration, offline workspace |

## Scope combinations checked

Every role is exercised with HQ off and on. Every role is also checked with HQ off and no assigned branch.

- Branch-only viewers can access their own branch through the common scope helpers; other branches and cross-branch writes are denied. Missing branch assignments do not remove the branch filter, and branch-owned writes fail.
- HQ expands branch scope inside the church but does not add action permissions. A treasurer with HQ does not become a role/settings administrator. Even administrators with HQ off remain branch-filtered.
- Cross-church context mismatches are denied with either HQ setting.
- Cell leader/department head own-read scopes select their linked group/department for branch-only viewing. Existing service tests separately cover HQ leaders reading broadly while modifying only records they own.
- Multi-role unions retain allowed grants without creating reserved administrative grants. Their ordering now includes `cell_leader` above `member`; previously it fell back to rank zero. `cell_leader` is now explicitly reserved against custom-role naming even if its global template is missing.

HQ does not select an account's church or confer platform-wide tenant access. Shared church-wide records and personal/ownership endpoints keep their separate service policies; the branch-owned-record matrix does not claim that all shared data must be hidden.

## Repeatable checks

Run from `BelivrHQ-Backend`:

```bash
npm test -- --runInBand --silent
npx ts-node -P tsconfig.scripts.json scripts/audit-permission-contracts.ts
npx ts-node -P tsconfig.scripts.json scripts/audit-role-database.ts
```

The contract audit reads the sibling `BelivrHQ-Web` checkout when present and explicitly reports `webAvailable`; it must be true for a complete cross-project result. The database audit uses a PostgreSQL read-only transaction and prints only catalog/template differences and aggregate counts, never connection strings or personal account data. Exit status 2 means the database was not verified; exit status 1 means differences were found. Do not substitute a permissions reseed for reviewing intentional church overrides.

Run the web suite with `npm test` from `BelivrHQ-Web`. The role round also checks TypeScript, scoped lint and the backend build; see the task response for completed totals.

## Still required for full deployment sign-off

1. Complete the read-only audit against the intended running database and inspect intentional overrides/custom-role configurations.
2. Exercise each role with HQ off/on in an isolated environment containing two churches, two branches per church, owned/unowned groups/departments and branchless fixtures. Test actual HTTP responses and browser workflows, not only menu visibility.
3. Exercise role/HQ/branch changes during an active session and confirm cache clearing plus denied stale API operations. The backend's existing cache-revocation limitation remains documented in its authorization audit.
4. Check resource-specific detail, export, bulk, upload and offline paths with out-of-scope identifiers. Current tests cover selected paths; the matrix does not constitute exhaustive endpoint penetration testing.

The older workspace `ROLE_TEST_PROCEDURE.md` describes historical nine-role expectations and legacy UI guards. It is marked superseded; use this report and current source contracts for expectations.
