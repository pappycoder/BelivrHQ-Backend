# Live BelivrHQ retest — 24 October 2026

The updated backend is confirmed live by its new `Server-Timing` fields (`db_queries`, `pool_waiting`, `profile`, `permissions`, `entitlements`, `revocation`, `session` and others). This is a fresh measurement of the current deployment, not the previous local microbenchmark. The timing fields confirm the new code path; they do not independently verify a build SHA or the deployed pool setting.

The same designated Grace Community Church account, web proxy, five-route read-only workload, 10-second request deadline and safety thresholds were used as in the [original live measurement](LIVE-CAPACITY-2026-10-24.md). Normal auth/MFA, plans, permissions and rate limits remained enabled. The load generator was not run simultaneously in multiple modes.

## Findings

- **50 simultaneous requests:** all 50 succeeded; previously 22 of 50 timed out. Current p95 was **8.275 seconds**. Fifty is the largest burst tested, not an established maximum.
- **20 simultaneous requests:** p95 fell from **7.285 to 5.750 seconds**. The 10-request batch was slower than before, showing that these small-batch timings vary.
- **1 offered request/second for two minutes:** all **120** requests succeeded, measured successful throughput **0.995 requests/second**, p50 **1.925 s**, p95 **2.241 s**, p99 **2.500 s**. Previous two-minute p95 was **2.369 s**. The 120-versus-121 request count reflects scheduler boundary timing, not lost work.
- **2 offered requests/second for 30 seconds:** all **60** succeeded, but p95 was **7.586 s**, and trailing responses extended the measured span to **35.031 s**. Completed throughput over that span was **1.713 requests/second**.
- **2 offered requests/second, scheduled for two minutes:** stopped after roughly **38 seconds**, with **60 successful responses, 1 timeout and 15 in-flight requests cancelled**. Its p95 was **8.626 s** among completed attempts. The short pass did not establish sustained capacity.
- **4 offered requests/second:** stopped after roughly **12 seconds**, with **10 successful responses, 1 timeout and 38 in-flight requests cancelled**. Eight requests/second was not attempted. No measured stage returned a 429, 401/403 or 5xx response, and no iterations were dropped.

The highest error-free two-minute sustained rate verified here therefore remains **1 request/second**, while short-burst reliability improved. These are observations for one account and this workload, not an exact global limit or a count of concurrent users. The intervals above for aborted stages are approximate: the timing metric records the last completed response, while the stop can occur just afterward.

## Every repeated load level

p50/p95/p99 below are k6 HTTP response durations in seconds. Burst samples are small, so these describe only the observed batch. They include client timeouts where emitted; cancelled requests do not have completed response samples. A safety pass uses a permissive 10-second ceiling and does not establish acceptable user experience.

| Test | Level | Scheduled seconds | Completed / started | Peak client in flight | p50 s | p95 s | p99 s | HTTP 200 | Timeouts | 429 | Cancelled | Successful completions/s | Result |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| bursts | 1 burst requests | 30 | 1 / 1 | 1 | 1.637 | 1.637 | 1.637 | 1 | 0 | 0 | 0 | 0.519 | Complete |
| bursts | 5 burst requests | 30 | 5 / 5 | 5 | 3.573 | 3.895 | 3.937 | 5 | 0 | 0 | 0 | 1.164 | Complete |
| bursts | 10 burst requests | 30 | 10 / 10 | 10 | 4.653 | 6.509 | 6.602 | 10 | 0 | 0 | 0 | 1.443 | Complete |
| bursts | 20 burst requests | 30 | 20 / 20 | 20 | 3.274 | 5.750 | 6.319 | 20 | 0 | 0 | 0 | 2.927 | Complete |
| bursts | 50 burst requests | 30 | 50 / 50 | 50 | 4.759 | 8.275 | 9.032 | 50 | 0 | 0 | 0 | 5.254 | Complete |
| rates | 1 requests/s | 30 | 30 / 30 | 3 | 1.879 | 2.155 | 2.169 | 30 | 0 | 0 | 0 | 0.960 | Complete |
| rates | 2 requests/s | 30 | 60 / 60 | 16 | 5.297 | 7.586 | 8.514 | 60 | 0 | 0 | 0 | 1.713 | Complete |
| rates | 4 requests/s | 30 | 11 / 49 | 38 | 5.939 | 8.833 | 9.519 | 10 | 1 | 0 | 38 | — | Stopped / failed |
| confirmation | 2 requests/s | 120 | 61 / 76 | 19 | 5.371 | 8.626 | 9.910 | 60 | 1 | 0 | 15 | — | Stopped / failed |
| recovery | 1 requests/s | 120 | 120 / 120 | 4 | 1.925 | 2.241 | 2.500 | 120 | 0 | 0 | 0 | 0.995 | Complete |

