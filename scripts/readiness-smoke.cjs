#!/usr/bin/env node
// Disposable loopback fixtures only. Never loads the application's local env files.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { Queue } = require('bullmq');
const Redis = require('ioredis');
const queues = [
  'whatsapp-outbound',
  'email-outbound',
  'sms-outbound',
  'recurring-giving',
  'nightly-jobs',
  'broadcast',
  'dead-letter',
  'webhook-delivery',
];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fixtureUrl(value, kind) {
  const url = new URL(value || '');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !url.port)
    throw new Error('Explicit disposable loopback connections are required.');
  if (
    kind === 'database' &&
    (!['postgres:', 'postgresql:'].includes(url.protocol) || !/test/i.test(url.pathname))
  )
    throw new Error('A disposable test database is required.');
  if (kind === 'redis' && url.protocol !== 'redis:')
    throw new Error('An isolated loopback Redis fixture is required.');
  return value;
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function until(check, timeout = 60000, signal) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (signal?.aborted) throw new Error('Controlled smoke interrupted.');
    try {
      if (await check()) return;
    } catch {
      /* startup and expiry are bounded */
    }
    await delay(250);
  }
  throw new Error('Controlled smoke condition was not satisfied.');
}
async function request(origin, route) {
  const response = await fetch(`${origin}${route}`, { signal: AbortSignal.timeout(5000) });
  return { status: response.status, body: await response.json() };
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const end = Date.now() + 30000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < end) await delay(100);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

async function main() {
  const database = fixtureUrl(process.env.SMOKE_DATABASE_URL, 'database');
  const redisUrl = fixtureUrl(process.env.SMOKE_REDIS_URL, 'redis');
  const namespace = `readiness-smoke-${randomUUID().replaceAll('-', '')}`;
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'belivrhq-worker-smoke-'));
  fs.chmodSync(folder, 0o700);
  const port = await freePort();
  const workerPort = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const env = {
    PATH: process.env.PATH,
    LANG: 'C.UTF-8',
    TZ: 'Africa/Lagos',
    NODE_ENV: 'production',
    DOTENV_CONFIG_PATH: '/dev/null',
    PORT: String(port),
    WORKER_HEALTH_PORT: String(workerPort),
    DATABASE_URL: database,
    DB_POOL_MAX: '2',
    REDIS_URL: redisUrl,
    QUEUE_REDIS_URL: redisUrl,
    REDIS_NAMESPACE: namespace,
    WEB_URL: 'https://example.invalid',
    SUPABASE_URL: 'https://example.invalid',
    SUPABASE_SERVICE_ROLE_KEY: 'synthetic-fixture-service-role',
    SUPABASE_ANON_KEY: 'synthetic-fixture-anon',
    ALTCHA_HMAC_KEY: 'a'.repeat(64),
    PASTORAL_ENCRYPTION_KEY: 'b'.repeat(64),
    ENABLE_QUEUE_WORKERS: 'false',
  };
  const children = [];
  const controller = new AbortController();
  const waitFor = (check) => until(check, 60000, controller.signal);
  const interrupt = () => {
    controller.abort();
    for (const child of children) child.kill('SIGTERM');
  };
  process.once('SIGTERM', interrupt);
  process.once('SIGINT', interrupt);
  const launch = (entry, label) => {
    const fd = fs.openSync(path.join(folder, `${label}.log`), 'w', 0o600);
    try {
      const child = spawn(process.execPath, [path.resolve('dist', entry)], {
        cwd: folder,
        env,
        stdio: ['ignore', fd, fd],
      });
      children.push(child);
      return child;
    } finally {
      fs.closeSync(fd);
    }
  };
  const redis = new Redis(redisUrl, {
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    commandTimeout: 3000,
    enableOfflineQueue: false,
  });
  redis.on('error', () => {});
  const queue = new Queue('dead-letter', {
    prefix: `${namespace}:bull`,
    connection: { url: redisUrl, maxRetriesPerRequest: 1, commandTimeout: 3000 },
    skipMetasUpdate: true,
  });
  queue.on('error', () => {});
  try {
    launch('main.js', 'api');
    let worker = launch('worker.js', 'worker');
    const ready = async () => {
      const response = await request(origin, '/api/v1/health/ready');
      return (
        response.status === 200 &&
        response.body.data?.status === 'healthy' &&
        queues.every((name) => response.body.data?.workers?.[name] === 'up')
      );
    };
    await waitFor(ready);
    const live = await request(`http://127.0.0.1:${workerPort}`, '/health/live');
    if (live.status !== 200 || live.body.status !== 'alive')
      throw new Error('Worker process probe failed.');
    const job = await queue.add(
      'review',
      {
        version: 1,
        queue: 'broadcast',
        jobId: 'synthetic-fixture',
        attempts: 1,
        failedAt: Date.now(),
      },
      { jobId: 'controlled-smoke-review' },
    );
    await waitFor(async () => (await job.getState()) === 'completed');
    for (const name of queues) {
      const ttl = await redis.ttl(`${namespace}:worker:heartbeat:${name}`);
      if (ttl <= 0 || ttl > 90) throw new Error('Worker lease is not expiring.');
    }
    await stop(worker);
    // Fault injection into this random fixture namespace only: accelerate expiry.
    for (const name of queues) await redis.expire(`${namespace}:worker:heartbeat:${name}`, 1);
    await waitFor(async () => {
      const response = await request(origin, '/api/v1/health/ready');
      return (
        response.status === 503 &&
        queues.every((name) => response.body.data?.workers?.[name] === 'down')
      );
    });
    if ((await request(origin, '/api/v1/health/live')).status !== 200)
      throw new Error('Liveness must survive a worker outage.');
    worker = launch('worker.js', 'worker-restarted');
    await waitFor(ready);
    console.log(
      JSON.stringify({
        readiness: 'healthy',
        controlledJob: 'completed',
        absentWorkerStatus: 503,
        livenessDuringOutage: 200,
        restartRecovery: 'healthy',
      }),
    );
  } finally {
    for (const child of children.reverse()) await stop(child);
    process.removeListener('SIGTERM', interrupt);
    process.removeListener('SIGINT', interrupt);
    try {
      await queue.close();
      let cursor = '0';
      do {
        const page = await redis.scan(cursor, 'MATCH', `${namespace}:*`, 'COUNT', 100);
        cursor = page[0];
        const keys = page[1].filter((key) => key.startsWith(`${namespace}:`));
        if (keys.length) await redis.del(...keys);
      } while (cursor !== '0');
    } finally {
      redis.disconnect();
    }
    // Logs contain only synthetic fixture data and remain private for diagnostics.
  }
}
if (require.main === module)
  main().catch(() => {
    console.error(
      'Isolated readiness smoke failed. Inspect private /tmp/belivrhq-worker-smoke-* logs; no credential values were logged.',
    );
    process.exitCode = 1;
  });
module.exports = { fixtureUrl };
