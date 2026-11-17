const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const yaml = require('js-yaml');
const { ensurePullRequests, githubApi, PROJECTS } = require('../../scripts/ci-pull-requests.cjs');

function fixture(repository = 'pappycoder/BelivrHQ-Backend') {
  const sha = 'a'.repeat(40),
    branch = 'fix/checked-change';
  const project = PROJECTS[repository];
  const state = {
    run: {
      name: project.workflow,
      path: '.github/workflows/ci.yml',
      event: 'push',
      head_repository: { full_name: repository },
      head_sha: sha,
      head_branch: branch,
      conclusion: null,
    },
    jobs: [{ name: project.check, status: 'completed', conclusion: 'success' }],
    head: sha,
    existing: {},
    compare: {},
    calls: [],
    created: [],
    failCreate: null,
  };
  const api = async (path, options = {}) => {
    state.calls.push({ path, ...options });
    if (path.includes('/actions/runs/') && !path.includes('/jobs?')) return state.run;
    if (path.includes('/jobs?')) return { jobs: state.jobs };
    if (path.includes('/branches/')) return { commit: { sha: state.head } };
    if (path.includes('/pulls?')) {
      const base = new URL('https://api.github.com' + path).searchParams.get('base');
      return state.existing[base] ?? [];
    }
    if (path.includes('/compare/')) {
      const base = path.split('/compare/')[1].split('...')[0];
      return state.compare[base] ?? { ahead_by: 1, files: [{ filename: 'src/example.ts' }] };
    }
    if (path.endsWith('/pulls') && options.method === 'POST') {
      if (state.failCreate) return state.failCreate(options.body);
      state.created.push(options.body);
      return { number: state.created.length + 10 };
    }
    throw new Error('Unexpected API call: ' + path);
  };
  return {
    state,
    input: { repository, sha, ref: `refs/heads/${branch}`, runId: '12345', eventName: 'push', api },
  };
}

