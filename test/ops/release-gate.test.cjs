const { test } = require('node:test');
const assert = require('node:assert/strict');
const { publish, settings, healthy } = require('../../scripts/lib/release-gate.cjs');

const sha = 'a'.repeat(40);
const env = {
  GITHUB_REF_NAME: 'main',
  GITHUB_EVENT_NAME: 'push',
  GITHUB_SHA: sha,
  BACKEND_RELEASE_ENABLED: 'true',
  VERCEL_TOKEN: 'synthetic-token',
  VERCEL_PROJECT_ID: 'prj_fixture',
  VERCEL_ORG_ID: 'team_fixture',
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
    else if (args[0] === 'deploy')
      output = JSON.stringify({ status: 'ok', deployment: { id: 'dpl_candidate' } });
    else if (args[0] === 'api')
      output = JSON.stringify({
        readyState: 'READY',
        projectId: options.wrongProject ? 'prj_other' : 'prj_fixture',
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
