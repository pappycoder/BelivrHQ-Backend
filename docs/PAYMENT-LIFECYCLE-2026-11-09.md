# Payment lifecycle and subscription access

Apply `20261109180000_payment_lifecycle` before deploying the API, worker and web changes. Regenerate Prisma Client. The migration adds nullable provider identity/lifecycle fields, independent subscription access periods, checkout closure metadata, and adjusts the pending-checkout uniqueness constraint. Database feature, capacity and role checks use the same access periods as API guards. No existing payment amounts, currencies or references are rewritten.

## Behavior

- Charge callbacks always verify the original reference, currency and exact amount with the originating account before settlement. Failed charges may later succeed. Delayed failed/pending callbacks cannot overwrite a successful payment. Refunds and disputes cannot be undone by a charge-success callback.
- Refunds are recorded by provider refund ID. Pending, processing and failed refunds do not remove paid access. Only settled amounts contribute to the refund total. Duplicate callbacks do not accumulate twice. Flutterwave `completed` means initiated; its documented disbursement-specific completion states are treated as settled. Unrecognized outcomes remain pending/review rather than granting access.
- Completed partial refunds and open disputes hold the affected subscription grant for review. A full refund or lost/accepted dispute revokes that grant. Unrelated, separately recorded paid periods keep their original dates. A revoked upgrade falls back to an available paid base plan; an upgrade cannot survive revocation of its base period.
- Pre-ledger applied payments with verification timestamps are reconstructed from their frozen baseline and application time when adjusted. Historical records without enough application evidence require operator review. An ambiguous legacy balance does not conceal a refunded payment; separately recorded grants remain available. Do not guess or silently delete historical paid periods during manual review.
- Tickets are issued in the same transaction as charge settlement. Refund/hold updates change ticket and registration state atomically. Held/refunded tickets cannot check in. Used/check-in history is retained. A won dispute restores tickets held by that payment handler, preserving separate ticket cancellations.
- Original giving amounts remain immutable. Held gifts are excluded from successful-giving aggregates until resolution. `paymentReview` and `refundedAmount` expose the adjustment. These aggregates are confirmed giving totals, not a net cash/refund accounting ledger.
- A new checkout cannot sell an overlapping period across an unresolved current hold or an already-paid future period. Support reviews that gap before another quote can be paid.
- Closing checkout only closes the local attempt. It does not assert that no provider charge exists or initiate a refund. Abandoned pending checkouts close after 24 hours. Late verified money from a closed checkout is recorded for review and does not grant another period. Initialization attempts interrupted before receiving a URL can be closed by the administrator.

## Review

`POST /api/v1/billing/payment-review` accepts `{reference, decision: "release" | "revoke", reason}`. Existing billing-update authorization and an explicit `super_admin` role check apply, using the authenticated church context. The reason must contain 10 to 500 characters. Only an existing held grant is reviewable; fully refunded access cannot be released through this endpoint. Decisions are audited in the same transaction. A decision applies to the reviewed adjustment facts only; a new refund/dispute outcome requires fresh review. Late payments whose original quote no longer applies require support to resolve the money separately, rather than granting access against stale terms.

`POST /api/v1/billing/checkout/close` accepts `{reference}` and requires billing-update authorization. The billing screen exposes this action before selecting different paid terms.

## Recovery and operations

The two-minute worker rotates bounded batches through platform payments for both providers and church giving/ticket payments. It verifies charges, captures original provider identifiers, and reads refund/dispute history to recover missed callbacks. There is no seven-day cutoff. Individual failures retry on a later pass; HTTP-only/serverless instances do not run the worker. Run the existing worker process in deployment. Recovery can be slower for large histories because each scan is bounded; monitor retry warnings and provider rate limits.

Church callbacks validate the signature against the historical merchant account attached to the charge, including archived accounts. Original provider IDs and Flutterwave references allow matching refunds/disputes that omit merchant references. Unmatched or ambiguous adjustments fail for provider retry instead of acknowledging an unprocessed refund. For old charges missing provider identifiers, run reconciliation before replaying their adjustment callbacks.

Platform webhook URLs:

- `/api/v1/billing/webhooks/flutterwave`
- `/api/v1/billing/webhooks/paystack` for historical Paystack payments

Church payment webhook URL: `/api/v1/integrations/payments/webhook/{provider}`. Legacy Giving and Paystack event-ticket callback URLs route through the same settlement logic.

Use the Flutterwave V3 refund webhook preference to configure refund delivery separately. Chargeback webhooks require Flutterwave enablement. Verify charge, refund and dispute delivery against the intended test/live merchant account. Flutterwave static `verif-hash` and HMAC `flutterwave-signature` are supported. Paystack accepts legacy `x-paystack-signature` and timestamped `Paystack-Signature`; modern verification requires optional `PAYSTACK_WEBHOOK_SECRET` for platform payments or the church account's optional webhook signing secret. Prefer the modern header when both are present. No credential values were changed by this implementation.

ChurchOS uses its own prepaid subscription ledger and manual renewals. Provider-native `subscription.*`/invoice lifecycle events do not create ChurchOS access; supporting a provider-native recurring contract would require a separate explicit integration.

Before production rollout, send signed test charges, failed/pending charges, settled/failed partial and full refunds, and dispute open/won/lost events. Verify delivery retries and recovery with the worker running. Local tests use mocked providers and cannot prove dashboard delivery or real merchant API behavior.

## Provider references

- [Paystack webhooks and signing](https://paystack.com/docs/payments/webhooks/)
- [Paystack refunds](https://paystack.com/docs/api/refund/)
- [Paystack disputes](https://paystack.com/docs/api/dispute/)
- [Flutterwave refunds and completion states](https://developer.flutterwave.com/docs/refunds)
- [Flutterwave chargebacks](https://developer.flutterwave.com/docs/chargebacks)
- [Flutterwave refund history](https://developer.flutterwave.com/reference/get-all-refunds)

## Local verification

603 focused backend unit tests across billing, giving, events and integrations; 16 disposable PostgreSQL/HTTP tests; 643 frontend unit tests; 16 subscription/settings browser checks, with the three final checkout/hold cases rerun against the rebuilt artifact. Both TypeScript checks and scoped lint passed (four pre-existing test-fixture `any` warnings). Both fresh migration deployment and the isolated production frontend build passed. The frontend build used cached copies of the existing Google Fonts because live font downloads stalled. No production database, merchant account, credentials or payment was changed. Temporary test servers were stopped.
