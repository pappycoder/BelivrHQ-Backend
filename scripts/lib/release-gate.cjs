const { spawnSync } = require('node:child_process');
class ReleaseError extends Error {}

const PROFILES = require('../../config/releases.json');
const TARGETS = { main: PROFILES.primary.main, staging: PROFILES.primary.staging };

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
  const profile = PROFILES[env.RELEASE_PROFILE || 'primary'];
  const target = profile?.[env.GITHUB_REF_NAME];
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
  if (env.VERCEL_PROJECT_ID !== profile.projectId || env.VERCEL_ORG_ID !== profile.orgId)
    throw new ReleaseError('Project/team does not match the reviewed release profile.');
  return target;
}

function execute(command, args, runner = spawnSync) {
  const result = runner(command, args, { encoding: 'utf8', timeout: 660000 });
  if (result.status !== 0 || result.error) {
    const operation =
      command === 'vercel' &&
      ['api', 'deploy', 'inspect', 'curl', 'promote', 'alias'].includes(args[0])
        ? ` ${args[0]}`
        : '';
    const status = Number.isInteger(result.status) ? `exit ${result.status}` : 'process error';
    throw new ReleaseError(
      `Release operation failed (${command}${operation}; ${status}); output suppressed to protect credentials.`,
    );
  }
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
  if (execute('git', ['ls-files', '--others', '--exclude-standard'], runner).trim())
    throw new ReleaseError(
      'Untracked source exists; refusing to deploy code outside the checked commit.',
    );
}

function assertReleaseMode(config) {
  if (config?.alias !== undefined)
    throw new ReleaseError('Release candidates cannot declare aliases in vercel.json.');
  if (
    ['githubCommitRef', 'gitlabCommitRef', 'bitbucketCommitRef'].some(
      (key) => config?.meta?.[key] !== undefined,
    )
  )
    throw new ReleaseError(
      'Release candidates cannot override Git branch metadata in vercel.json.',
    );
  if (config?.git?.deploymentEnabled !== false)
    throw new ReleaseError(
      'Gated promotion requires Git auto-deployments to be explicitly disabled first.',
    );
}

function healthy(body) {
  const data = body && body.success === true && body.data;
  return (
    !!data &&
    data.status === 'healthy' &&
    data.services?.database === 'up' &&
    data.services?.redis === 'up' &&
    QUEUES.every((queue) => data.queues?.[queue]?.status === 'up') &&
    (data.workersRequired === false || QUEUES.every((queue) => data.workers?.[queue] === 'up'))
  );
}

