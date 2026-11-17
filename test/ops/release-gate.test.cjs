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
    else if (command === 'git' && args[0] === 'ls-files')
      output = options.untracked ? 'src/unreviewed.ts' : '';
    else if (command === 'git' && args[0] === 'branch')
      output = options.namedCheckout ? 'staging' : '';
    else if (args[0] === 'deploy')
      output = JSON.stringify(
        options.rawOutput
          ? { id: 'dpl_candidate', readyState: 'BUILDING' }
          : options.errorOutput
            ? { status: 'error', deployment: { id: 'dpl_candidate' } }
            : { status: 'ok', deployment: { id: 'dpl_candidate' } },
      );
    else if (args[0] === 'api' && args[1].includes('/domains?'))
      output = JSON.stringify(
        options.malformedDomains
          ? {}
          : {
              domains: [
                {
                  name: 'staging-api.belivrhq.com',
                  gitBranch: options.unboundDomain ? null : 'staging',
                },
                ...(options.headDomain ? [{ name: 'unsafe.example', gitBranch: 'HEAD' }] : []),
              ],
              pagination: options.moreDomains ? { next: 1 } : {},
            },
      );
    else if (args[0] === 'api' && args[1].endsWith('/env'))
      output = JSON.stringify(
        options.malformedEnvs
          ? {}
          : {
              envs: options.branchVariables
                ? [
                    {
                      key: 'SYNTHETIC_SECRET',
                      target: ['preview'],
                      gitBranch: 'staging',
                      value: 'must-never-leak',
                    },
                  ]
                : [],
            },
      );
    else if (args[0] === 'api' && args[1].startsWith('/v9/projects/'))
      output = JSON.stringify({
        id: 'prj_YRk2tzdbC5c5K9cUpjNMvHzN58YU',
        accountId: 'team_5uEgLPJcDkJpzYS3oMbAgc4Y',
        gitProviderOptions: { createDeployments: options.gitEnabled ? 'enabled' : 'disabled' },
      });
    else if (args[0] === 'api')
      output = JSON.stringify({
        id: options.wrongCandidate ? 'dpl_other' : 'dpl_candidate',
        readyState: options.buildFailure ? 'ERROR' : 'READY',
        projectId: options.wrongProject ? 'prj_other' : 'prj_YRk2tzdbC5c5K9cUpjNMvHzN58YU',
        target: options.preview ? null : 'production',
        meta: { readinessReleaseSha: options.wrongCommit ? 'b'.repeat(40) : sha },
      });
    else if (args[0] === 'curl')
      output = JSON.stringify(
        options.unhealthy ? { success: true, data: { status: 'healthy' } } : body(),
      );
    const unsupportedPreviewFlag =
      args[0] === 'deploy' &&
      args[args.indexOf('--environment') + 1] === 'preview' &&
      args.includes('--skip-domain');
    return {
      status:
        unsupportedPreviewFlag ||
        ((options.buildFailure || options.inspectFailure) && args[0] === 'inspect')
          ? 1
          : 0,
      stdout: output,
    };
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
  for (const override of [
    { RELEASE_PROFILE: 'legacy' },
    { RELEASE_PROFILE: 'unknown' },
    { VERCEL_PROJECT_ID: 'prj_other' },
    { VERCEL_ORG_ID: 'team_other' },
  ])
    assert.throws(() => settings({ ...env, ...override }));
});
test('legacy configuration targets the legacy project independently', () => {
  const profile = require('../../config/releases.json').legacy;
  const actual = settings({
    ...env,
    RELEASE_PROFILE: 'legacy',
    VERCEL_PROJECT_ID: profile.projectId,
    VERCEL_ORG_ID: profile.orgId,
  });
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

test('accepts the pinned CLI standard raw deployment JSON as well as its agent envelope', async () => {
  const { run, calls } = fake({ rawOutput: true });
  await publish(env, run, async () => {});
  assert.equal(promotions(calls).length, 1);
});
test('rejects a CLI error envelope even when it includes a deployment identifier', async () => {
  const { run, calls } = fake({ errorOutput: true });
  await assert.rejects(publish(env, run, async () => {}));
  assert.equal(promotions(calls).length, 0);
});

for (const [label, options] of Object.entries({
  'named checkout': { namedCheckout: true },
  'detached HEAD domain binding': { headDomain: true },
  'missing staging branch binding': { unboundDomain: true },
  'unreadable domain metadata': { malformedDomains: true },
  'incomplete domain metadata': { moreDomains: true },
  'branch-specific Preview variables': { branchVariables: true },
  'unreadable environment metadata': { malformedEnvs: true },
})) {
  test(`Preview isolation refuses ${label} before uploading or switching domains`, async () => {
    const { run, calls } = fake({ preview: true, ...options });
    await assert.rejects(prepare({ ...env, GITHUB_REF_NAME: 'staging' }, run, async () => {}));
    assert.equal(calls.filter(([, args]) => args[0] === 'deploy').length, 0);
    assert.equal(promotions(calls).length, 0);
  });
}
test('Preview uses a detached snapshot and supported flags before explicit promotion', async () => {
  const { run, calls } = fake({ preview: true });
  const manifest = await prepare({ ...env, GITHUB_REF_NAME: 'staging' }, run, async () => {});
  const deploy = calls.find(([, args]) => args[0] === 'deploy')[1];
  assert.equal(deploy.includes('--skip-domain'), false);
  assert.equal(deploy[deploy.indexOf('--environment') + 1], 'preview');
  assert.ok(
    calls.some(
      ([cmd, args]) => cmd === 'git' && args[0] === 'branch' && args[1] === '--show-current',
    ),
  );
  assert.equal(promotions(calls).length, 0);
  await promote({ ...env, GITHUB_REF_NAME: 'staging' }, manifest, run, async () => {});
  assert.equal(promotions(calls).length, 1);
});
test('branch metadata overrides cannot bypass detached Preview isolation', () => {
  for (const key of ['githubCommitRef', 'gitlabCommitRef', 'bitbucketCommitRef'])
    assert.throws(() =>
      assertReleaseMode({ git: { deploymentEnabled: false }, meta: { [key]: 'staging' } }),
    );
});
test('command failures identify only a safe operation and status while withholding credentials', async () => {
  const { run } = fake();
  const failed = (cmd, args, opts) =>
    args[0] === 'deploy'
      ? { status: 1, stdout: 'synthetic-private-token', stderr: 'DATABASE_URL=private' }
      : run(cmd, args, opts);
  await assert.rejects(
    prepare(env, failed, async () => {}),
    (error) => {
      assert.match(error.message, /vercel deploy; exit 1/);
      assert.equal(error.message.includes('synthetic-private-token'), false);
      assert.equal(error.message.includes('DATABASE_URL'), false);
      return true;
    },
  );
});

test('explicit deployment aliases cannot bypass the checked promotion phase', () => {
  for (const alias of ['staging.example.org', ['staging.example.org'], []])
    assert.throws(() => assertReleaseMode({ git: { deploymentEnabled: false }, alias }));
});

test('Vercel installs the same frozen npm dependency tree as CI', () => {
  const config = JSON.parse(readFileSync(join(__dirname, '../../vercel.json'), 'utf8'));
  assert.equal(config.installCommand, 'npm ci --include=dev');
  assert.equal(config.buildCommand, 'npm run build');
  assert.ok(readFileSync(join(__dirname, '../../package-lock.json'), 'utf8'));
});

test('a failed CLI wait can continue only for a verified READY candidate', async () => {
  const { run, calls } = fake({ inspectFailure: true });
  await publish(env, run, async () => {});
  assert.equal(promotions(calls).length, 1);
});

test('failed build diagnostics identify the deployment and state without raw logs', async () => {
  const { run, calls } = fake({ buildFailure: true });
  await assert.rejects(
    prepare(env, run, async () => {}),
    /ERROR; dpl_candidate/,
  );
  assert.equal(promotions(calls).length, 0);
});

test('Vercel credentials stay before the curl passthrough delimiter', async () => {
  const { run, calls } = fake();
  await publish(env, run, async () => {});
  const probes = calls.filter(([, args]) => args[0] === 'curl');
  assert.ok(probes.length > 0);
  for (const [, args] of probes) {
    const delimiter = args.indexOf('--');
    assert.ok(delimiter > args.indexOf('--scope'));
    assert.ok(delimiter > args.indexOf('--token'));
    assert.ok(!args.slice(delimiter + 1).includes(env.VERCEL_TOKEN));
    assert.ok(args.slice(delimiter + 1).includes('--fail'));
  }
});
