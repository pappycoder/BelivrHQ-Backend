#!/usr/bin/env node
const fs = require('node:fs');
const {
  settings,
  assertCurrentHead,
  assertReleaseMode,
  assertHostedReleaseMode,
  assertPreviewIsolation,
  prepare,
  promote,
  ReleaseError,
} = require('./lib/release-gate.cjs');

async function main() {
  settings(process.env);
  assertReleaseMode(JSON.parse(fs.readFileSync('vercel.json', 'utf8')));
  if (process.argv[2] === 'preflight') {
    assertCurrentHead(process.env);
    assertHostedReleaseMode(process.env);
    if (settings(process.env).environment === 'preview') assertPreviewIsolation(process.env);
    console.log('Release configuration and checked branch head verified.');
    return;
  }
  if (!['prepare', 'promote'].includes(process.argv[2])) throw new ReleaseError('Use preflight, prepare or promote.');
  fs.mkdirSync('.vercel', { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    '.vercel/project.json',
    JSON.stringify({ projectId: process.env.VERCEL_PROJECT_ID, orgId: process.env.VERCEL_ORG_ID }),
    { mode: 0o600 },
  );
  const manifestPath = '.ops/release-candidate.json';
  if (process.argv[2] === 'prepare') {
    const manifest = await prepare(process.env);
    fs.mkdirSync('.ops', { recursive: true, mode: 0o700 });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
    console.log('Candidate prepared without changing canonical domains.');
  } else {
    console.log(JSON.stringify(await promote(process.env, JSON.parse(fs.readFileSync(manifestPath, 'utf8')))));
  }
}
main().catch((error) => {
  console.error(
    error instanceof ReleaseError
      ? error.message
      : 'Backend release stopped; unexpected command output was suppressed. Inspect the candidate in Vercel.',
  );
  process.exitCode = 1;
});
