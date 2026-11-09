'use strict';
// Node-only operations support. Never imported by the browser application.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseEnv } = require('node:util');
const { spawnSync } = require('node:child_process');

class ConsoleError extends Error {}
function loadEnvironment(root, file, inherited = process.env) {
  if (typeof parseEnv !== 'function') throw new ConsoleError('Use Node.js 20.19+ or 22.12+.');
  const resolved = path.resolve(file);
  const selected = fs.existsSync(resolved) ? parseEnv(fs.readFileSync(resolved, 'utf8')) : {};
  return {
    root,
    file: resolved,
    exists: fs.existsSync(resolved),
    env: { ...inherited, ...selected },
  };
}
function databaseTarget(env) {
  let url;
  try {
    url = new URL(env.DATABASE_URL);
  } catch {
    throw new ConsoleError('Set a valid DATABASE_URL in the selected environment file.');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol))
    throw new ConsoleError('DATABASE_URL must use PostgreSQL.');
  if (url.searchParams.has('schema') && url.searchParams.get('schema') !== 'public')
    throw new ConsoleError('Operations support the public application schema only.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!host || !name) throw new ConsoleError('DATABASE_URL needs a host and database name.');
  const label = `${host}:${url.port || '5432'}/${name} (public)`;
  const id = crypto.createHash('sha256').update(label).digest('hex').slice(0, 12);
  return { url, host, name, label, id };
}
function requireLocalDatabase(env) {
  const target = databaseTarget(env);
  if (
    !['localhost', '127.0.0.1', '::1'].includes(target.host) ||
    !/(?:test|dev|local)/i.test(target.name)
  ) {
    throw new ConsoleError(
      'Schema reset, migration development and demo seeding require a local database named with test, dev or local.',
    );
  }
  return target;
}
function publicUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ConsoleError('Enter a valid HTTP(S) URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new ConsoleError('Use an HTTP(S) URL without embedded credentials.');
  return url;
}
function confirmation(action, env) {
  const target = databaseTarget(env);
  const extra =
    action.startsWith('admin-') || action === 'demo-retire'
      ? publicUrl(env.SUPABASE_URL).origin
      : '';
  const id = extra
    ? crypto
        .createHash('sha256')
        .update(target.id + '\n' + extra)
        .digest('hex')
        .slice(0, 12)
    : target.id;
  return `${action.toUpperCase()} ${id}`;
}
function assertConfirmation(action, env, answer) {
  if (answer !== confirmation(action, env))
    throw new ConsoleError(
      'Confirmation does not match the selected database. Nothing was changed.',
    );
}
function child(command, args, context, options = {}) {
  // Confirmations arrive through a pipe; interactive children (Prisma dev,
  // npm prompts) still need the operator's controlling terminal afterwards.
  let terminal;
  if (!process.stdin.isTTY && !options.stdio) {
    try {
      terminal = fs.openSync('/dev/tty', 'r');
    } catch {
      /* Non-interactive callers retain stdin. */
    }
  }
  let result;
  try {
    result = spawnSync(command, args, {
      cwd: context.root,
      env: context.env,
      stdio: terminal === undefined ? 'inherit' : [terminal, 'inherit', 'inherit'],
      ...options,
      shell: false,
    });
  } finally {
    if (terminal !== undefined) fs.closeSync(terminal);
  }
  if (result.error)
    throw new ConsoleError(
      `Could not start ${path.basename(command)}. Check that it is installed.`,
    );
  if (result.status !== 0) {
    const error = new ConsoleError(
      `${path.basename(command)} failed (${result.signal || result.status}).`,
    );
    error.exitCode = result.signal === 'SIGINT' ? 130 : result.status || 1;
    throw error;
  }
  return result;
}
function managerCommands(manager) {
  if (!['npm', 'pnpm'].includes(manager))
    throw new ConsoleError('Package manager must be npm or pnpm.');
  return {
    script: (name, args = []) => [
      manager,
      ...(manager === 'npm'
        ? ['run', name, ...(args.length ? ['--', ...args] : [])]
        : ['run', name, ...args]),
    ],
    install: [
      manager,
      ...(manager === 'npm' ? ['ci', '--include=dev'] : ['install', '--frozen-lockfile']),
    ],
  };
}
function requireLock(root, manager) {
  if (!fs.existsSync(path.join(root, manager === 'npm' ? 'package-lock.json' : 'pnpm-lock.yaml')))
    throw new ConsoleError(
      `No ${manager} lockfile. Select the matching package manager; lockfiles are never created implicitly.`,
    );
}
function initEnvironment(context, example) {
  if (!fs.existsSync(path.dirname(context.file)))
    throw new ConsoleError('The destination directory does not exist.');
  try {
    fs.copyFileSync(path.join(context.root, example), context.file, fs.constants.COPYFILE_EXCL);
  } catch (error) {
    if (error.code === 'EEXIST')
      throw new ConsoleError('Environment file already exists; it was not overwritten.');
    throw error;
  }
  fs.chmodSync(context.file, 0o600);
  console.log(
    'Created environment template with mode 0600. Edit its values before connecting to services.',
  );
}
async function checkHealth(raw, proxy = false, timeoutMs = 10000) {
  const base = publicUrl(raw);
  const prefix = base.pathname.replace(/\/$/, '');
  const endpoint = prefix.endsWith('/health')
    ? prefix
    : `${prefix}${prefix.endsWith('/api/v1') ? '' : '/api/v1'}/health`;
  const url = new URL(proxy ? '/api/backend/health' : endpoint, base.origin);
  const headers = proxy
    ? { origin: base.origin, 'x-belivrhq-client': 'web', 'sec-fetch-site': 'same-origin' }
    : {};
  let response;
  try {
    response = await fetch(url, {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new ConsoleError(
      'Health request failed or exceeded 10 seconds. No service configuration was changed.',
    );
  }
  const body = await response.json().catch(() => ({}));
  const data = body.data || body;
  console.log(
    JSON.stringify(
      {
        url: url.origin + url.pathname,
        httpStatus: response.status,
        status: data.status,
        services: data.services,
        queues: data.queues,
      },
      null,
      2,
    ),
  );
  if (!response.ok || data.status !== 'healthy')
    throw new ConsoleError('Health is not confirmed healthy. Inspect API/Redis/worker logs.');
}
function readFields() {
  const buffer = fs.readFileSync(0);
  if (buffer.length > 64 * 1024) throw new ConsoleError('Input is too large.');
  const text = buffer.toString('utf8');
  if (!text.endsWith('\0'))
    throw new ConsoleError('Incomplete console input; operation cancelled.');
  return text.slice(0, -1).split('\0');
}
function safeMessage(error) {
  return error instanceof ConsoleError
    ? error.message
    : 'Operation failed. Check connectivity, permissions and service configuration; provider details were suppressed to protect secrets.';
}
module.exports = {
  ConsoleError,
  loadEnvironment,
  databaseTarget,
  requireLocalDatabase,
  publicUrl,
  confirmation,
  assertConfirmation,
  child,
  managerCommands,
  requireLock,
  initEnvironment,
  checkHealth,
  readFields,
  safeMessage,
};
