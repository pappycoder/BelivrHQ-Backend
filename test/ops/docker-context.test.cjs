const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { dockerReadiness } = require('../../scripts/lib/docker-readiness.cjs');

test('Docker excludes private artifacts using its actual context filtering', async (t) => {
  const available = await dockerReadiness();
  if (!available.ready) {
    if (process.env.REQUIRE_DOCKER_TESTS === '1')
      assert.fail(`Docker must be available in CI: ${available.reason}`);
    t.skip('Docker daemon unavailable; this check is mandatory in CI');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'belivrhq-context-'));
  const context = path.join(root, 'context');
  const output = path.join(root, 'output');
  const privatePaths = [
    '.env',
    '.env.vercel.json',
    '.ops/backups/database.dump',
    '.ops/live-diagnosis/config.json',
    '.vercel/project.json',
    '.aws/credentials',
    '.agents/private.txt',
    '.codex/private.txt',
    'test/load/results/session.json',
    'certificate.key',
    'certificate.pem',
  ];
  const publicPaths = [
    'src/main.ts',
    'package.json',
    'prisma/schema.prisma',
    '.config/prisma.config.ts',
    '.env.example',
  ];
  try {
    fs.mkdirSync(context);
    fs.copyFileSync(path.resolve('.dockerignore'), path.join(context, '.dockerignore'));
    for (const file of [...privatePaths, ...publicPaths]) {
      const target = path.join(context, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'synthetic-build-context-canary');
    }
    fs.writeFileSync(path.join(context, 'Dockerfile'), 'FROM scratch\nCOPY . /\n');
    const result = spawnSync(
      'docker',
      ['build', '--output', `type=local,dest=${output}`, context],
      {
        encoding: 'utf8',
        timeout: 120000,
        env: { ...process.env, DOCKER_BUILDKIT: '1' },
      },
    );
    assert.equal(result.status, 0, 'Synthetic Docker context export must build successfully');
    for (const file of privatePaths)
      assert.equal(
        fs.existsSync(path.join(output, file)),
        false,
        `${file} entered the build context`,
      );
    for (const file of publicPaths)
      assert.equal(fs.existsSync(path.join(output, file)), true, `${file} is required for builds`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Docker readiness tolerates transient startup timeouts with bounded probes', async () => {
  let attempts = 0;
  const waits = [];
  const result = await dockerReadiness(
    (command, args, options) => {
      assert.equal(command, 'docker');
      assert.deepEqual(args, ['info', '--format', '{{.ServerVersion}}']);
      assert.equal(options.timeout, 20000);
      assert.equal(options.killSignal, 'SIGKILL');
      return ++attempts === 3 ? { status: 0 } : { status: null, error: { code: 'ETIMEDOUT' } };
    },
    async (ms) => waits.push(ms),
  );
  assert.equal(result.ready, true);
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [2000, 2000]);
});

test('Docker readiness stops retrying and reports failure without daemon output', async () => {
  for (const failure of [
    { status: 1, stderr: 'private-daemon-endpoint' },
    { status: null, error: { code: 'ETIMEDOUT' } },
    { status: null, error: { code: 'ENOENT' } },
  ]) {
    let attempts = 0;
    const result = await dockerReadiness(
      () => {
        attempts++;
        return failure;
      },
      async () => {},
    );
    assert.equal(result.ready, false);
    assert.equal(attempts, failure.error?.code === 'ENOENT' ? 1 : 3);
    assert.doesNotMatch(result.reason, /private-daemon-endpoint/);
    assert.match(
      result.reason,
      failure.error?.code === 'ENOENT'
        ? /CLI missing/
        : failure.error?.code === 'ETIMEDOUT'
          ? /timed out after 3 attempts/
          : /status 1 after 3 attempts/,
    );
  }
});
