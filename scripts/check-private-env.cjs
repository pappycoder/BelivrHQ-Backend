#!/usr/bin/env node
'use strict';
const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync, chmodSync } = require('node:fs');
const path = require('node:path');
function isPrivateEnvPath(file) {
  const normalized = file.replaceAll('\\', '/');
  const base = normalized.split('/').pop();
  if (base.endsWith('.env.example') || base === '.env.example') return false;
  return (
    base === '.env' ||
    base.startsWith('.env.') ||
    base.endsWith('.env') ||
    normalized.startsWith('.ops/') ||
    normalized.startsWith('.vercel/')
  );
}
function git(args, allowFailure = false) {
  const result = spawnSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0 && !allowFailure)
    throw new Error(
      'Cannot inspect Git state. No private env files should be committed or pushed.',
    );
  return result;
}
function checkPaths(files) {
  const blocked = [...new Set(files.filter(Boolean).filter(isPrivateEnvPath))];
  if (blocked.length)
    throw new Error(
      `Blocked private environment files: ${blocked.join(', ')}. Keep these files outside Git; commit placeholder-only examples instead.`,
    );
}
function checkOutgoing(input, remote = 'origin') {
  // Check the current index too, including files accidentally force-added past .gitignore.
  checkPaths(git(['ls-files', '-z']).stdout.split('\0'));
  const commits = new Set();
  for (const line of input.trim().split('\n').filter(Boolean)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 4 || ![fields[1], fields[3]].every((v) => /^[a-f0-9]{40,64}$/.test(v)))
      throw new Error('Cannot validate outgoing Git references.');
    const [, local, , upstream] = fields;
    if (/^0+$/.test(local)) continue;
    const remoteExists =
      !/^0+$/.test(upstream) && git(['cat-file', '-e', upstream], true).status === 0;
    const args = remoteExists
      ? ['rev-list', local, `^${upstream}`]
      : ['rev-list', local, '--not', `--remotes=${remote}`];
    for (const commit of git(args).stdout.trim().split('\n').filter(Boolean)) commits.add(commit);
  }
  for (const commit of commits)
    checkPaths(
      git([
        'diff-tree',
        '--root',
        '-m',
        '--no-commit-id',
        '--name-only',
        '--diff-filter=ACMR',
        '-r',
        '-z',
        commit,
      ]).stdout.split('\0'),
    );
}
function install() {
  const configured = git(['config', '--get', 'core.hooksPath'], true).stdout.trim();
  if (configured && configured !== '.githooks')
    throw new Error(
      'An existing hooks directory is configured. Integrate the private-env guards there before changing hooksPath.',
    );
  if (!configured) {
    for (const name of ['pre-commit', 'pre-push']) {
      const old = git(['rev-parse', '--git-path', `hooks/${name}`]).stdout.trim();
      if (existsSync(old))
        throw new Error(
          `An existing ${name} hook must be preserved; integrate this guard before changing hooksPath.`,
        );
    }
  }
  for (const name of ['pre-commit', 'pre-push']) chmodSync(path.join('.githooks', name), 0o755);
  git(['config', '--local', 'core.hooksPath', '.githooks']);
  console.log('Installed private-env commit and push guards for this clone.');
}
function main(args) {
  if (args[0] === '--install') return install();
  if (args[0] === '--push') checkOutgoing(readFileSync(0, 'utf8'), args[1] || 'origin');
  else if (args[0] === '--staged')
    checkPaths(
      git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).stdout.split('\0'),
    );
  else if (!args.length) checkPaths(git(['ls-files', '-z']).stdout.split('\0'));
  else throw new Error('Usage: env:git:check or env:git:install');
  console.log('Private env files are excluded from Git.');
}
module.exports = { isPrivateEnvPath, checkPaths, checkOutgoing, main };
if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
