const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const {
  publish,
  prepare,
  promote,
  settings,
  healthy,
  assertReleaseMode,
  assertHostedReleaseMode,
} = require('../../scripts/lib/release-gate.cjs');

const sha = 'a'.repeat(40);
const env = {
  GITHUB_REF_NAME: 'main',
  GITHUB_EVENT_NAME: 'push',
  GITHUB_SHA: sha,
  BACKEND_RELEASE_ENABLED: 'true',
  VERCEL_TOKEN: 'synthetic-token',
  VERCEL_PROJECT_ID: 'prj_YRk2tzdbC5c5K9cUpjNMvHzN58YU',
  VERCEL_ORG_ID: 'team_5uEgLPJcDkJpzYS3oMbAgc4Y',
};
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
const body = () => ({
  success: true,
  data: {
    status: 'healthy',
    services: { database: 'up', redis: 'up' },
    queues: Object.fromEntries(queues.map((queue) => [queue, { status: 'up' }])),
    workers: Object.fromEntries(queues.map((queue) => [queue, 'up'])),
  },
});
function fake(options = {}) {
  const calls = [];
  let heads = 0;
  const run = (command, args) => {
    calls.push([command, args]);
    let output = '';
    if (command === 'git' && args[0] === 'ls-remote')
      output = `${options.stale && ++heads > 1 ? 'b'.repeat(40) : sha}\trefs/heads/main`;
    else if (command === 'git' && args[0] === 'rev-parse') output = sha;
    else if (command === 'git' && args[0] === 'ls-files') output = options.untracked ? 'src/unreviewed.ts' : '';
    else if (args[0] === 'deploy')
      output = JSON.stringify({ status: 'ok', deployment: { id: 'dpl_candidate' } });
    else if (args[0] === 'api' && args[1].startsWith('/v9/projects/'))
      output = JSON.stringify({ id: 'prj_YRk2tzdbC5c5K9cUpjNMvHzN58YU', accountId: 'team_5uEgLPJcDkJpzYS3oMbAgc4Y', gitProviderOptions: { createDeployments: options.gitEnabled ? 'enabled' : 'disabled' } });
    else if (args[0] === 'api')
      output = JSON.stringify({
        id: options.wrongCandidate ? 'dpl_other' : 'dpl_candidate',
        readyState: 'READY',
        projectId: options.wrongProject ? 'prj_other' : 'prj_YRk2tzdbC5c5K9cUpjNMvHzN58YU',
        target: options.preview ? null : 'production',
        meta: { readinessReleaseSha: options.wrongCommit ? 'b'.repeat(40) : sha },
      });
    else if (args[0] === 'curl')
      output = JSON.stringify(
        options.unhealthy ? { success: true, data: { status: 'healthy' } } : body(),
      );
    return { status: options.buildFailure && args[0] === 'inspect' ? 1 : 0, stdout: output };
  };
  return { run, calls };
}
const promotions = (calls) => calls.filter(([, args]) => ['promote', 'alias'].includes(args[0]));

test('gated deployment configuration disables Git deployments while worker instances stay off', () => {
  const root = JSON.parse(readFileSync(join(__dirname, '../../vercel.json'), 'utf8'));
  const example = JSON.parse(
    readFileSync(join(__dirname, '../../config/vercel/daemon.example.json'), 'utf8'),
  );
  assert.equal(root.git.deploymentEnabled, false);
  for (const config of [root, example])
    for (const daemon of Object.values(config.daemons || {}))
      for (const instances of Object.values(daemon.instances || {})) assert.equal(instances, 0);
});

test('refuses gated promotion until independent Git deployment is explicitly disabled', () => {
  for (const config of [{}, { git: {} }, { git: { deploymentEnabled: true } }])
    assert.throws(() => assertReleaseMode(config));
  assert.doesNotThrow(() => assertReleaseMode({ git: { deploymentEnabled: false } }));
});

test('accepts explicitly deferred workers without ignoring required dependency failures', () => {
  const deferred = body();
  deferred.data.workersRequired = false;
  deferred.data.workers = {};
  assert.equal(healthy(deferred), true);
  delete deferred.data.workersRequired;
  assert.equal(healthy(deferred), false);
  deferred.data.workersRequired = true;
  assert.equal(healthy(deferred), false);
  deferred.data.workersRequired = false;
  deferred.data.queues.broadcast.status = 'down';
  assert.equal(healthy(deferred), false);
  deferred.data.queues.broadcast.status = 'up';
  deferred.data.services.database = 'down';
  assert.equal(healthy(deferred), false);
});

