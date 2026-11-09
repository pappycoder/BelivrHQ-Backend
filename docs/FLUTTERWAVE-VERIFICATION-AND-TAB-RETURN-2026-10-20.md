# Successful Flutterwave payments and tab return

## Confirmed cause

The shared Flutterwave adapter called `/v3/transactions/verify_by_tx_ref`. A real
read-only check showed that path returns HTTP 200 **HTML**, so JSON parsing fails
and every browser, webhook and worker verification retries without applying payment.
Previous test fixtures reproduced the same incorrect URL and missed the defect.

Flutterwave's documented endpoint is
`/v3/transactions/verify_by_reference?tx_ref=...`. Using it returned JSON with
`successful` status and exactly matching references, amounts and currencies for
two records still pending in BelivrHQ. The adapter and integration fixtures now use
this route. The provider unit regression independently requires that exact route
and returns HTML for other paths, so the original defect fails the test.

Official contract: [Verify transaction status with reference](https://developer.flutterwave.com/reference/verify-transaction-with-tx_ref).

## Existing payment recovery

The two diagnosed test-merchant payments (reference suffixes `4c7d2b78` and
`b4579e7d`) were reverified and reconciled through `BillingService.reconcilePayment`.
Each belonged to a different unpaid church with a matching subscription baseline.
Both now have payment status `success`, application status `applied`, and an active
subscription. No checkout, charge, manual entitlement override or replacement
registration was created. Financial checks and normal transactional claims were
retained. The recovery changed these two existing application records and their
subscriptions; it was not limited to fixture data.

## Tab handoff

New checkout callbacks include `payment_window=1`, retained after removing payment
query parameters. This identifies the returned window even if browser storage is
unavailable. Existing checkout links still use the previous session-storage marker.
Neither the marker nor a URL success status proves a payment succeeded.

After its authenticated verification returns the exact matching applied payment,
the returned window publishes a same-origin hint through BroadcastChannel and a
temporary storage event, then closes itself. It keeps no opener. The parent listens
only for its church and tracked reference and immediately rechecks its own server
session. A hint never writes billing state or grants access. Once the parent's own
verification confirms success/applied and active access, it refreshes profile data
and navigates to `/dashboard`. Polling, reconnect and reload recovery remain fallbacks.

## Release

Validation passed: 95 focused backend provider/billing unit checks, all 363 web unit
checks, 10 disposable PostgreSQL/HTTP checks, and all 35 subscription/onboarding
browser checks. The handoff regression verifies that a successful second-tab return
closes that tab and wakes the original tab into `/dashboard`; forged success hints
still require authenticated server verification. Both production builds, TypeScript,
targeted lint and diff checks passed (four existing billing-test `any` warnings).

The existing records are already recovered in the connected database. Deploy the
updated backend and web together for future payment verification and the automatic
tab/dashboard handoff. No schema migration is needed. The deployed persistent worker
must also use the repaired adapter; Vercel HTTP instances alone do not run its cron.

No deployment was performed during this change. Automated provider responses are
mocked; the diagnosed records were also verified against the real test merchant API.
