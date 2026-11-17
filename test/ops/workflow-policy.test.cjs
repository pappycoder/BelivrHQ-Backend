const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const yaml = require('js-yaml');
const { spawnSync } = require('node:child_process');
const workflow = yaml.load(fs.readFileSync('.github/workflows/ci.yml', 'utf8'));
const release = workflow.jobs.prepare;
test('Docker checks start the daemon and remain mandatory before building the runtime', () => {
  const steps = workflow.jobs['docker-context'].steps;
  const start = steps.findIndex((step) => step.run === 'sudo systemctl start docker');
  const check = steps.findIndex((step) => step.run === 'npm run ops:test:docker-context');
  const build = steps.findIndex((step) => step.run?.startsWith('docker build '));
  assert.ok(start >= 0 && start < check && check < build);
  assert.equal(steps[check].env.REQUIRE_DOCKER_TESTS, '1');
  for (const index of [start, check, build]) {
    assert.equal(steps[index]['continue-on-error'], undefined);
    assert.equal(steps[index].if, undefined);
  }
});
test('every validation is required and failures, cancellation or skips block deployment', () => {
  const checks = workflow.jobs.checks;
  assert.equal(checks.if, 'always()');
  const validations = Object.keys(workflow.jobs).filter(
    (name) => !['checks', 'prepare', 'promote', 'pull-requests'].includes(name),
  );
  assert.deepEqual([...checks.needs].sort(), validations.sort());
  assert.equal(release.needs, 'checks');
  require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'CommonJS' } });
  const config = require('../../jest.config.ts').default;
  assert.deepEqual(config.coverageThreshold.global, {
    branches: 80,
    functions: 80,
    lines: 80,
    statements: 80,
  });
  assert.ok(workflow.jobs.test.steps.some((step) => step.run?.includes('npm run test:cov')));
  assert.equal(JSON.parse(fs.readFileSync('test/jest-e2e.json', 'utf8')).maxWorkers, 1);
  const coverage = workflow.jobs.test.steps.find(
    (step) => step.with?.name === 'backend-unit-coverage',
  );
  assert.equal(coverage.if, 'always()');
  assert.equal(coverage.with.path, 'coverage/');
  assert.equal(coverage.with['retention-days'], 7);

  const command = checks.steps[0].run;
  const script = command.slice(command.indexOf("'") + 1, command.lastIndexOf("'"));
  const run = (results) =>
    spawnSync(process.execPath, ['-e', script], {
      env: { ...process.env, RESULTS: JSON.stringify(results) },
      encoding: 'utf8',
    }).status;
  const passing = Object.fromEntries(validations.map((name) => [name, { result: 'success' }]));
  assert.equal(run(passing), 0);
  for (const name of validations)
    for (const result of ['failure', 'cancelled', 'skipped', undefined])
      assert.notEqual(run({ ...passing, [name]: { result } }), 0);
  for (const name of validations) assert.notEqual(workflow.jobs[name]['continue-on-error'], true);
});
test('only checked main/staging pushes deploy and releases cannot cancel active promotions', () => {
  assert.equal(
    release.if,
    "github.event_name == 'push' && (github.ref == 'refs/heads/main' || github.ref == 'refs/heads/staging')",
  );
  assert.equal(workflow.on.pull_request_target, undefined);
  assert.deepEqual(release.strategy.matrix.profile, ['primary']);
  assert.equal(release.strategy['fail-fast'], false);
  assert.equal(release.concurrency['cancel-in-progress'], false);
  assert.ok(release.concurrency.group.includes('matrix.profile'));
  const steps = release.steps.map((step) => step.run || '');
  const preflight = steps.findIndex((step) => step.endsWith(' preflight'));
  const publish = steps.findIndex((step) => step.endsWith(' prepare'));
  assert.ok(preflight >= 0 && publish > preflight);
  assert.ok(!release.steps[preflight].if && !release.steps[publish].if);
  const migration = steps.findIndex((step) => step.includes('prisma migrate deploy'));
  if (migration >= 0) assert.ok(preflight < migration && migration < publish);
  assert.equal(JSON.parse(fs.readFileSync('vercel.json', 'utf8')).git.deploymentEnabled, false);
});

test('promotion waits for all enabled candidate preparation', () => {
  assert.equal(workflow.jobs.promote.needs, 'prepare');
  assert.equal(workflow.jobs.promote.if, release.if);
  assert.equal(workflow.jobs.promote.strategy['fail-fast'], false);
  assert.equal(workflow.jobs.promote.concurrency['cancel-in-progress'], false);
  assert.ok(!workflow.jobs.prepare.steps.some((step) => step.run?.endsWith(' promote')));
});

test('deployment credentials are limited to the release commands', () => {
  assert.equal(release.env.VERCEL_TOKEN, undefined);
  assert.equal(workflow.jobs.promote.env.VERCEL_TOKEN, undefined);
  const preflight = release.steps.find((step) => step.run?.endsWith(' preflight'));
  assert.ok(preflight.env.VERCEL_TOKEN);
  for (const step of release.steps)
    if (step.run?.includes('npm ')) assert.equal(step.env?.VERCEL_TOKEN, undefined);
});

test('release preparation checks out the immutable commit for detached Preview candidates', () => {
  const workflow = yaml.load(fs.readFileSync('.github/workflows/ci.yml', 'utf8'));
  const checkout = workflow.jobs.prepare.steps.find((step) =>
    step.uses?.startsWith('actions/checkout@'),
  );
  assert.equal(checkout.with.ref, '${{ github.sha }}');
});

test('build installation includes development tools despite production defaults', () => {
  const config = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));
  const steps = workflow.jobs['lint'].steps;
  const install = steps.find((step) => step.run === config.installCommand);
  assert.ok(install, 'CI must exercise the exact Vercel install command');
  assert.equal(install.env.NODE_ENV, 'production');
  assert.equal(install.env.NPM_CONFIG_OMIT, 'dev');
  assert.ok(steps.findIndex((step) => step.run === config.buildCommand) > steps.indexOf(install));
});
