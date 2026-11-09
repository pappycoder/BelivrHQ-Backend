# Video uploads and visitor importing — 2026-10-25

## Video upload investigation and implementation

The previous flow sent multipart bytes through the Next.js API proxy and then the backend before uploading to Supabase Storage. The proxy buffers the body and has a 60-second upstream timeout. Its catch handler returns a generic 503 for upstream network failures/timeouts. Supabase upload errors in the old API service return 500; rate-limit infrastructure failures can independently return 503. Without deployment logs, the exact source of the reported live 503 cannot be established. The user confirmed their video is 1.9 MB, which is below Vercel's documented 4.5 MB function payload limit; that limit alone does not explain this incident.

All non-image uploads now use the same direct-storage workflow, including small audio/video files:

1. The browser POSTs filename, MIME type, byte count, folder and branch to `/media/upload/prepare`.
2. BelivrHQ checks active plan eligibility, upload permission, folder, size/type and branch ownership. It creates a random, non-overwriting storage path in the existing private bucket and obtains a signed upload URL. No service-role credential reaches the browser.
3. The browser PUTs the bytes directly to that URL, without BelivrHQ cookies or credentials. A storage error is identified separately from a BelivrHQ API error. The transfer allows up to ten minutes.
4. `/media/upload/complete` verifies a server-signed completion ticket bound to user, church, branch, file metadata, asset ID and path. Completion authorization lasts one hour. Current plan, permissions and branch validity are checked again; storage-reported size and MIME type must match before the library asset is created.
5. Completion is idempotent. A completed transfer is retained in browser memory if the metadata save fails, allowing a retry without transferring bytes again. Revoked/expired authorization is discarded so a fresh grant can be requested. Failed sermon-section PATCHes retain the returned recording URL independently.

The existing 50 MB file limit remains. Images retain the existing optimization/upload route. Unfinished direct uploads remain private and are not published as library assets; this change does not add an orphan-object cleanup job. Bucket/provider limits may also apply. No production upload or storage mutation was performed during verification.

References: [Vercel upload guidance](https://vercel.com/kb/guide/how-to-bypass-vercel-body-size-limit-serverless-functions), [Supabase signed uploads](https://supabase.com/docs/reference/javascript/storage-from-createsigneduploadurl).

## Visitor import

Visitors → Import Visitors opens a shared four-step importer: upload CSV/XLSX, map columns, preview validation, then confirm import. The member importer uses the same component and retains its member fields and endpoint. Spreadsheet parsing continues in the bounded worker, with formula/archive/row/cell limits.

The visitor template contains First Name (required), Last Name, Email, Phone, WhatsApp Number, Gender, First Visit Date, Branch and Notes. Phones are Text; dates are real spreadsheet dates with native validation. Calendar availability depends on the spreadsheet app. Status, conversion fields, custom fields and assignee identifiers are excluded from import; imported visitors start with the ordinary New follow-up state.

`POST /visitors/bulk-import` requires the existing `visitors:new:create` permission. Batches contain 1–100 visitors. A dry run validates without creating records or audit entries. Each row validates against an import-only DTO and uses the existing branch and visitor creation/audit path. Staff are restricted to their branch; HQ destinations must be active branches in the same church. Invalid rows return errors without blocking subsequent valid rows. Contact duplicate checks reject matching existing email/phone values and repeated contacts within a batch; the client also catches normalized repeated contacts across the file. Existing database phone matching covers submitted/digit/plus-prefixed forms, not every possible historical phone formatting convention; visitor names are not treated as unique identifiers.

Client-invalid rows are excluded from submission, preventing unknown branch names from silently becoming unassigned visitors. API error row numbers are translated back to the spreadsheet's data-row positions. Summaries count distinct failed rows rather than individual validation messages. A transport failure stops subsequent batches and reports possible partial completion; import is not retried automatically. Contact-free records have no natural idempotency key, so partially completed files should be reviewed before manual retries.

## Deployment

Deploy the API before or together with the web application. The browser requires the new prepare/complete and visitor bulk-import endpoints. No migration, new permission seed or new environment variable is required. Existing Supabase storage and service-role server configuration are reused. The assistant route catalog includes the visitor import route.

## Verification results

106 API unit checks, 17 web unit checks and 15 mocked browser flows passed. Browser coverage includes real browser File transfers of 1.9 MB and 5 MB to a mocked signed storage endpoint, section/PATCH failure retries, visitor import preview/confirmation, invalid/duplicate source rows, second-batch source row numbers, permission denial and the shared member import regression. Targeted ESLint, TypeScript and both production builds passed. No live backend/storage/visitor business writes or deployment were performed. This verifies the implementation with controlled services, not the cause or resolution of the original production 503.