test('rejects disabled releases, untrusted event types and unsupported branches', () => {
  for (const override of [
    { BACKEND_RELEASE_ENABLED: '' },
    { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_REF_NAME: 'feature/test' },
    { VERCEL_TOKEN: '' },
  ])
    assert.throws(() => settings({ ...env, ...override }));
});
test('requires evidence for every worker, not just a healthy label', () => {
  assert.equal(healthy(body()), true);
  const missing = body();
  delete missing.data.workers.broadcast;
  assert.equal(healthy(missing), false);
  assert.equal(healthy({ success: true, data: { status: 'healthy' } }), false);
});
for (const [name, options] of Object.entries({
  'missing workers': { unhealthy: true },
  'wrong checked commit': { wrongCommit: true },
  'wrong project': { wrongProject: true },
  'failed candidate build': { buildFailure: true },
  'newer branch commit': { stale: true },
})) {
  test(`${name} prevents domain promotion`, async () => {
    const { run, calls } = fake(options);
    await assert.rejects(publish(env, run, async () => {}));
    assert.equal(promotions(calls).length, 0);
  });
}
test('production candidates are unaliased until readiness and identity pass', async () => {
  const { run, calls } = fake();
  const result = await publish(env, run, async () => {});
  assert.equal(result.domain, 'api.belivrhq.com');
  const deploy = calls.find(([, args]) => args[0] === 'deploy')[1];
  assert.ok(deploy.includes('--skip-domain'));
  assert.equal(promotions(calls).length, 1);
  assert.equal(promotions(calls)[0][1][0], 'promote');
  assert.ok(
    calls.findIndex(([, args]) => args[0] === 'curl') <
      calls.findIndex(([, args]) => args[0] === 'promote'),
  );
});
test('staging can only update the staging domain and never promotes production', async () => {
  const { run, calls } = fake({ preview: true });
  const result = await publish({ ...env, GITHUB_REF_NAME: 'staging' }, run, async () => {});
  assert.equal(result.domain, 'staging-api.belivrhq.com');
  assert.equal(promotions(calls).length, 1);
  assert.deepEqual(promotions(calls)[0][1].slice(0, 4), [
    'alias',
    'set',
    'dpl_candidate',
    'staging-api.belivrhq.com',
  ]);
});

test('refuses crossing a reviewed project/team boundary or unknown profile', () => {
  for (const override of [{ RELEASE_PROFILE: 'legacy' }, { RELEASE_PROFILE: 'unknown' }, { VERCEL_PROJECT_ID: 'prj_other' }, { VERCEL_ORG_ID: 'team_other' }])
    assert.throws(() => settings({ ...env, ...override }));
});
test('legacy configuration targets the legacy project independently', () => {
  const profile = require('../../config/releases.json').legacy;
  const actual = settings({ ...env, RELEASE_PROFILE: 'legacy', VERCEL_PROJECT_ID: profile.projectId, VERCEL_ORG_ID: profile.orgId });
  assert.equal(actual.domain, profile.main.domain);
  assert.notEqual(actual.domain, settings(env).domain);
});

test('candidate preparation never promotes and mismatched manifests are refused', async () => {
  const { run, calls } = fake();
  const manifest = await prepare(env, run, async () => {});
  assert.equal(promotions(calls).length, 0);
  for (const field of ['commit', 'profile', 'projectId', 'orgId', 'domain']) {
    await assert.rejects(promote(env, { ...manifest, [field]: 'wrong' }, run, async () => {}));
    assert.equal(promotions(calls).length, 0);
  }
  await promote(env, manifest, run, async () => {});
  assert.equal(promotions(calls).length, 1);
});

test('hosted Git deployment bypasses are refused before a candidate is uploaded', async () => {
  const { run, calls } = fake({ gitEnabled: true });
  assert.throws(() => assertHostedReleaseMode(env, run));
  await assert.rejects(prepare(env, run, async () => {}));
  assert.equal(calls.filter(([, args]) => args[0] === 'deploy').length, 0);
});

test('untracked source and mismatched candidate IDs cannot be released', async () => {
  for (const options of [{ untracked: true }, { wrongCandidate: true }]) {
    const { run, calls } = fake(options);
    await assert.rejects(publish(env, run, async () => {}));
    assert.equal(promotions(calls).length, 0);
    if (options.untracked) assert.equal(calls.filter(([, args]) => args[0] === 'deploy').length, 0);
  }
});
