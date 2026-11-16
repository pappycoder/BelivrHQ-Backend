const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const yaml = require('js-yaml');
const { spawnSync } = require('node:child_process');
const workflow = yaml.load(fs.readFileSync('.github/workflows/ci.yml', 'utf8'));
const release = workflow.jobs.prepare;
test('every validation is required and failures, cancellation or skips block deployment', () => {
  const checks = workflow.jobs.checks;
  assert.equal(checks.if, 'always()');
  const validations = Object.keys(workflow.jobs).filter((name) => !['checks', 'prepare', 'promote'].includes(name));
  assert.deepEqual([...checks.needs].sort(), validations.sort());
  assert.equal(release.needs, 'checks');
  const command = checks.steps[0].run;
  const script = command.slice(command.indexOf("'") + 1, command.lastIndexOf("'"));
  const run = (results) => spawnSync(process.execPath, ['-e', script], { env: { ...process.env, RESULTS: JSON.stringify(results) }, encoding: 'utf8' }).status;
  const passing = Object.fromEntries(validations.map((name) => [name, { result: 'success' }]));
  assert.equal(run(passing), 0);
  for (const name of validations) for (const result of ['failure', 'cancelled', 'skipped', undefined])
    assert.notEqual(run({ ...passing, [name]: { result } }), 0);
  for (const name of validations) assert.notEqual(workflow.jobs[name]['continue-on-error'], true);
});
test('only checked main/staging pushes deploy and releases cannot cancel active promotions', () => {
  assert.equal(release.if, "github.event_name == 'push' && (github.ref == 'refs/heads/main' || github.ref == 'refs/heads/staging')");
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
  for (const step of release.steps) if (step.run?.includes('npm ')) assert.equal(step.env?.VERCEL_TOKEN, undefined);
});
