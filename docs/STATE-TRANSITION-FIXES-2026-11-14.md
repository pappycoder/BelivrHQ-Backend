# State transition corrections

The state-machine maps now include six corrected workflows: equipment lending, visitor conversion, submission review, partial bulk retries, broadcast cancellation and unapplied subscription payments. Backend and browser keep their existing state representations except for additive payment review metadata and eligibility; no new state-machine library is required.

## Corrected behavior

| Workflow | Result |
| --- | --- |
| Asset lending | Lock equipment while checking/creating/returning loans. Enforce one outstanding borrowed/overdue loan per asset with a partial unique index. Loans no longer set equipment maintenance/active status; new borrowing requires active equipment. |
| Visitor conversion | Lock and recheck the visitor and validate the destination branch against the church. Create member, link visitor, record timestamps and write conversion audit in one transaction. Replays return the existing member. Notify only after commit. |
| Submission review | Accept only approved/rejected destinations. Conditional pending-state update admits one winner; repeated/competing decisions receive HTTP 409. |
| Bulk management | Offer an explicit Retry failed records action and keep only failed entries in its executable batch. Already successful actions are not replayed by that dialog. |
| Broadcast cancellation | Serialize recipient enqueue and cancellation on the campaign row; recheck pending recipient status, deduplicate enqueue replay with stable queue IDs, and condition completion on sending. UI calls the historical sent value Queued. Already queued jobs may still deliver. |
| Unapplied payment review | Reverify payment and adjustment facts, require super admin plus reason, and resolve under the church lock. Apply eligible renewals after existing base coverage or revoke application without claiming to refund. Reject applying stale prorated upgrades. Preserve explicit application revocation during later adjustment reconciliation. |

## Payment review contract

`POST /api/v1/billing/payment-application-review` accepts reference, decision (`apply` or `revoke`) and a reason of 10 to 500 characters. Authentication, billing update permission and the service's super-admin check all apply. Registration capabilities cannot call this endpoint. Payment history exposes the Resolve unapplied payment action only for eligible money and an authorized super admin.

Eligibility requires verified successful payment, application review state, no matching access grant and no outstanding provider access hold. Application and adjustment reviews remain separate endpoints. Applying a renewal preserves separately paid current/future base periods; an unresolved current/future review grant blocks application. Revocation records a durable application decision but does not call a provider refund API. Identical completed resolutions are idempotent; conflicting decisions require a different reviewed workflow rather than silently replacing the earlier decision.

## Deployment and historical records

Deploy the API and worker with the web changes. First apply migration `20261114120000_one_outstanding_asset_loan`. Before migration, inspect outstanding duplicates using a read-only query against the intended deployment database:

```sql
SELECT asset_id, count(*) AS outstanding_loans
FROM asset_loans
WHERE status IN ('borrowed', 'overdue')
GROUP BY asset_id
HAVING count(*) > 1;
```

The migration deliberately fails if duplicates exist. Resolve each real loan using its actual return/lending history before retrying; no records are silently deleted or fabricated. Existing equipment statuses previously changed to maintenance by borrowing remain unchanged because the code cannot distinguish a real maintenance job from that historical encoding. Review those equipment records explicitly; returning an old loan will not reactivate an actually retired or maintained asset.

The loan invariant is an SQL partial index; Prisma schema fields do not change. Existing payment JSON remains readable. No application/hosted database migration or real provider operation is performed as part of local validation.

## Operational boundaries

Broadcast row locking coordinates application cancellation and enqueue attempts, but Redis acceptance and PostgreSQL commit are not a distributed transaction. Stable job IDs protect replay while BullMQ retains the job; they are not permanent exactly-once delivery. A queue response timeout can leave acceptance uncertain. Provider delivery remains separate from enqueue status, and already accepted jobs cannot be recalled by cancelling the campaign.

## Validation

Validation uses a fresh disposable PostgreSQL database with the committed migration history, mocked payment providers/outbound queues, and local browser fixtures. The concurrency suite checks loan creation/return, database constraint enforcement, visitor conversion/replay/rollback, competing review decisions, cancellation ordering, renewal period preservation, revocation durability and review authorization/hold boundaries. Browser coverage checks failed-only retries and super-admin payment resolution.

Current validation results:

- Backend: 2,376 checks passed in the full unit run; the five HTTP checks blocked by sandbox loopback restrictions all passed in their unrestricted local rerun (2,381 checks covered).
- PostgreSQL: all 213 checks across 30 integration suites passed on the disposable database. After adding the destination-branch guard, all 14 final transition checks passed, including concurrency, rollback, scope, payment holds and replay.
- Frontend: 671 unit checks passed. The existing loading-presentation check reports four bare loading paragraphs in three unchanged attendance files; those files and the check match the repository baseline.
- Backend and frontend production builds and scoped lint passed. The final UI contract audit reports zero issues; all 50 Mermaid diagrams parsed and rendered, and documentation source links/anchors resolve.
- All 19 final production browser checks passed, including explicit failed-only retry, super-admin application review, ordinary-admin exclusion, stale-upgrade revocation, and mobile billing/review layouts. The failed-only retry also passed its focused development-browser check.

The unchanged frontend copy-check offenders are [service check-in](../../BelivrHQ-Web/src/app/%28paper%29/gatherings/attendance/check-in/page.tsx), [event check-in](../../BelivrHQ-Web/src/app/%28paper%29/gatherings/events/check-in/page.tsx) and [general attendance](../../BelivrHQ-Web/src/components/attendance/general-attendance-panel.tsx). No hosted data or real payment-provider operation was changed. The disposable database was stopped after testing.