test('opens main and staging PRs only after the exact head passed required checks', async () => {
  for (const repository of Object.keys(PROJECTS)) {
    const { input, state } = fixture(repository);
    const result = await ensurePullRequests(input);
    assert.deepEqual(
      result.map((r) => [r.base, r.state]),
      [
        ['main', 'created'],
        ['staging', 'created'],
      ],
    );
    assert.deepEqual(
      state.created.map((r) => r.base),
      ['main', 'staging'],
    );
    for (const pr of state.created) {
      assert.equal(pr.head, 'fix/checked-change');
      assert.ok(pr.body.includes(input.sha));
      assert.equal(pr.auto_merge, undefined);
    }
    assert.ok(!state.calls.some((c) => /\/(merge|reviews)(\?|$)/.test(c.path)));
  }
});
test('preserves existing PRs and their draft/review state instead of duplicating or editing them', async () => {
  const { input, state } = fixture();
  state.existing = { main: [{ number: 83, draft: true }], staging: [{ number: 84 }] };
  assert.deepEqual(await ensurePullRequests(input), [
    { base: 'main', state: 'existing', number: 83 },
    { base: 'staging', state: 'existing', number: 84 },
  ]);
  assert.equal(state.created.length, 0);
  assert.ok(state.calls.every((c) => !c.method));
});
test('skips bases that already contain the head or have no file changes', async () => {
  const { input, state } = fixture();
  state.compare = { main: { ahead_by: 0, files: [] }, staging: { ahead_by: 2, files: [] } };
  assert.deepEqual(
    (await ensurePullRequests(input)).map((r) => r.state),
    ['no-changes', 'no-changes'],
  );
  assert.equal(state.created.length, 0);
});
test('refuses unsuccessful, missing, skipped, running and ambiguous aggregate checks', async () => {
  for (const jobs of [
    [],
    [{ name: 'Required backend checks', status: 'completed', conclusion: 'failure' }],
    [{ name: 'Required backend checks', status: 'completed', conclusion: 'skipped' }],
    [{ name: 'Required backend checks', status: 'in_progress', conclusion: null }],
    Array.from({ length: 2 }, () => ({
      name: 'Required backend checks',
      status: 'completed',
      conclusion: 'success',
    })),
  ]) {
    const { input, state } = fixture();
    state.jobs = jobs;
    await assert.rejects(ensurePullRequests(input), /aggregate check/);
    assert.equal(state.created.length, 0);
  }
});
test('refuses forks, PR events, mismatched commits, unrelated workflows and failed runs', async () => {
  const changes = [
    { head_repository: { full_name: 'someone/fork' } },
    { event: 'pull_request' },
    { head_sha: 'b'.repeat(40) },
    { name: 'Unrelated check' },
    { path: '.github/workflows/other.yml' },
    { conclusion: 'failure' },
    { conclusion: 'cancelled' },
  ];
  for (const change of changes) {
    const { input, state } = fixture();
    Object.assign(state.run, change);
    await assert.rejects(ensurePullRequests(input));
    assert.equal(state.created.length, 0);
  }
});
test('refuses main/staging sources, dispatch events, unreviewed repositories and invalid identity inputs', async () => {
  for (const overrides of [
    { eventName: 'pull_request' },
    { eventName: 'workflow_dispatch' },
    { repository: 'someone/else' },
    { sha: 'short' },
    { runId: '' },
    { ref: 'refs/heads/other' },
  ]) {
    const { input, state } = fixture();
    await assert.rejects(ensurePullRequests({ ...input, ...overrides }));
    assert.equal(state.created.length, 0);
  }
  for (const branch of ['main', 'staging']) {
    const { input, state } = fixture();
    state.run.head_branch = branch;
    input.ref = `refs/heads/${branch}`;
    await assert.rejects(ensurePullRequests(input));
    assert.equal(state.created.length, 0);
  }
});
test('refuses a stale head both before opening a PR and between base targets', async () => {
  const first = fixture();
  first.state.head = 'b'.repeat(40);
  await assert.rejects(ensurePullRequests(first.input), /branch moved/);
  assert.equal(first.state.created.length, 0);
  const second = fixture();
  const api = second.input.api;
  second.input.api = async (path, options) => {
    const result = await api(path, options);
    if (options?.method === 'POST') second.state.head = 'b'.repeat(40);
    return result;
  };
  await assert.rejects(ensurePullRequests(second.input), /branch moved/);
  assert.equal(second.state.created.length, 1);
});
test('recovers a concurrent duplicate creation but exposes unrelated API failures', async () => {
  const { input, state } = fixture();
  state.failCreate = (body) => {
    state.existing[body.base] = [{ number: 90 }];
    throw Object.assign(new Error('duplicate'), { status: 422 });
  };
  assert.deepEqual(
    (await ensurePullRequests(input)).map((r) => r.state),
    ['existing', 'existing'],
  );
  const other = fixture();
  other.state.failCreate = () => {
    throw Object.assign(new Error('forbidden'), { status: 403 });
  };
  await assert.rejects(ensurePullRequests(other.input), /forbidden/);
});
test('requires complete evidence instead of treating malformed responses as a green run', async () => {
  for (const kind of ['jobs', 'comparison', 'pulls']) {
    const { input, state } = fixture();
    if (kind === 'jobs') state.jobs = null;
    if (kind === 'comparison') state.compare.main = { ahead_by: 1 };
    if (kind === 'pulls') state.existing.main = {};
    await assert.rejects(ensurePullRequests(input));
    assert.equal(state.created.length, 0);
  }
});
test('the GitHub API client bounds requests, refuses redirects and keeps upstream error bodies private', async () => {
  let seen;
  const api = githubApi('synthetic-token', async (url, options) => {
    seen = { url, options };
    return new Response('{"private":"synthetic-token"}', { status: 403 });
  });
  await assert.rejects(
    api('/repos/pappycoder/BelivrHQ-Backend/pulls'),
    (error) => error.status === 403 && !error.message.includes('synthetic-token'),
  );
  assert.equal(seen.url, 'https://api.github.com/repos/pappycoder/BelivrHQ-Backend/pulls');
  assert.equal(seen.options.redirect, 'error');
  assert.ok(seen.options.signal instanceof AbortSignal);
  await assert.rejects(api('https://attacker.example.org'), /Invalid GitHub API path/);
});
test('the post-check workflow uses repository PR permissions without deployment secrets or automatic merging', () => {
  const workflow = yaml.load(fs.readFileSync('.github/workflows/ci.yml', 'utf8'));
  const job = workflow.jobs['pull-requests'];
  assert.equal(job.needs, 'checks');
  assert.equal(
    job.if,
    "vars.AUTOMATIC_RELEASE_PRS == 'true' && github.event_name == 'push' && github.ref != 'refs/heads/main' && github.ref != 'refs/heads/staging'",
  );
  assert.deepEqual(job.permissions, {
    contents: 'read',
    actions: 'read',
    'pull-requests': 'write',
  });
  assert.equal(workflow.permissions['pull-requests'], undefined);
  assert.equal(
    job.steps.find((s) => s.uses?.startsWith('actions/checkout@')).with['persist-credentials'],
    false,
  );
  const create = job.steps.find((s) => s.run === 'node scripts/ci-pull-requests.cjs');
  assert.equal(create.env.GH_TOKEN, '${{ github.token }}');
  assert.equal(job.environment, undefined);
  assert.ok(!JSON.stringify(job).includes('secrets.'));
});
