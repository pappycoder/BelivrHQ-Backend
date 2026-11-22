# Flutterwave webhook audit — 21 November 2026

## Conclusion

The user identified Flutterwave Test mode and the `church-os-web.vercel.app` domain. That domain serves the frontend. The standard subscription webhook path on it returns HTTP 404; the matching legacy backend path is reachable and rejects unsigned requests with the expected signature error. This explains delivery failures if the dashboard uses that frontend URL. The exact full dashboard URL and delivery history have not been inspected.

Successful payment verification does not prove webhook delivery. Browser verification and background reconciliation use the same settlement logic independently of inbound webhook receipt.

## Remote checks

These POST requests contained only `{}`, no signature, payment identifier or transaction data. Redirects were disabled.

| URL | Result | Interpretation |
| --- | --- | --- |
| `https://church-os-web.vercel.app/api/v1/billing/webhooks/flutterwave` | 404, HTML | No webhook handler at the frontend path |
| `https://church-os-backend-gamma.vercel.app/api/v1/billing/webhooks/flutterwave` | 401, JSON `Invalid payment signature` | Legacy backend route is reachable and authenticates callbacks |
| `https://api.belivrhq.com/api/v1/billing/webhooks/flutterwave` | 401, JSON `Invalid payment signature` | Primary backend route is also reachable; it is a separate deployment/environment |

A 401 for an unsigned probe is expected, not evidence that Flutterwave's correctly signed deliveries will fail. The initial signed probe was blocked by automatic approval review pending specific authorization. The user subsequently authorized that exact destination and use of the existing webhook hash; the signed result is recorded below.

## Environment distinctions

- Local backend `FLUTTERWAVE_WEBHOOK_SECRET` and `FLUTTERWAVE_SECRET_KEY` are configured. No secret value is included in this report.
- Local backend `WEB_URL` is `https://church-os-web.vercel.app`; it controls browser return URLs, not inbound webhook routing.
- Local backend `PUBLIC_API_URL` is `http://localhost:3001`, appropriate for local development but unreachable by Flutterwave. A dashboard callback must use the intended publicly reachable HTTPS backend.
- No dedicated Flutterwave webhook-URL environment variable is consumed by the current code. The dashboard URL is configured separately. The local `.env` is not proof of a hosted deployment's environment values or the dashboard hash.
- Platform subscriptions use environment credentials. Giving and event tickets use the historical church integration account attached to the original payment, including its own webhook secret. These secrets/settings are not interchangeable.

For this legacy subscription test environment, the subscription endpoint is:

`https://church-os-backend-gamma.vercel.app/api/v1/billing/webhooks/flutterwave`

For church-owned giving/tickets, the corresponding endpoint is:

`https://church-os-backend-gamma.vercel.app/api/v1/integrations/payments/webhook/flutterwave`

Use the endpoint for the merchant/payment purpose being tested; do not redirect a legacy merchant's callbacks to a different environment without reconciling its outstanding payments.

## Implemented event coverage

| Event or condition | Current behavior |
| --- | --- |
| V3 `charge.completed`, including successful/failed/pending payload statuses | Requeries the provider for the original merchant/reference. Provider-verified status, exact amount and currency govern settlement; the callback's success label alone grants no value. |
| Other `charge.*` events | Route through charge verification for a matching payment. Reversed provider results apply reversal logic. |
| Refund `refund.*` events | Match the original transaction separately from the refund ID; maintain per-refund lifecycle facts and cumulative amounts. |
| Unwrapped V3 refund callbacks | Recognize `AmountRefunded`, `TransactionId`, `FlwRef` and update timestamps. |
| Refund `completed` | Kept pending, as V3 defines this as initiated, not disbursed. |
| Refund `completed-bank-transfer`, `completed-momo`, `completed-mpgs`, `completed-offline`, `completed-preauth` | Treated as settled; partial refunds hold affected access for review and full refunds revoke the affected grant. |
| Pending/processing/failed refunds | Do not revoke paid value as a completed refund. |
| `chargeback.*` initiated/pending/declined | Hold affected value for review. Stage/timestamp logic handles reopening and ordering. |
| Chargeback won/reversed | Restore the affected held value subject to other lifecycle facts. |
| Chargeback lost/accepted | Revoke affected value. |
| Duplicate and out-of-order callbacks | Locked settlement and monotonic adjustment merging prevent duplicate periods, tickets and refund accumulation. |
| Unmatched or ambiguous adjustments | Non-200 retryable failure rather than silently discarding a financially relevant adjustment. |
| Other well-formed V3 events, including provider-native subscription/invoice/transfer events | No application lifecycle implementation; ignored/acknowledged rather than used to grant access. BelivrHQ's subscriptions are its own prepaid/manual-renewal ledger. |
| V4 `type`/charge-ID webhook contracts | Not implemented by this V3 integration. Keep the merchant's webhook preferences on V3. |

This is coverage of the application's V3 payment lifecycle, not support for every Flutterwave product or event.

## Authentication and delivery audit

