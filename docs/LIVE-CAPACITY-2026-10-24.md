# Live BelivrHQ capacity measurements — 24 October 2026

Target: `https://church-os-web.vercel.app/api/backend`. These measurements describe the current live HTTP path from this test machine, using one authorized account in Grace Community Church. They do not establish an exact deployment-wide maximum or a maximum number of distinct users.

## Findings

- The largest completed error-free burst was **20 simultaneous client requests**. Its p95 response duration was **7.285 seconds**. This is a short burst result, not sustained capacity.
- A burst of **50 simultaneous requests** produced **28 successful responses and 22 timeouts** at the 10-second request deadline (44%). No higher burst was attempted.
- At **1 offered request/second for 30 seconds**, all 31 boundary-inclusive requests succeeded; p95 was **2.313 seconds**.
- At **2 offered requests/second**, the safety stop ended the test early: **17 successful responses, 2 timeouts and 18 in-flight requests cancelled**. Higher sustained levels (4 and 8 requests/second) were not attempted.
- The longer **1 request/second, 120-second confirmation** completed without errors: 121 completed requests, p95 **2.369 seconds**, error rate **0.00%**, 0 requests cancelled.

## Every live load level

Percentiles below are k6 HTTP response durations in seconds. p95 means 95% of completed samples had a duration at or below that value. Timeout samples are capped by the client deadline; cancelled requests have no completed response sample. Small bursts have too few samples for reliable population tail estimates. A safety pass means the run completed within the deliberately permissive 10-second ceiling with no errors; it does not mean the latency is suitable for users.

| Run | Offered level | Scheduled seconds | Completed / started | Peak client requests in flight | Successful completions/s | p50 s | p95 s | p99 s | Timeouts | Cancelled | Result |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| bursts | 1 burst requests | 30 | 1 / 1 | 1 | 0.464 | 1.850 | 1.850 | 1.850 | 0 | 0 | Completed |
| bursts | 5 burst requests | 30 | 5 / 5 | 5 | 0.723 | 2.862 | 6.019 | 6.470 | 0 | 0 | Completed |
| bursts | 10 burst requests | 30 | 10 / 10 | 10 | 1.833 | 4.099 | 4.880 | 4.986 | 0 | 0 | Completed |
| bursts | 20 burst requests | 30 | 20 / 20 | 20 | 2.540 | 6.171 | 7.285 | 7.414 | 0 | 0 | Completed |
| bursts | 50 burst requests | 30 | 50 / 50 | 50 | 2.797 | 8.714 | 9.522 | 9.610 | 22 | 0 | Stopped / failed |
| rates | 1 requests/s | 30 | 31 / 31 | 3 | 0.967 | 2.079 | 2.313 | 2.338 | 0 | 0 | Completed |
| rates | 2 requests/s | 30 | 19 / 37 | 20 | — | 5.351 | 9.637 | 9.697 | 2 | 18 | Stopped / failed |
| confirmation | 1 requests/s | 120 | 121 / 121 | 4 | 0.993 | 2.046 | 2.369 | 2.494 | 0 | 0 | Completed |

Burst throughput is an average over the burst completion span; it must not be interpreted as a sustainable requests/second limit. The 30-second field for bursts is a maximum duration, not their actual duration. Actual burst spans were 2.156, 6.912, 5.455, 7.875 and 10.010 seconds respectively. The failed 2-request/second run stopped around 18 seconds into its scheduled 30 seconds; its rate is omitted because it was aborted with outstanding work.

The first exploratory one-user, 15-second run (before adopting the user-requested all-level latency reporting) completed 6 requests without errors: p50 1.823 s, p95 1.980 s, p99 1.982 s. It failed the original 1-second p95 target. Its old raw k6 rate included setup and is not reported as throughput.

## Request outcomes by endpoint

All measured live workloads used member, visitor, service and giving transaction lists plus the 2026 NGN financial report. No response content, personal data, account identifiers, receipt values or giving amounts are included in this report.

