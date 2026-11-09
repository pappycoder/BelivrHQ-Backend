# Pending subscription payment recovery

BelivrHQ keeps Plan & Billing open and opens the validated Flutterwave hosted URL
in a separate window. The window is opened during the button click so browsers can
allow it before the asynchronous checkout request completes. It has no opener, and
pop-up blocking does not create a payment attempt. A failed initialization closes
only a newly opened preparation window, never an already running checkout.

The parent tracks the payment reference and checks `/billing/verify` every five
seconds while visible, or every fifteen seconds after a verification error. Checks
pause offline/in the background and resume on reconnect/focus. A church-scoped
session-storage reference survives reload; reopening billing also discovers a server
pending payment without a callback. Pending/failed history entries can be rechecked.

Only the matching payment's `success` + `applied` result and an active subscription
unlock workspace navigation and let the returned checkout window close itself. Existing active access,
URL status parameters, window closure, provider messages and network errors cannot
confirm this payment. A review result stays on the payment screen for support.
The parent never attempts to navigate or close the external no-opener provider
page; browsers disallow that. The callback window waits for server verification
before closing itself. On mobile,
the browser may present the separate window as another tab.

## Server reconciliation

`BillingService.reconcilePayment` is shared by authenticated verification, signed
webhooks and the recovery worker. Existing church scoping, provider amount/currency/
reference checks, church locks and atomic success claims remain intact. Verification
now returns the exact persisted payment outcome alongside current billing status.
The worker uses the same logic without loading dashboard usage/history each time.

A persistent worker checks recent pending and failed Flutterwave attempts every
two minutes in batches of 25, covering the last seven days. Reference pagination
rotates through candidates so abandoned attempts cannot starve other payments.
Provider/database failures retry on later runs. Per-process scans do not overlap;
concurrent callbacks/browser/worker checks remain idempotent at the database claim.
Failed attempts are included because a later retry can still succeed. Older records
can still reconcile via their signed webhook or an administrator's manual check.

## Validation

- 71 backend billing/recovery unit tests passed.
- 10 disposable PostgreSQL/HTTP checks passed, including pending → failed → later
  successful recovery without a callback/webhook and no duplicate subscription extension.
- All 360 web unit tests passed.
- All 35 subscription/onboarding/currency browser checks passed, including separate
  windows, blocked pop-ups, returning-window self-close, open-window resume, errors,
  reload recovery and refusal to infer payment success from existing active access.
- Backend/web production builds, TypeScript, targeted lint and diff checks passed.

Provider responses in these automated tests are mocked; no real charge was made.

## Deployment

Deploy backend and web together; no migration is needed. Keep the Flutterwave webhook
configured and run the persistent backend worker with `npm run start:worker` using
the same database and organization Flutterwave credentials as the API. HTTP-only
Vercel instances do not run background recovery; webhooks and an open billing page
still reconcile, but missed webhooks while every browser is closed need that worker.
No actual registration, payment, application-database mutation or deployment was
performed while implementing this fix.

Flutterwave recommends verification and a polling fallback for asynchronous payments:
[Webhook guidance](https://developer.flutterwave.com/docs/webhooks).
