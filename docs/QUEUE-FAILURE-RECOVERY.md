# Queue failure review and webhook recovery

## Failure records

Persistent workers record terminal BullMQ failures into `dead-letter` under a stable ID derived from the source queue, job ID and attempt count. A bounded rotating scan of retained failed jobs recovers events missed during a worker crash. Active/waiting/delayed jobs are not treated as exhausted. The dead-letter worker never executes the original operation; it emits a sanitized Sentry notification and retains review metadata for up to 30 days or 10,000 records.

New failure records contain identifiers, attempt counts, time and a fixed reason. They do not copy message bodies, addresses, provider errors, tokens or credentials. Legacy records are not serialized into operator logs. Original failed jobs can still contain their historical payloads in Redis and follow their original retention; restrict Redis access accordingly.

Use `npm run queues:failures -- production` or `npm run queues:failures -- preview` to inspect up to 50 sanitized records from the corresponding private deployment JSON. Pass an offset as the second argument for the next page. This command does not bootstrap consumers, change env values, replay jobs or create queue metadata. An unavailable Redis connection fails without printing connection values. Confirm the target before inspecting records.

Sentry receives sanitized terminal-failure notifications and rate-limited consumer-connection alerts. A configured exporter does not prove someone receives alerts: assign an owner and verify the dashboard's alert routing before rollout. Failed-job and backlog thresholds still need operational agreement.

## Reviewed webhook retry

`POST /api/v1/webhooks/deliveries/:deliveryId/retry` accepts only a `reason` string of 10 to 500 trimmed characters. Normal JWT/session, `webhooks:update`, plan and sensitive-route rate-limit checks apply. The service independently requires an active, non-archived super-admin profile in the delivery's church. Other tenants' deliveries are not disclosed.

The database locks the delivery and subscription, checks failed status and current endpoint/plan eligibility, rejects an in-progress native queue job, increments the dispatch generation and writes the operator's audit record in one transaction. Only then is dispatch attempted. A repeated or competing review cannot start another generation while the delivery is pending/successful. If Redis is unavailable, persisted pending intent remains recoverable.

The response identifies the delivery, generation and whether immediate enqueueing was confirmed. It does not claim the external receiver processed the request. The existing HMAC body contract is preserved; `X-Webhook-Delivery-Id` stays stable across attempts and reviewed generations so receivers can deduplicate side effects. Delivery is at-least-once: an acknowledgement loss can follow a successful external operation. Inspect the receiver/provider before requesting another attempt.

Old generation jobs cannot send or overwrite the state of a newer reviewed generation. No generic payment, recurring-charge, SMS, WhatsApp, email or broadcast replay endpoint is added. Those records are review-only here and require the domain's reconciliation or explicitly reviewed feature workflow. Never retry a financial job merely because its Redis status says failed.

## Durable event intent

Apply `20261116110000_durable_webhook_delivery` and then `20261116120000_reviewed_webhook_retry` before running this worker release. The first migration creates transactional delivery intent for `member.created` and first transitions to `transaction.completed`; replaying an unchanged successful status does not emit another event. Payloads contain entity identifiers and minimal event facts, not entire member records. Disabled/archived/other-tenant subscriptions are excluded. There is no historical event backfill.

Pending delivery rows are recovered in bounded batches every 30 seconds by a worker. `next_retry_at` is a two-minute dispatch lease, followed by a five-minute inspection interval after confirmed queue acceptance. Stable job identities cover duplicate scans and ambiguous Redis responses; exhausted jobs require review. Credentials and business payloads are read from persisted records at processing time rather than copied into new Redis jobs.

The second migration adds a nonnegative dispatch generation. Deploy the compatible worker before enabling identifier-only producers. This worker accepts legacy generation-zero jobs. An older worker cannot process the new identifier-only protocol; do not roll consumers back to pre-release code while such jobs remain. Keep a compatible worker during an API-only rollback. Do not reverse migrations or replay historical events automatically.

Before first production worker activation, inspect already pending and failed work. Starting a consumer can immediately execute old accepted operations. Use staging fixtures/sandbox receivers for fault-injection checks and confirm audit, tenant isolation, retries, transport failure and operator denial behavior before connecting production consumers.
