import http from 'k6/http';
import { check, sleep } from 'k6';
import exec from 'k6/execution';
import { Rate, Counter, Trend } from 'k6/metrics';
import {
  READ_PATHS,
  LIVE_READ_PATHS,
  positiveInteger,
  validateTarget,
  validPayload,
} from './config.mjs';

const target = validateTarget(__ENV.TARGET, __ENV.ALLOW_REMOTE || '');
const mode = __ENV.MODE || 'users';
if (!['users', 'rps', 'requests', 'burst'].includes(mode))
  throw new Error('MODE must be users, requests, burst or rps');
const level = positiveInteger(__ENV.LEVEL || 1, 'LEVEL');
const duration = `${positiveInteger(__ENV.DURATION_SECONDS || 60, 'DURATION_SECONDS', 3600)}s`;
const thinkSeconds = Number(__ENV.THINK_SECONDS || 1);
if (!Number.isFinite(thinkSeconds) || thinkSeconds < 0 || thinkSeconds > 60)
  throw new Error('Invalid think time');
const sessions = JSON.parse(open(__ENV.SESSIONS_FILE));
if (
  !Array.isArray(sessions) ||
  !sessions.length ||
  sessions.some((s) => typeof s.token !== 'string' || !s.token)
)
  throw new Error('Provide test-account sessions in SESSIONS_FILE');
const allocation = positiveInteger(__ENV.ALLOCATION || Math.max(50, level * 2), 'ALLOCATION');
const errors = new Rate('request_errors');
const limited = new Counter('rate_limited');
const serverErrors = new Counter('server_errors');
const authErrors = new Counter('auth_errors');
const elapsed = new Trend('measurement_window_ms');
const started = new Counter('capacity_request_started');
const finished = new Counter('capacity_request_finished');
const p95 = positiveInteger(__ENV.P95_MS || 1000, 'P95_MS', 60000);
const p99 = positiveInteger(__ENV.P99_MS || 2000, 'P99_MS', 60000);
const paths =
  __ENV.WORKLOAD === 'live-read'
    ? LIVE_READ_PATHS
    : __ENV.WORKLOAD === 'lists'
      ? READ_PATHS.slice(0, 4)
      : READ_PATHS;
export const options = {
  scenarios: {
    capacity:
      mode === 'burst'
        ? {
            executor: 'per-vu-iterations',
            vus: level,
            iterations: 1,
            maxDuration: duration,
            gracefulStop: '10s',
          }
        : mode !== 'rps'
          ? { executor: 'constant-vus', vus: level, duration, gracefulStop: '10s' }
          : {
              executor: 'constant-arrival-rate',
              rate: level,
              timeUnit: '1s',
              duration,
              preAllocatedVUs: allocation,
              maxVUs: allocation,
              gracefulStop: '10s',
            },
  },
  thresholds: {
    request_errors: [{ threshold: 'rate<0.01', abortOnFail: true, delayAbortEval: '15s' }],
    'http_req_duration{scenario:capacity}': [`p(95)<${p95}`, `p(99)<${p99}`],
    'http_reqs{scenario:capacity}': ['count>0'],
    checks: ['rate>0.99'],
    rate_limited: ['count==0'],
    auth_errors: ['count==0'],
    ...(['rps', 'burst'].includes(mode) ? { dropped_iterations: ['count==0'] } : {}),
  },
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
  systemTags: ['status', 'method', 'name', 'scenario', 'expected_response'],
};

function request(session, path, name) {
  if (name !== 'preflight') started.add(1);
  const response = http.get(`${target}${path}`, {
    headers:
      session.transport === 'web-cookie'
        ? {
            Cookie: `belivrhq_token=${session.token}`,
            'x-belivrhq-client': 'web',
            Origin: target.match(/^https?:\/\/[^/]+/)[0],
            'Sec-Fetch-Site': 'same-origin',
          }
        : {
            Authorization: `Bearer ${session.token}`,
            ...(session.churchId ? { 'X-Church-Id': session.churchId } : {}),
          },
    tags: { name },
    timeout: '10s',
    redirects: 0,
  });
  if (name !== 'preflight') finished.add(1);
  let body;
  try {
    body = response.json();
  } catch {
    body = null;
  }
  const valid = response.status === 200 && validPayload(path, body, __ENV.WORKLOAD === 'live-read');
  const ok = check(response, { 'authorized successful data response': () => valid });
  if (name === 'preflight') return valid;
  elapsed.add(Date.now() - exec.scenario.startTime);
  errors.add(!ok);
  limited.add(response.status === 429 ? 1 : 0);
  serverErrors.add(response.status >= 500 ? 1 : 0);
  authErrors.add([401, 403].includes(response.status) ? 1 : 0);
  return valid;
}

export function setup() {
  // A bad/expired test session must stop the run, rather than benchmark fast login failures.
  const sampleCount = Math.min(sessions.length, 10);
  const sample = Array.from(
    { length: sampleCount },
    (_, i) => sessions[Math.floor((i * sessions.length) / sampleCount)],
  );
  for (const session of sample)
    for (const path of paths) {
      if (!request(session, path, 'preflight'))
        throw new Error(
          'Preflight failed: test accounts need authorized access to every workload endpoint',
        );
    }
}

export default function () {
  const session = sessions[(exec.vu.idInTest - 1) % sessions.length];
  const index = (exec.vu.idInTest + exec.vu.iterationInScenario) % paths.length;
  request(session, paths[index], paths[index].split('?')[0]);
  if (mode === 'users' && thinkSeconds) sleep(thinkSeconds);
}

export function handleSummary(data) {
  return { [__ENV.SUMMARY_FILE]: JSON.stringify(data, null, 2) };
}
