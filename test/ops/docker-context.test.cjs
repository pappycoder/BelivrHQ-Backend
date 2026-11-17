const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('Docker excludes private artifacts using its actual context filtering', (t) => {
  const available = spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 10000 });
  if (available.status !== 0) {
    assert.notEqual(process.env.REQUIRE_DOCKER_TESTS, '1', 'Docker must be available in CI');
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
