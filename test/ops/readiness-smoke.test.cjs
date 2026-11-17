const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixtureUrl } = require('../../scripts/readiness-smoke.cjs');

test('native smoke tests refuse hosted services and non-test databases before starting consumers', () => {
  for (const url of [
    'postgresql://user@production.supabase.co:5432/postgres',
    'postgresql://localhost:5432/application',
    'postgresql://localhost/test',
    'https://localhost:5432/test',
  ])
    assert.throws(() => fixtureUrl(url, 'database'));
  for (const url of [
    'rediss://provider.example:6379',
    'redis://127.0.0.1',
    'https://127.0.0.1:6379',
  ])
    assert.throws(() => fixtureUrl(url, 'redis'));
  assert.equal(
    fixtureUrl('postgresql://localhost:5432/disposable_test', 'database'),
    'postgresql://localhost:5432/disposable_test',
  );
  assert.equal(fixtureUrl('redis://127.0.0.1:54321', 'redis'), 'redis://127.0.0.1:54321');
});
