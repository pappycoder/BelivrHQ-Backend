# BelivrHQ capacity tests

These tests distinguish active users, in-flight requests, and offered requests/second. A result is a measurement for one deployment, workload, fixture size, and duration, not a universal maximum for BelivrHQ.

## Local service/database baseline

Requirements: Node 22, installed backend dependencies, k6, and a migrated **local disposable** PostgreSQL database whose name contains `test`. The server refuses remote databases and binds only to loopback. It does not load `.env`. It creates fictional tenant-owned records and deletes only those records on SIGINT/SIGTERM. Do not use a database with application data.

```sh
TEST_DATABASE_URL=postgresql://USER@127.0.0.1:55439/belivrhq_capacity_test DB_POOL_MAX=10 node test/load/local-server.cjs
```

Run in another terminal:

```sh
node test/load/run.mjs --mode=users --levels=10,50,100,200,400,800 --seconds=60 --local-metrics=true
node test/load/run.mjs --mode=rps --levels=10,50,100,200,400,800 --seconds=60 --local-metrics=true
node test/load/run.mjs --mode=users --think=0 --levels=10,25,50,100,200 --seconds=60 --local-metrics=true
```

The first command uses one sequential API request followed by a one-second pause per virtual user. It does **not** represent one browser rendering complete pages every second. The second schedules one request per iteration at a fixed arrival rate, independent of response time. The third removes pauses to measure concurrent in-flight handlers and expose queueing. `--mode=requests` is the explicit no-pause worker mode. `--mode=burst` sends exactly one request per virtual user, allowing a bounded concurrency burst. Do not run generators simultaneously against the same baseline. The load generator, Node process and database share this machine, so CPU/network contention can constrain the measurement.

The baseline invokes the actual MembersService, VisitorsService, AttendanceService and ReportsService, Prisma adapter/query instrumentation, real PostgreSQL, tenant scope and JSON/compression/Helmet over HTTP. Its **test-only** HTTP handlers and session map deliberately exclude production controllers/DTO pipes, Supabase JWT verification, permission/plan guards, Redis, rate limiting, Next.js proxy/browser, provider calls, database network latency, Vercel cold starts/autoscaling and scheduled workers. It must never be deployed or exposed externally. Production capacity cannot be inferred by multiplying these figures by Vercel instances or CPU count.

Fixtures default to 10 churches, 10,000 members, 2,000 visitors, 10,000 giving transactions and 30 services. Tenant data is spread evenly. Read-only request mix is equal shares of member listing, member search, visitor listing, service listing and financial reports. Page sizes are 20. `--workload=lists` omits financial reports for an explicitly separate workload. Fixtures do not benchmark attendance writes, payment reconciliation, member imports, PDF/Excel exports, AI, email delivery, media upload or frontend rendering.

## Real deployment test

Use an isolated staging deployment matching production, with authorized test-account sessions and representative data. A session file is a private JSON array of `{ "token": "ACCESS_TOKEN", "churchId": "TENANT_UUID" }`; keep it outside Git and use mode 0600. The generator never signs users in, refreshes tokens, modifies data or calls paid providers. The separate `prepare-live-session.mjs` helper performs a normal login using the ignored `.env.load-test`, verifies the designated church and writes a private session file; it stops when MFA is required. Never commit that credentials file or session file. Account tokens must remain valid throughout the run and be authorized for **all** workload routes. Up to 10 evenly sampled sessions receive a sequential preflight before each level. Other invalid sessions fail the measured run; failure responses cannot count as success.

```sh
node test/load/run.mjs --target=https://STAGING_API/api/v1 --allow-remote=STAGING_API --sessions=/PRIVATE/test.sessions.json --mode=users --levels=1,5,10,25,50 --seconds=60
node test/load/run.mjs --target=https://STAGING_API/api/v1 --allow-remote=STAGING_API --sessions=/PRIVATE/test.sessions.json --mode=rps --levels=5,10,25,50,100 --seconds=60
```

Target the API directly for backend numbers; use the authenticated web proxy base `https://WEB/api/backend` for a separately labeled test of that HTTP path. For the BelivrHQ web proxy, sessions require `transport: "web-cookie"`; the generator supplies the normal session cookie and trusted web headers. `--workload=live-read` rotates member, visitor, service, giving lists and financial reports. It permits genuinely empty collections/reports, while malformed bodies still fail. Browser rendering needs a separate browser test. Remote `users` mode requires a distinct authorized identity per VU; `requests` and `burst` can reuse one account and must be reported as request concurrency, never distinct users. Never send production tokens to a local baseline. Remote runs require HTTPS and an explicitly matching hostname. The flag is an execution guard, not evidence of permission to stress a service.

