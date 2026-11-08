# Public member and visitor registration

## Pending register columns and sorting (2026-11-08)

`GET /intake/submissions` additionally returns `fields` with the core intake fields and applicable active custom-field definitions. This lets the web offer all optional columns without requiring an answer on the current page. Existing response rows and pagination metadata are preserved.

`sortBy` accepts `createdAt` (default), `firstName`, `lastName`, `email`, `phone`, or `branch`; `sortOrder` accepts `asc` or `desc` (default). Sorting happens before pagination, with an ID tie-breaker. JSON-answer and branch sorting use closed SQL expressions and parameterized scope/search/pagination values; the destination query repeats church/branch scope. Search wildcards are escaped consistently in the count and sorted-row queries. Swagger documents the parameters and field metadata.

The web's confirmed bulk review calls the existing individual accept/reject endpoints. Each acceptance retains its existing transaction, duplicate checks and review metadata; rejection still hard-deletes answers. Batches report per-record failures and retain those records for correction. No batch endpoint, migration, permission or environment changes are introduced.

Each branch has a stable, random-token member link and a separate visitor link. Links are obtained through **Public registration link** on either register or its import page. HQ staff select a branch; other staff use their own branch. Sharing a link permits anonymous registration only, never reading submissions or existing people.

Public registration uses the church name and uploaded church logo, with an app-mark fallback only when no church logo is configured. The same branding applies to public/private Forms-module respondent pages and builder previews. An image loading error keeps church identity without substituting app branding.

## Review

Staff with the corresponding register's read and create permissions see **Records** and **Pending registrations** tabs. Pending responses can be searched, paginated, filtered by branch at HQ, and opened for corrections. Branch ownership cannot be changed from the response.

Acceptance requires confirmation, runs destination validation and creation in the same transaction as resolving the registration, and retains an accepted receipt with reviewer, time and destination ID. Failures leave the response pending. Church-level transaction locking serializes reviews and duplicate checks. Member creation notifications run after commit.

Rejection requires a destructive confirmation and permanently deletes the pending answers. Its audit entry contains the actor, church, entity reference and action, without answer data. General-purpose Forms-module approvals are unchanged.

## API

Paths below are relative to `/api/v1`.

| Method | Path | Access |
| --- | --- | --- |
| GET | `/intake/public/:token/meta` | Public church/branch identity and allowed fields |
| POST | `/intake/public/:token/submit` | Anonymous, ALTCHA proof and empty honeypot required; rate limited |
| POST | `/intake/links` | Body: `kind`, `branchId`; corresponding `members:new:create` or `visitors:new:create` |
| GET | `/intake/submissions` | Query: `kind`, optional `branchId`, `search`, `page`, `limit`; register read and create |
| GET | `/intake/submissions/:id` | Query: `kind`; scoped read and create |
| POST | `/intake/submissions/:id/accept` | Query: `kind`; body: corrected `data`; scoped read and create |
| DELETE | `/intake/submissions/:id` | Query: `kind`; scoped read and create; pending responses only |

`kind` is `members` or `visitors`. Anonymous answers use only metadata field keys. Custom fields use `custom:<definition-id>` and map to church-defined names in destination custom fields. Administrative fields and caller-provided church/branch assignments are rejected.

The feature uses member/visitor access rather than the premium Forms feature. Public links pause when the subscription is inactive or the church/branch is archived. Existing database member capacity limits continue to apply on acceptance. Both intake tables enable RLS and deny direct access to browser database roles.

## Deployment and verification

Apply migration `20261107120000_public_people_intake` with `npm exec prisma migrate deploy` in the backend deployment environment, then deploy the API and web app together. No new environment variables or permission seeds are required. Existing ALTCHA configuration is reused. No live registration records are backfilled or automatically accepted.

Focused coverage lives in `test/unit/intake.service.spec.ts`, `test/e2e/intake.e2e-spec.ts`, the bot-protection HTTP suite, and the web `people-intake.e2e.ts` / `public-forms.e2e.ts` browser suites. Database tests require an isolated local database whose name contains `test` and exercise migration access restrictions, concurrency, rollback, duplication, and tenant/branch isolation.

Verified locally: 205 focused backend unit checks, 8 PostgreSQL integration checks (also with one connection), 5 HTTP bot-protection checks, all 566 web unit checks, and 23 focused browser checks passed, along with both production builds, TypeScript and scoped lint. The migration was applied only to a disposable localhost test database. Older forms-table/import browser suites still target removed routes and are not part of this passing focused run.
