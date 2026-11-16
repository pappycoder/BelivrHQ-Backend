#!/usr/bin/env node
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { evaluate } = require('./lib/audit-policy.cjs');
try {
  const result = spawnSync('npm', ['audit', '--json'], { encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || ![0, 1].includes(result.status)) throw new Error();
  const report = JSON.parse(result.stdout);
  const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
  const versions = {};
  for (const name of report.vulnerabilities?.['@hono/node-server']?.nodes || []) {
    if (name !== 'node_modules/@hono/node-server') continue;
    const installed = JSON.parse(fs.readFileSync(`${name}/package.json`, 'utf8')).version;
    if (lock.packages?.[name]?.version === installed) versions[name] = installed;
  }
  const policy = JSON.parse(fs.readFileSync('config/security/audit-exceptions.json', 'utf8'));
  const outcome = evaluate(report, versions, policy);
  console.log(JSON.stringify(outcome));
  if (outcome.blocked.length) process.exitCode = 1;
} catch {
  console.error('Dependency audit failed closed: inspect registry availability, lockfile and reviewed exception policy.');
  process.exitCode = 1;
}
