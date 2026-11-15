#!/usr/bin/env node
require('ts-node').register({
  project: require('node:path').join(__dirname, '../tsconfig.scripts.json'),
});
const { main, EnvSyncError } = require('./lib/vercel-env');
try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(
    error instanceof EnvSyncError
      ? error.message
      : 'Environment sync stopped. Check local files and CLI setup. Values were not logged.',
  );
  process.exitCode = 1;
}
