const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluate } = require('../../scripts/lib/audit-policy.cjs');
const advisory = 'https://github.com/advisories/GHSA-rmxm-3fg6-px4f';
const node = 'node_modules/@hono/node-server';
const policy = [{ package: '@hono/node-server', advisory, version: '1.19.19', expires: '2026-12-16' }];
const report = () => ({ auditReportVersion: 2, metadata: { vulnerabilities: { total: 2 } }, vulnerabilities: {
  '@hono/node-server': { via: [{ url: advisory }], nodes: [node] },
  prisma: { via: ['@hono/node-server'], nodes: ['node_modules/prisma'] },
} });
test('allows only the documented installed and locked publisher backport and its parent chain', () => {
  assert.deepEqual(evaluate(report(), { [node]: '1.19.19' }, policy, '2026-11-16').blocked, []);
});
test('fails on changed versions, expired review, no review or an additional advisory', () => {
  for (const [versions, entries, today] of [[{ [node]: '1.19.18' }, policy, '2026-11-16'], [{ [node]: '1.19.19' }, policy, '2026-12-17'], [{ [node]: '1.19.19' }, [], '2026-11-16']])
    assert.equal(evaluate(report(), versions, entries, today).blocked.length, 2);
  const changed = report();changed.vulnerabilities['@hono/node-server'].via.push({ url: 'new-advisory' });
  assert.equal(evaluate(changed, { [node]: '1.19.19' }, policy, '2026-11-16').blocked.length, 2);
});
test('fails closed for malformed registry responses and unresolved advisory chains', () => {
  for (const input of [null, {}, { error: {} }, { auditReportVersion: 2, vulnerabilities: {} }]) assert.throws(() => evaluate(input, {}, []));
  const input = report();input.vulnerabilities.prisma.via = ['unknown'];
  assert.ok(evaluate(input, { [node]: '1.19.19' }, policy, '2026-11-16').blocked.includes('prisma'));
});
