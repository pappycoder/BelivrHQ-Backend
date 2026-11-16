#!/usr/bin/env node
const fs = require('node:fs');
const { settings, assertCurrentHead, publish, ReleaseError } = require('./lib/release-gate.cjs');

async function main() {
  settings(process.env);
  if (process.argv[2] === 'preflight') {
    assertCurrentHead(process.env);
    console.log('Release configuration and checked branch head verified.');
    return;
  }
  if (process.argv[2] !== 'publish') throw new ReleaseError('Use preflight or publish.');
  fs.mkdirSync('.vercel', { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    '.vercel/project.json',
    JSON.stringify({ projectId: process.env.VERCEL_PROJECT_ID, orgId: process.env.VERCEL_ORG_ID }),
    { mode: 0o600 },
  );
  console.log(JSON.stringify(await publish(process.env)));
}
main().catch((error) => {
  console.error(
    error instanceof ReleaseError
      ? error.message
      : 'Backend release stopped; unexpected command output was suppressed. Inspect the candidate in Vercel.',
  );
  process.exitCode = 1;
});
