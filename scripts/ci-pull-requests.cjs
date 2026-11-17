const assert = require('node:assert/strict');

const PROJECTS = {
  'pappycoder/BelivrHQ-Backend': {
    workflow: 'BelivrHQ Backend CI',
    check: 'Required backend checks',
  },
  'pappycoder/BelivrHQ-Web': { workflow: 'BelivrHQ Web CI', check: 'Required web checks' },
};
const BASES = ['main', 'staging'];

function requireThat(condition, message) {
  assert.ok(condition, message);
}

async function ensurePullRequests({ repository, runId, sha, ref, eventName, api }) {
  const project = PROJECTS[repository];
  requireThat(project, 'Repository is outside the reviewed primary projects');
  requireThat(eventName === 'push', 'Only same-repository pushes may open release PRs');
  requireThat(/^[0-9a-f]{40}$/.test(sha ?? ''), 'A complete checked commit SHA is required');
  requireThat(/^\d+$/.test(String(runId)), 'A CI run ID is required');
  const prefix = `/repos/${repository}`;
  const run = await api(`${prefix}/actions/runs/${runId}`);
  const branch = run.head_branch;
  requireThat(
    run.name === project.workflow && run.path === '.github/workflows/ci.yml',
    'Unexpected CI workflow',
  );
  requireThat(
    run.event === 'push' && run.head_repository?.full_name === repository,
    'Fork and PR runs cannot create release PRs',
  );
  requireThat(
    run.head_sha === sha && ref === `refs/heads/${branch}`,
    'CI run does not match this checked branch and commit',
  );
  requireThat(
    typeof branch === 'string' && branch.length > 0 && branch.length <= 240,
    'Invalid source branch',
  );
  requireThat(!BASES.includes(branch), 'Release branches do not open feature PRs');
  requireThat(
    !run.conclusion || run.conclusion === 'success',
    'Failed or cancelled CI cannot create release PRs',
  );

  const jobs = [];
  for (let page = 1; ; page++) {
    const data = await api(
      `${prefix}/actions/runs/${runId}/jobs?filter=latest&per_page=100&page=${page}`,
    );
    requireThat(Array.isArray(data.jobs), 'Invalid CI job evidence');
    jobs.push(...data.jobs);
    if (data.jobs.length < 100) break;
    requireThat(page < 20, 'Unexpected CI job pagination');
  }
  const checks = jobs.filter((job) => job.name === project.check);
  requireThat(
    checks.length === 1 && checks[0].status === 'completed' && checks[0].conclusion === 'success',
    'The required aggregate check has not passed',
  );
  const currentHead = async () => {
    const head = await api(`${prefix}/branches/${encodeURIComponent(branch)}`);
    requireThat(head.commit?.sha === sha, 'The branch moved after the checked commit');
  };
  await currentHead();

  const owner = repository.split('/')[0];
  const existing = (base) =>
    api(
      `${prefix}/pulls?${new URLSearchParams({ state: 'open', base, head: `${owner}:${branch}`, per_page: '100' })}`,
    );
  const results = [];
  for (const base of BASES) {
    await currentHead();
    const open = await existing(base);
    requireThat(Array.isArray(open), 'Invalid pull-request response');
    if (open.length) {
      results.push({ base, state: 'existing', number: open[0].number });
      continue;
    }
    const comparison = await api(`${prefix}/compare/${base}...${sha}`);
    requireThat(
      Number.isInteger(comparison.ahead_by) && Array.isArray(comparison.files),
      'Invalid comparison evidence',
    );
    if (comparison.ahead_by === 0 || comparison.files.length === 0) {
      results.push({ base, state: 'no-changes' });
      continue;
    }
    await currentHead();
    try {
      const created = await api(`${prefix}/pulls`, {
        method: 'POST',
        body: {
          base,
          head: branch,
          title: `CI passed: ${branch} into ${base}`.slice(0, 240),
          body: `All required checks passed for commit \`${sha}\` in [CI run ${runId}](https://github.com/${repository}/actions/runs/${runId}).\n\nReview and merge this change using the repository's protected-branch rules.`,
        },
      });
      requireThat(
        Number.isSafeInteger(created.number) && created.number > 0,
        'GitHub did not confirm PR creation',
      );
      results.push({ base, state: 'created', number: created.number });
    } catch (error) {
      if (error.status !== 422) throw error;
      // A concurrent run may have created this exact head/base PR first.
      const raced = await existing(base);
      if (!Array.isArray(raced) || !raced.length) throw error;
      results.push({ base, state: 'existing', number: raced[0].number });
    }
  }
  return results;
}

function githubApi(token, transport = fetch) {
  requireThat(token, 'A repository-scoped GitHub Actions token is required');
  return async (path, { method = 'GET', body } = {}) => {
    requireThat(path.startsWith('/repos/') && !/[\r\n]/.test(path), 'Invalid GitHub API path');
    const response = await transport(`https://api.github.com${path}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const error = new Error(`GitHub PR automation request failed (HTTP ${response.status})`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  };
}

if (require.main === module) {
  ensurePullRequests({
    repository: process.env.GITHUB_REPOSITORY,
    runId: process.env.GITHUB_RUN_ID,
    sha: process.env.GITHUB_SHA,
    ref: process.env.GITHUB_REF,
    eventName: process.env.GITHUB_EVENT_NAME,
    api: githubApi(process.env.GH_TOKEN),
  })
    .then((results) => {
      for (const result of results)
        console.log(
          `${result.base}: ${result.state}${result.number ? ` https://github.com/${process.env.GITHUB_REPOSITORY}/pull/${result.number}` : ''}`,
        );
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
module.exports = { PROJECTS, BASES, ensurePullRequests, githubApi };