The current API default rate limit is 100/minute per identity and route, authentication 10/minute, sensitive operations 5/minute. Avoid benchmarking many VUs on one identity or one IP: 429 results describe throttling, not saturation. Keep the normal guards enabled for an end-to-end user test. Any separate staging test with modified guards needs that difference recorded. Do not weaken production guards for a benchmark.

## Pass criteria and interpretation

A level passes only if k6 exits successfully, application error rate is <1%, successful data checks are >99%, p95 HTTP response duration is below `--p95-ms` (default 1000), p99 is below `--p99-ms` (default 2000), no auth failures or 429s occur, and (arrival-rate mode) no iterations are dropped. A 200 with `success:false`, missing data, empty/malformed result rows, an empty/malformed NGN report, redirect, timeout or invalid JSON fails the application check. Staging fixtures must populate every list, include names matching the member-search term `Member` beyond page one, and have giving data in the 2026 report window. Responses are not discarded. The runner stops increasing load after the first failing level and returns a nonzero exit status. Error thresholds abort early after 15 seconds; a watchdog ends a stuck process after scheduled duration +45 seconds. Interrupting the runner signals its child generator. Request timeout is 10 seconds.

Preflight requests are excluded from tagged capacity counts and latency. Throughput uses a custom scenario clock, excluding setup and including responses finishing during graceful stop; it can differ from offered rate. Burst throughput is total completed requests divided by burst span, not a sustained rate. `rawK6RateIncludingSetup` is retained for transparency and must not be labeled scenario throughput. Older local results without the custom clock use the raw k6 rate and are labeled accordingly. `--trace-events=true` records request start/finish events and derives peak client HTTP requests in flight; this is not server-handler telemetry. Server telemetry includes preflight activity and is labeled separately. k6 checks alone do not cause failure: thresholds make them binding. Arrival-rate allocation is bounded (default max(50, 2 × offered rate)); if requests are dropped, increase allocation and rerun to distinguish generator exhaustion from server saturation. Do not call a dropped-iteration run a measured server maximum.

Report each passing/failing tested level, duration, throughput, p50/p95/p99, errors, 429s, unsent iterations and resource telemetry. `peakActiveRequests` is simultaneous handlers observed inside the local HTTP application, not open sockets, VUs, browser tabs, or Vercel instances. `cpuPercentOfOneCore` can exceed 100% because Node can use helper threads. Event-loop telemetry uses 20 ms resolution, so a normal idle p95 is near 20 ms. RSS includes startup/ts-node overhead; no local memory figure is a production function-size recommendation.

Repeat the last passing and first failing levels; run a longer steady confirmation and a low-load recovery test. If all levels pass, the result is a lower bound. If a level fails, the last passing and first failing levels only bracket an SLO boundary under this workload; they do not prove an exact absolute capacity.

Raw summaries, generator logs, server telemetry, fixture metadata and sessions are written to ignored `test/load/results/`. Do not commit tokens. Commit only sanitized aggregate evidence/report files under `docs/`. Tests: `node --test test/load/config.test.mjs`.

## Authorized live run example

Only run this against an environment whose owner authorized the load. Start low, preserve normal guards, and stop when errors, throttling or timeouts occur. A 10-second ceiling below is a stress safety limit, not a suggested user-experience target.

```sh
node test/load/prepare-live-session.mjs
node test/load/run.mjs --target=https://church-os-web.vercel.app/api/backend --allow-remote=belivrhq-web.vercel.app --sessions=test/load/results/live.sessions.json --workload=live-read --mode=burst --levels=1,5,10,20,50 --seconds=30 --p95-ms=10000 --p99-ms=10000 --trace-events=true
```

Allow the rate-limit window and response latency to recover before sustained follow-up runs. Remove the generated private live session file after testing; do not globally log out the account or delete the user-managed credentials file. Local interrupted cleanup can be retried with the same test-only database and `local-server.cjs --cleanup-run=FIXTURE_UUID`; the helper only deletes churches carrying that exact capacity-test prefix.

Read-only diagnostics after preparing a normal private live session: `node test/load/diagnose-live.mjs` collects twelve sequential web/API samples and Server-Timing without response content; `node test/load/diagnose-dependencies.mjs` checks the local `.env` database configuration in a read-only transaction, with five SELECT round trips and a scoped EXPLAIN. Dependency checks originate from the test machine and do not establish deployed function settings. Local Redis is explicitly reported as unmeasured for production. See `docs/PERFORMANCE-INVESTIGATION-2026-10-24.md` for findings and proposed changes.