function command(env, runner) {
  return (args) => {
    // Everything after -- belongs to curl, including flags that look global.
    const delimiter = args.indexOf('--');
    const split = delimiter < 0 ? args.length : delimiter;
    return execute(
      'vercel',
      [
        ...args.slice(0, split),
        '--scope',
        env.VERCEL_ORG_ID,
        '--token',
        env.VERCEL_TOKEN,
        ...args.slice(split),
      ],
      runner,
    );
  };
}
function assertHostedReleaseMode(env, runner = spawnSync) {
  settings(env);
  const project = JSON.parse(
    command(env, runner)(['api', `/v9/projects/${env.VERCEL_PROJECT_ID}`]),
  );
  if (
    project.id !== env.VERCEL_PROJECT_ID ||
    project.accountId !== env.VERCEL_ORG_ID ||
    project.gitProviderOptions?.createDeployments !== 'disabled'
  )
    throw new ReleaseError(
      'Verify project/team access and disable hosted Git auto-deployments before releasing.',
    );
}
function assertPreviewIsolation(env, runner = spawnSync, vc = command(env, runner)) {
  const target = settings(env);
  // CLI 65.9 only supports --skip-domain for Production. A detached snapshot
  // reports commitRef=HEAD, so Preview cannot claim the staging branch domain.
  if (execute('git', ['branch', '--show-current'], runner).trim())
    throw new ReleaseError(
      'Preview preparation requires a detached checkout of the checked commit.',
    );
  const domains = JSON.parse(
    vc(['api', `/v9/projects/${env.VERCEL_PROJECT_ID}/domains?limit=100`]),
  );
  if (
    !Array.isArray(domains.domains) ||
    domains.pagination?.next ||
    !domains.domains.some(
      (domain) =>
        domain.name === target.domain &&
        domain.gitBranch === env.GITHUB_REF_NAME &&
        !domain.customEnvironmentId,
    ) ||
    domains.domains.some((domain) => domain.gitBranch === 'HEAD')
  )
    throw new ReleaseError('Cannot verify detached Preview domain isolation.');
  const variables = JSON.parse(vc(['api', `/v10/projects/${env.VERCEL_PROJECT_ID}/env`]));
  if (
    !Array.isArray(variables.envs) ||
    variables.pagination?.next ||
    variables.envs.some(
      (variable) =>
        Array.isArray(variable.target) && variable.target.includes('preview') && variable.gitBranch,
    )
  )
    throw new ReleaseError(
      'Checked Preview candidates require standard Preview variables without branch overrides.',
    );
}
function inspectCandidate(env, candidate, vc) {
  if (!/^dpl_[a-zA-Z0-9]+$/.test(candidate || ''))
    throw new ReleaseError('Invalid candidate identity.');
  const target = settings(env);
  const info = JSON.parse(vc(['api', `/v13/deployments/${candidate}`]));
  if (
    info.id !== candidate ||
    info.readyState !== 'READY' ||
    info.projectId !== env.VERCEL_PROJECT_ID ||
    info.meta?.readinessReleaseSha !== env.GITHUB_SHA ||
    (target.environment === 'production'
      ? info.target !== 'production'
      : ![null, undefined, 'preview'].includes(info.target) || !!info.customEnvironment)
  )
    throw new ReleaseError('Candidate identity, target or checked commit could not be verified.');
}
async function checkReadiness(env, deployment, vc, wait) {
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
      if (healthy(body, settings(env))) return;
    } catch {
      /* Bounded retries; never expose CLI output or credentials. */
    }
    if (attempt < 2) await wait(2000);
  }
  throw new ReleaseError('Candidate readiness did not pass; promotion refused.');
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function prepare(env, runner = spawnSync, wait = delay) {
  const target = settings(env);
  assertCurrentHead(env, runner);
  assertHostedReleaseMode(env, runner);
  const vc = command(env, runner);
  if (target.environment === 'preview') assertPreviewIsolation(env, runner, vc);
  const deployed = JSON.parse(
    vc([
      'deploy',
      '--project',
      env.VERCEL_PROJECT_ID,
      '--environment',
      target.environment,
      ...(target.environment === 'production' ? ['--skip-domain'] : []),
      '--no-wait',
      '--yes',
      '--json',
      '--meta',
      `readinessReleaseSha=${env.GITHUB_SHA}`,
    ]),
  );
  // CLI 65.9 emits raw JSON normally and an envelope in agent mode.
  const wrapped = Object.hasOwn(deployed, 'deployment');
  const candidate = wrapped ? deployed.deployment : deployed;
  if (
    (wrapped ? deployed.status !== 'ok' : Object.hasOwn(deployed, 'status')) ||
    deployed.error ||
    candidate?.error ||
    candidate?.aliasError ||
    !/^dpl_[a-zA-Z0-9]+$/.test(candidate?.id || '')
  )
    throw new ReleaseError('Vercel did not return a valid candidate.');
  try {
    vc(['inspect', candidate.id, '--wait', '--timeout', '10m']);
  } catch {
    // Distinguish a failed build from a CLI wait failure without exposing logs.
    const info = JSON.parse(vc(['api', `/v13/deployments/${candidate.id}`]));
    if (info.readyState !== 'READY') {
      const state = ['ERROR', 'CANCELED', 'BUILDING', 'QUEUED', 'INITIALIZING'].includes(
        info.readyState,
      )
        ? info.readyState
        : 'UNKNOWN';
      throw new ReleaseError(
        `Candidate did not become ready (${state}; ${candidate.id}). Check its Vercel build logs; promotion refused.`,
      );
    }
    // READY still has to pass every identity and application readiness check below.
  }
  inspectCandidate(env, candidate.id, vc);
  await checkReadiness(env, candidate.id, vc, wait);
  return {
    commit: env.GITHUB_SHA,
    profile: env.RELEASE_PROFILE || 'primary',
    projectId: env.VERCEL_PROJECT_ID,
    orgId: env.VERCEL_ORG_ID,
    deployment: candidate.id,
    domain: target.domain,
  };
}
async function promote(env, manifest, runner = spawnSync, wait = delay) {
  const target = settings(env);
  if (
    !manifest ||
    manifest.commit !== env.GITHUB_SHA ||
    manifest.profile !== (env.RELEASE_PROFILE || 'primary') ||
    manifest.projectId !== env.VERCEL_PROJECT_ID ||
    manifest.orgId !== env.VERCEL_ORG_ID ||
    manifest.domain !== target.domain
  )
    throw new ReleaseError('Candidate manifest does not match this checked release.');
  assertCurrentHead(env, runner);
  assertHostedReleaseMode(env, runner);
  const vc = command(env, runner);
  inspectCandidate(env, manifest.deployment, vc);
  await checkReadiness(env, manifest.deployment, vc, wait);
  assertCurrentHead(env, runner);
  if (target.environment === 'production') vc(['promote', manifest.deployment, '--yes']);
  else vc(['alias', 'set', manifest.deployment, target.domain]);
  await checkReadiness(env, `https://${target.domain}`, vc, wait);
  return { commit: env.GITHUB_SHA, deployment: manifest.deployment, domain: target.domain };
}
// Retained for isolated regression simulations; CI invokes separate prepare/promote phases.
async function publish(env, runner = spawnSync, wait = delay) {
  return promote(env, await prepare(env, runner, wait), runner, wait);
}

module.exports = {
  ReleaseError,
  settings,
  assertCurrentHead,
  assertReleaseMode,
  assertHostedReleaseMode,
  assertPreviewIsolation,
  healthy,
  publish,
  prepare,
  promote,
  TARGETS,
};