Burst throughput is completed work divided by the burst span, not a sustained rate. The 30-second burst setting is a maximum, not the actual duration. Arrival-rate throughput includes trailing completed responses but excludes preflight/setup. Aborted runs have their throughput omitted because outstanding work was cancelled. Detailed actual spans, status counts, route outcomes and setup-inclusive raw rates are retained in the aggregate JSON.

## Before versus now

| Matched test | Previous p95 s | Current p95 s | Previous timeouts | Current timeouts |
| --- | ---: | ---: | ---: | ---: |
| bursts / 1 | 1.850 | 1.637 | 0 | 0 |
| bursts / 5 | 6.019 | 3.895 | 0 | 0 |
| bursts / 10 | 4.880 | 6.509 | 0 | 0 |
| bursts / 20 | 7.285 | 5.750 | 0 | 0 |
| bursts / 50 | 9.522 | 8.275 | 22 | 0 |
| rates / 1 | 2.313 | 2.155 | 0 | 0 |
| rates / 2 | 9.637 | 7.586 | 2 | 0 |
| recovery / 1 | 2.369 | 2.241 | 0 | 0 |

## Sequential live route checks

Two sequential observations per route were collected before the load test. This is too small a sample to establish a stable percentage gain; cold starts, network/provider conditions and normal activity can differ between runs. These wall times also include connection establishment, unlike k6 HTTP-duration percentiles.

| Route | Previous median ms (n=2) | Current median ms (n=2) | Change |
| --- | ---: | ---: | ---: |
| `/api/backend/giving/transactions` | 2005 | 1939 | -3.3% |
| `/api/backend/members` | 1822 | 1598 | -12.3% |
| `/api/backend/reports/financial` | 2108 | 1975 | -6.3% |
| `/api/backend/services` | 1831 | 1595 | -12.9% |
| `/api/backend/visitors` | 1802 | 1675 | -7.1% |
| `/api/session` | 527 | 627 | +19.1% |

## What the new live timing reveals

On the repeated sequential checks, permission resolution took roughly 224–241 ms, rate limiting 228–237 ms and revocation checking 227–242 ms. These are separate, sequential stages on the current path, totaling roughly 0.68–0.72 seconds before business queries. The cached financial-report path also spent about 452 ms reading the response-cache version and entry. These figures identify remote-cache-related stages worth investigating; they do not isolate Redis server execution time or prove a region mismatch.

Profile hydration took about 281–307 ms and session approval about 71 ms. Plan-guard entitlement resolution reported 0 ms rounded on all sampled routes, consistent with removing the repeated subscription lookup. JWT verification was only 1–2 ms on these warmed samples. Report cache hits still pay the profile/permission/rate/session checks.

The sample for a cached financial report returned five driver calls; member/service lists had seven, visitors nine, and giving twelve. Sampled pool waiting high-water values were 2–5 even on sequential route checks, consistent with internal query fan-out competing for connections. These samples are not continuous peak queue counts and do not reveal the configured pool maximum. Database driver totals can overlap and exceed wall time; do not sum or subtract them as disjoint stages.

## Scope, safety and evidence

Only one authenticated identity was used. This still does not establish a distinct concurrent-user ceiling, multi-church capacity or capacity for large datasets, writes, imports, exports, AI, emails or payments. The baseline church was tiny, and observed response byte counts match the earlier diagnostic checks. The workload was member, visitor, service and giving lists plus the 2026 NGN financial report. No live business records, hosting settings, provider configurations or rate limits were changed. Normal test-account sign-in created its usual session.

Escalation ends on the first failed level; no higher level in that series is run. A 10-second client timeout is a test deadline, not proof that the backend would never finish later. Early aborts cancel outstanding client work; cancellation may not instantly stop upstream database operations. Recovery pauses and a lower-rate repeat separate stress from confirmation. The generated private session file is removed at the end; the private user-managed credentials file is retained.

Sanitized evidence: [LIVE-CAPACITY-RETEST-2026-10-24.json](LIVE-CAPACITY-RETEST-2026-10-24.json). Private raw logs and timing traces remain under ignored `test/load/results/live-retest-*`. The original report and evidence are preserved.