- Nest captures the raw body (`src/main.ts`); the public webhook controllers do not require a browser login or CSRF token.
- Subscription and integration controllers explicitly return HTTP 200 on successful handling. Invalid signatures and processing errors correctly return errors rather than acknowledging unprocessed money.
- V3 `verif-hash` is compared with the separate configured webhook hash. Configured SHA256/base64 raw-body signatures are also supported. The modern signature header is preferred when both headers are present.
- An existing no-webhook-secret SHA512/API-key fallback is not the documented V3 protocol. It does not replace configuring the dashboard hash. The configured-hash path rejects that fallback; regression coverage now checks this explicitly. No production authentication code was changed.
- The web `/api/backend/...` proxy is browser-oriented, checks request origin and does not forward payment signature headers. It is not a supported substitute for a direct backend webhook URL.
- Callbacks currently perform verification and database work before returning 200. This remains a latency/reliability risk during provider/database delays. A durable authenticated inbox with independently retried processing would improve resilience; merely returning 200 before durable capture would risk losing events.
- Reconciliation recovery exists on a two-minute worker schedule. Serverless HTTP instances do not run it; a persistent worker is required. Its actual hosted status was not inspected or changed.

## Validation and remaining verification

Ten relevant Jest suites passed: **330 tests**, including three added regressions for the actual configured V3 hash, exact-raw-body SHA256 signing and rejection of API-key signing when a webhook hash exists. Scoped ESLint passed. Providers and database dependencies in these tests are mocked; this is not an end-to-end delivery certification. No application implementation, deployment, merchant settings, database records or payment state was changed.

Dashboard follow-through still requires the exact Test-mode URL, matching hosted/dashboard secret hash, V3 selection, JSON delivery and retry preferences. V3 refund delivery has its own custom URL setting; chargeback notifications require Flutterwave enablement. Inspect a real failed delivery's status and replay it after correcting configuration. The authorized signed legacy diagnostic is complete, as recorded below. The dashboard hash and provider-originated delivery history have not been inspected.

## Primary references

- [Flutterwave V3 webhooks](https://developer.flutterwave.com/docs/webhooks): requires HTTP 200, treats redirects as failure, describes the 60-second delivery timeout, retries and `verif-hash` authentication.
- [V3 refunds](https://developer.flutterwave.com/docs/payment-operations/refunds): completion states, unwrapped callback fields and separate refund webhook preferences.
- [V3 chargebacks](https://developer.flutterwave.com/docs/payment-operations/chargebacks): lifecycle states and webhook enablement.

## Authorized signed diagnostic result

On 21 November 2026, after explicit user approval, a single HTTPS POST was sent to `https://church-os-backend-gamma.vercel.app/api/v1/billing/webhooks/flutterwave`, using the existing local `FLUTTERWAVE_WEBHOOK_SECRET` as the V3 `verif-hash`. Redirects were prohibited. The body was `{"event":"belivrhq.webhook.audit","data":{}}`, containing no payment reference, transaction ID or financial instructions.

The endpoint returned **HTTP 200**, with **`received: true`**, in **5,707 ms**. This confirms that the legacy subscription endpoint accepts the configured hash and acknowledges a well-formed non-payment event. It does not certify real charge settlement or prove the Flutterwave dashboard has that same URL/hash. No payment or subscription was targeted.

The user confirmed these backend origins:

| Environment | Backend origin |
| --- | --- |
| Legacy | `https://church-os-backend-gamma.vercel.app` |
| Production | `https://api.belivrhq.com` |
| Staging | `https://staging-api.belivrhq.com` |

The subscription webhook path is `/api/v1/billing/webhooks/flutterwave`. The church giving/ticket path is `/api/v1/integrations/payments/webhook/flutterwave`. That first authorization and signed probe applied only to legacy. The subsequently authorized production/staging checks are recorded below.

## Authorized production and staging diagnostics

The user separately authorized signed diagnostics for production and staging using their respective environment hashes. Each hash came from its own section in the private backend `.env.vercel.json`: `production` for production and `preview` for staging, with the recorded `PUBLIC_API_URL` checked against the exact intended origin before transmission. The legacy `.env` hash was not substituted. No secret values were logged.

Each environment received one POST to `/api/v1/billing/webhooks/flutterwave` with V3 `verif-hash` and body `{"event":"belivrhq.webhook.audit","data":{}}`. Redirects were not followed. Results:

| Environment | Origin | HTTP status | Acknowledgement | Duration | Redirect |
| --- | --- | --- | --- | --- | --- |
| Production | `https://api.belivrhq.com` | 200 | `received: true` | 6,380 ms | None |
| Staging | `https://staging-api.belivrhq.com` | 200 | `received: true` | 6,501 ms | None |

Both backend subscription webhook endpoints accept their respective configured hashes and acknowledge the signed diagnostic. No payment identifiers, amounts or financial instructions were sent. These checks do not certify Flutterwave dashboard configuration, actual provider delivery/retries, or financial settlement. Sanitized result metadata is saved in `/tmp/belivrhq-flutterwave-environment-diagnostics-2026-11-21.json`.
