# Persistent worker operation

The Vercel API produces jobs. It does not run persistent BullMQ consumers. Supabase supplies database/Auth/storage services and is not the deployed consumer for these queues. As of 2026-11-16 the operator confirmed that no persistent worker is deployed.

## Run one worker per environment first

Use a supervised, always-running Node process or container with outbound access to that environment's PostgreSQL and Redis services. A request-triggered function, sleeping web service or one-off scheduled command is not an equivalent worker host. Hosting selection and deployment access are still required before a live rollout.

Build with `npm ci` and `npm run build`; launch with `npm run start:worker`. The process enables queue consumers itself, validates runtime settings and initializes the same telemetry privacy rules as the API. Do not enable queue workers on Vercel HTTP instances. The host must restart failed processes and allow at least 25 seconds for termination; shutdown has a 25-second hard bound.

For containers, build `docker build --target worker -t belivrhq-worker .`. Run that image with runtime secrets supplied by the host, for example `docker run --restart unless-stopped --env-file /secure/worker.production.env belivrhq-worker`. The private file must be a dotenv file prepared from the correct target values, not the JSON configuration itself. Never bake credentials into the image or pass them as command arguments. The default Docker target remains the API.

## Required configuration

Match the API target's `DATABASE_URL`, `REDIS_URL`, `UPSTASH_REDIS_TOKEN`, `QUEUE_REDIS_URL`, `REDIS_NAMESPACE`, application current/retained encryption and signing keys, Supabase settings and enabled provider credentials. Use `NODE_ENV=production` for both hosted targets and set `VERCEL_ENV=preview` or `production` explicitly, including on hosts outside Vercel. Preview must use its own database/Redis target and namespace. Set a small persistent `DB_POOL_MAX` initially, such as 2, then measure pool waits.

`QUEUE_REDIS_URL` must be the TCP/TLS Redis URI. The HTTPS cache endpoint is not a BullMQ transport. An API and worker with different namespaces will not share jobs or readiness. Empty values from sensitive pulls must be deliberately populated before preparing runtime configuration; they are not recoverable credentials.

Start with one replica. Nightly dispatch uses stable church/date job IDs; company-email recovery uses persisted leases; payment reconciliation relies on domain idempotency and locks. More replicas require concurrency tests for all scheduled workflows and must not be assumed to provide exactly-once external effects.

## Readiness and monitoring

- `/api/v1/health/live`: HTTP 200 while the HTTP process responds, without dependency calls. Use this for container/process liveness to avoid restart loops during a database or worker outage.
- `/api/v1/health/ready` and the existing `/api/v1/health`: HTTP 200 only when database/cache/queue checks and all required worker capabilities are ready; otherwise HTTP 503. The original response fields remain, with worker status and sanitized check latency/reasons added. Consumers must accept the corrected non-200 failure status.
- Worker leases renew every 20 seconds and expire after 90 seconds. Renewal requires an enabled, running, unpaused consumer and a successful read on its actual queue connection. An API producer cannot satisfy this check. Shutdown stops renewals; expiry avoids deleting a lease recently written by another worker.
- Dependency probes run concurrently under three-second deadlines. Requests share outstanding probes so a hung operation cannot create unlimited pending checks. A probe stays unavailable until its underlying operation settles; restart an instance if a broken transport never settles.

Configure external monitoring for readiness failures, worker lease expiry and growing waiting/failed/backlog age. Alert destination and ownership are still required. A live process, Redis PING or empty queue is not evidence that a real job completed. Worker containers have no HTTP listener; their supervisor monitors process exit and the API exposes fleet readiness.

## Staging rollout and controlled verification

1. Complete migrations and deploy compatible worker/API code together; do not promote this API readiness change to production while no worker exists.
2. Supply staging-only runtime values and start the supervised worker.
3. Verify all eight queue capabilities become ready and that wrong-environment workers cannot satisfy readiness.
4. Exercise an explicitly chosen sandbox job without real customer messages, charges or production data. Verify persisted completion, not just queue acceptance.
5. Pause/stop the worker and verify capability expiry and HTTP 503; confirm liveness remains HTTP 200. Restart and verify recovery.
6. Validate crash recovery, safe retries and alerts before scheduling a production cutover. Review already waiting jobs before connecting a production consumer: starting it can immediately execute historical work.

Do not auto-replay payment jobs or clear Redis as part of bring-up. Provider-issued credentials and lost encryption keys require their existing recovery processes. A database restore, provider sandbox test or worker launch must use an explicit target and cannot be inferred from a successful API build.
