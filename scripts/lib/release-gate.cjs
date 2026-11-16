const { spawnSync } = require('node:child_process');
class ReleaseError extends Error {}

const TARGETS = {
  main: { environment: 'production', domain: 'api.belivrhq.com' },
  staging: { environment: 'preview', domain: 'staging-api.belivrhq.com' },
};
const QUEUES = [
  'whatsapp-outbound',
  'email-outbound',
  'sms-outbound',
  'recurring-giving',
  'nightly-jobs',
  'broadcast',
  'dead-letter',
  'webhook-delivery',
];

function settings(env) {
  const target = TARGETS[env.GITHUB_REF_NAME];
  if (!target || env.GITHUB_EVENT_NAME !== 'push' || env.BACKEND_RELEASE_ENABLED !== 'true')
    throw new ReleaseError('Automatic release is not enabled for this checked branch.');
  if (!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA || ''))
    throw new ReleaseError('A checked commit SHA is required.');
  if (
    !env.VERCEL_TOKEN ||
    !/^prj_[a-zA-Z0-9]+$/.test(env.VERCEL_PROJECT_ID || '') ||
    !/^team_[a-zA-Z0-9]+$/.test(env.VERCEL_ORG_ID || '')
  )
    throw new ReleaseError('Configure the scoped Vercel CI token and project/team IDs.');
  return target;
}

function execute(command, args, runner = spawnSync) {
  const result = runner(command, args, { encoding: 'utf8', timeout: 660000 });
  if (result.status !== 0 || result.error)
    throw new ReleaseError(
      `Release operation failed (${command}); output suppressed to protect credentials.`,
    );
  return result.stdout || '';
}

function assertCurrentHead(env, runner = spawnSync) {
  settings(env);
  const remote = execute(
    'git',
    ['ls-remote', 'origin', `refs/heads/${env.GITHUB_REF_NAME}`],
    runner,
  )
    .trim()
    .split(/\s+/)[0];
  const local = execute('git', ['rev-parse', 'HEAD'], runner).trim();
  if (remote !== env.GITHUB_SHA || local !== env.GITHUB_SHA)
    throw new ReleaseError(
      'A newer commit exists or checkout differs from the checked commit; release stopped.',
    );
  execute('git', ['diff', '--quiet', 'HEAD'], runner);
}

function healthy(body) {
  const data = body && body.success === true && body.data;
  return (
    !!data &&
    data.status === 'healthy' &&
    data.services?.database === 'up' &&
    data.services?.redis === 'up' &&
    QUEUES.every((queue) => data.queues?.[queue]?.status === 'up' && data.workers?.[queue] === 'up')
  );
}

async function publish(
  env,
  runner = spawnSync,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  const target = settings(env);
  assertCurrentHead(env, runner);
  const vc = (args) =>
    execute('vercel', [...args, '--scope', env.VERCEL_ORG_ID, '--token', env.VERCEL_TOKEN], runner);
  const deployed = JSON.parse(
    vc([
      'deploy',
      '--project',
      env.VERCEL_PROJECT_ID,
      '--environment',
      target.environment,
      '--skip-domain',
      '--no-wait',
      '--yes',
      '--json',
      '--meta',
      `readinessReleaseSha=${env.GITHUB_SHA}`,
    ]),
  );
  const candidate = deployed.deployment;
  if (deployed.status !== 'ok' || !/^dpl_[a-zA-Z0-9]+$/.test(candidate?.id || ''))
    throw new ReleaseError('Vercel did not return a valid candidate deployment.');
  vc(['inspect', candidate.id, '--wait', '--timeout', '10m']);
  const info = JSON.parse(vc(['api', `/v13/deployments/${candidate.id}`]));
  if (
    info.readyState !== 'READY' ||
    info.projectId !== env.VERCEL_PROJECT_ID ||
    info.meta?.readinessReleaseSha !== env.GITHUB_SHA ||
    (target.environment === 'production'
      ? info.target !== 'production'
      : ![null, undefined, 'preview'].includes(info.target) || !!info.customEnvironment)
  )
    throw new ReleaseError('Candidate identity, target or checked commit could not be verified.');
  const check = async (deployment) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const body = JSON.parse(
          vc([
            'curl',
            '/api/v1/health/ready',
            '--deployment',
            deployment,
            '--',
            '--fail',
            '--silent',
            '--show-error',
            '--max-time',
            '10',
          ]),
        );
        if (healthy(body)) return;
      } catch {
        /* A cold instance or transient failure gets bounded retries. */
      }
      if (attempt < 2) await wait(2000);
    }
    throw new ReleaseError(
      'Readiness did not confirm database, Redis, queues and workers; release stopped.',
    );
  };
  await check(candidate.id);
  assertCurrentHead(env, runner);
  if (target.environment === 'production') vc(['promote', candidate.id, '--yes']);
  else vc(['alias', 'set', candidate.id, target.domain]);
  await check(`https://${target.domain}`);
  return { commit: env.GITHUB_SHA, deployment: candidate.id, domain: target.domain };
}

module.exports = { ReleaseError, settings, assertCurrentHead, healthy, publish, TARGETS };