| Run / level | Endpoint | HTTP 200 | Client timeout |
| --- | --- | ---: | ---: |
| bursts / 1 | `/visitors` | 1 | 0 |
| bursts / 5 | `/giving/transactions` | 1 | 0 |
| bursts / 5 | `/members` | 1 | 0 |
| bursts / 5 | `/reports/financial` | 1 | 0 |
| bursts / 5 | `/services` | 1 | 0 |
| bursts / 5 | `/visitors` | 1 | 0 |
| bursts / 10 | `/giving/transactions` | 2 | 0 |
| bursts / 10 | `/members` | 2 | 0 |
| bursts / 10 | `/reports/financial` | 2 | 0 |
| bursts / 10 | `/services` | 2 | 0 |
| bursts / 10 | `/visitors` | 2 | 0 |
| bursts / 20 | `/giving/transactions` | 4 | 0 |
| bursts / 20 | `/members` | 4 | 0 |
| bursts / 20 | `/reports/financial` | 4 | 0 |
| bursts / 20 | `/services` | 4 | 0 |
| bursts / 20 | `/visitors` | 4 | 0 |
| bursts / 50 | `/giving/transactions` | 2 | 8 |
| bursts / 50 | `/members` | 6 | 4 |
| bursts / 50 | `/reports/financial` | 6 | 4 |
| bursts / 50 | `/services` | 8 | 2 |
| bursts / 50 | `/visitors` | 6 | 4 |
| rates / 1 | `/giving/transactions` | 6 | 0 |
| rates / 1 | `/members` | 6 | 0 |
| rates / 1 | `/reports/financial` | 6 | 0 |
| rates / 1 | `/services` | 6 | 0 |
| rates / 1 | `/visitors` | 7 | 0 |
| rates / 2 | `/giving/transactions` | 2 | 2 |
| rates / 2 | `/members` | 2 | 0 |
| rates / 2 | `/reports/financial` | 4 | 0 |
| rates / 2 | `/services` | 4 | 0 |
| rates / 2 | `/visitors` | 5 | 0 |
| confirmation / 1 | `/giving/transactions` | 25 | 0 |
| confirmation / 1 | `/members` | 25 | 0 |
| confirmation / 1 | `/reports/financial` | 24 | 0 |
| confirmation / 1 | `/services` | 23 | 0 |
| confirmation / 1 | `/visitors` | 24 | 0 |

## Method and interpretation

- Normal sign-in and the existing web session cookie were used. Authentication, plan/permission checks, tenant/branch scope and rate limits remained enabled. The generator sent read-only GETs, with no live fixture seeding, attendance/giving writes, invitations, emails, AI requests or payments. The normal sign-in itself creates the usual authentication session.
- One authorized account was available. Multiple request workers share that identity. **Distinct-user capacity remains unmeasured**: 20 concurrent requests are not 20 separate users, and the 1-request/second result cannot be converted into a user count without a measured user journey and authorized distinct sessions.
- The live church had only **3 members, 2 visitors, 2 services and 3 giving transactions** visible to the test account. Large-church query costs, exports, writes, browser rendering and mixed background jobs remain unmeasured.
- Each stage preflight checked the five routes sequentially before measurement. Preflight counts and response durations are excluded from the capacity metrics. Setup can warm caches/functions, so these are not a controlled cold-start benchmark. Requests rotate the workload; actual endpoint counts are recorded above.
- Fixed-rate tests schedule one GET per iteration independently of response time. Sustained throughput is completed requests divided by the scenario span, including trailing responses, excluding setup. k6 can schedule one request on the duration boundary. No dropped iterations, HTTP 429, HTTP 401/403 or HTTP 5xx were observed in the measured stages. Timeouts and cancelled work are the failure observed here.
- Errors above 1% trigger an early stop after the first 15 seconds; any failing stage ends escalation. Individual requests time out at 10 seconds. p95 and p99 ceilings were both 10 seconds to honor the request to report every level, not to impose an arbitrary 1-second performance target.
- Concurrency is counted from client request start/finish trace events. It includes requests waiting for network/proxy/backend work. It is not a measurement of backend handlers, PostgreSQL queries, Vercel instances or distinct users. Cancelled requests are those started without a recorded finish when k6 aborts.
- k6 response-duration percentiles exclude initial connection establishment/TLS time. The scenario span includes that work. Network quality and the load generator can influence end-to-end results; the observed failures cannot be attributed solely to database, Vercel or application code without correlated server telemetry.
- Hosting quotas, deployed function sizing/regions, database tier and server-side saturation telemetry were unavailable. Source configuration alone does not establish the production values. The account route policy is 100 requests/minute per identity and route; no guard was weakened or bypassed. No global physical capacity claim can be made from a single-account run.

## Evidence and repeatability

Sanitized machine-readable aggregates: [LIVE-CAPACITY-2026-10-24.json](LIVE-CAPACITY-2026-10-24.json). Reproduction and modes: [test/load/README.md](../test/load/README.md). Private raw k6 summaries, logs and token-free timing traces remain under ignored `test/load/results/`. Credentials and session tokens are excluded from Git. The generated live session file is removed after the run; the user-managed private credential file is retained.

The separate local fixture baseline is documented in [LOCAL-CAPACITY-2026-10-24.md](LOCAL-CAPACITY-2026-10-24.md). Its much higher throughput excludes production auth, guards, Redis, proxy and remote infrastructure and **must not be presented as live capacity**.

k6 executor behavior: [constant arrival rate](https://grafana.com/docs/k6/latest/using-k6/scenarios/executors/constant-arrival-rate/), [dropped iterations](https://grafana.com/docs/k6/latest/using-k6/scenarios/concepts/dropped-iterations/), [thresholds and early stops](https://grafana.com/docs/k6/latest/using-k6/thresholds/).
