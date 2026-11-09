'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const core = require('../../scripts/ops/core.cjs');
const actions = require('../../scripts/ops/actions.cjs');
const web = require('../../package.json').name === 'belivrhq-web';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'belivrhq-ops-test-'));
const environment = path.join(directory, 'selected env');
const local = {
  DATABASE_URL: 'postgresql://operator:p%40ss@127.0.0.1:55439/belivrhq_console_test',
  SUPABASE_URL: 'http://127.0.0.1:54321',
};
fs.writeFileSync(
  environment,
  Object.entries(local)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n'),
  { mode: 0o600 },
);
test.after(() => fs.rmSync(directory, { recursive: true, force: true }));
function cleanEnvironment(extra = {}) {
  const result = { ...process.env, ...extra };
  delete result.NODE_TEST_CONTEXT;
  return result;
}
function consoleRun(args, input = '', env = {}) {
  return spawnSync('bash', [path.join(root, 'scripts/console.sh'), '--env', environment, ...args], {
    cwd: directory,
    input,
    encoding: 'utf8',
    env: cleanEnvironment(env),
    timeout: 15000,
  });
}

test('help, exact action inventory and EOF work from another directory', () => {
  assert.equal(consoleRun(['--help']).status, 0);
  const result = consoleRun(['--list']);
  assert.equal(result.status, 0);
  assert.deepEqual(
    result.stdout
      .trim()
      .split('\n')
      .map((line) => line.split('\t')[0]),
    web
      ? ['dev', 'build', 'test']
      : ['dev', 'build', 'test', 'migration-deploy', 'admin-super', 'admin-church', 'subscription-switch'],
  );
  assert.equal(consoleRun([]).status, 0);
});
test('every retained action has a safe dry-run and direct menu entry', () => {
  for (const [index, action] of actions.entries()) {
    const single = consoleRun(['--dry-run', '--action', action.id]);
    assert.equal(single.status, 0, single.stderr);
    assert.match(single.stdout, /DRY RUN/);
    const menu = consoleRun(['--dry-run'], `${index + 1}\n\nq\n`);
    assert.equal(menu.status, 0, menu.stderr);
    assert.ok(menu.stdout.includes(`DRY RUN: ${action.label}`));
    assert.equal(menu.stdout.includes('[5] Tools'), false);
    assert.match(menu.stdout, /Bye!/);
  }
});
test('removed commands and invalid arguments are rejected', () => {
  for (const action of [
    'start',
    'install',
    'doctor',
    'permissions-seed',
    'db-clear',
    'db-reset',
    'db-restore',
    'worker',
    'open-backend',
    'cache-clean',
    ...(web ? ['migration-deploy', 'admin-super', 'admin-church', 'subscription-switch'] : []),
  ]) {
    assert.notEqual(consoleRun(['--action', action]).status, 0, action);
  }
  for (const args of [['--action'], ['--manager', 'bad'], ['--arbitrary']])
    assert.notEqual(consoleRun(args).status, 0);
});
test('dotenv is parsed as data and the selected file takes precedence', () => {
  const file = path.join(directory, 'untrusted.env');
  const marker = path.join(directory, 'must-not-exist');
  fs.writeFileSync(file, `DATABASE_URL=${local.DATABASE_URL}\nMARKER=$(touch ${marker})\n`);
  const ctx = core.loadEnvironment(root, file, { DATABASE_URL: 'postgresql://remote/production' });
  assert.equal(ctx.env.DATABASE_URL, local.DATABASE_URL);
  assert.equal(ctx.env.MARKER, `$(touch ${marker})`);
  assert.equal(fs.existsSync(marker), false);
});
test('build/test/dev dispatch correctly; failures return to the menu', () => {
  const bin = path.join(directory, 'command-bin');
  const log = path.join(directory, 'commands');
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, 'npm'),
    '#!/usr/bin/env bash\nprintf "%s|%s\\n" "$*" "$NODE_ENV" >> "$OPS_COMMAND_LOG"\nexit "${OPS_COMMAND_EXIT:-0}"\n',
    { mode: 0o700 },
  );
  const env = { PATH: bin + path.delimiter + process.env.PATH, OPS_COMMAND_LOG: log };
  assert.equal(consoleRun(['--action', 'build'], '', env).status, 0);
  assert.equal(consoleRun(['--action', 'test'], '', env).status, 0);
  assert.equal(consoleRun(['--action', 'dev'], web ? '3007\n' : '', env).status, 0);
  assert.equal(
    fs.readFileSync(log, 'utf8'),
    web
      ? 'run build|production\nrun test|test\nrun dev -- --hostname 127.0.0.1 --port 3007|development\n'
      : 'run build|production\nrun test -- --runInBand|test\nrun start:dev|development\n',
  );
  assert.equal(
    consoleRun(['--action', 'build'], '', { ...env, OPS_COMMAND_EXIT: '27' }).status,
    27,
  );
  const menu = consoleRun([], '2\n\nq\n', { ...env, OPS_COMMAND_EXIT: '27' });
  assert.equal(menu.status, 0);
  assert.match(menu.stdout + menu.stderr, /Command exited 27/);
  assert.match(menu.stdout, /Bye!/);
});
if (!web)
  test('migrations and account creation cancel before touching services', () => {
    for (const action of ['migration-deploy', 'admin-super', 'admin-church', 'subscription-switch'])
      assert.equal(consoleRun(['--action', action], '').status, 130);
    assert.equal(consoleRun(['--action', 'migration-deploy'], 'wrong\n').status, 130);
  });
if (web)
  test('development port rejects invalid input', () => {
    for (const port of ['0', '65536', '3000;touch marker'])
      assert.notEqual(consoleRun(['--action', 'dev'], port + '\n').status, 0);
  });
if (!web)
  test('migration deployment backs up first and stops if backup fails', () => {
    const program = `
    const core = require(process.argv[1] + '/scripts/ops/core.cjs');
    const backend = require(process.argv[1] + '/scripts/ops/backend.cjs');
    const envFile = process.argv[2]; const manager = process.argv[3];
    process.argv = [process.execPath, 'fixture', envFile, 'npm', 'run', 'migration-deploy'];
    const ctx = core.loadEnvironment(process.cwd(), envFile);
    core.readFields = () => [core.confirmation('migration-deploy', ctx.env)];
    backend.backupDatabase = async () => { console.log('BACKUP'); if (manager === 'fail') throw new Error('fixture backup failed'); };
    core.child = (_command, args) => console.log('PRISMA ' + args.join(' '));
    require('./scripts/ops/cli.cjs').main().catch(error => { console.error(error.message); process.exitCode = 1; });
  `;
    for (const mode of ['pass', 'fail']) {
      const result = spawnSync(process.execPath, ['-e', program, root, environment, mode], {
        cwd: root,
        encoding: 'utf8',
        env: cleanEnvironment(),
      });
      assert.equal(result.status, mode === 'pass' ? 0 : 1, result.stderr);
      assert.match(result.stdout, /BACKUP/);
      assert.equal(result.stdout.includes('PRISMA migrate deploy'), mode === 'pass');
      if (mode === 'pass')
        assert.ok(result.stdout.indexOf('BACKUP') < result.stdout.indexOf('PRISMA'));
    }
  });
test('foreground Ctrl-C propagates and exits the single action', { timeout: 8000 }, async () => {
  const bin = path.join(directory, 'signal-bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, 'npm'),
    '#!/usr/bin/env bash\nexec node -e "console.log(\'OPS_RUNNING\');setInterval(()=>{},1000)"\n',
    { mode: 0o700 },
  );
  const child = spawn(
    'bash',
    [path.join(root, 'scripts/console.sh'), '--env', environment, '--action', 'dev'],
    { detached: true, env: cleanEnvironment({ PATH: bin + path.delimiter + process.env.PATH }) },
  );
  let signalled = false;
  const done = new Promise((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );
  const timer = setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {}
  }, 6000);
  try {
    child.stdout.on('data', (chunk) => {
      if (!signalled && chunk.toString().includes('OPS_RUNNING')) {
        signalled = true;
        process.kill(-child.pid, 'SIGINT');
      }
    });
    child.stdin.end(web ? '3000\n' : '');
    const result = await done;
    assert.equal(signalled, true);
    assert.ok(result.code === 130 || result.signal === 'SIGINT', JSON.stringify(result));
  } finally {
    clearTimeout(timer);
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {}
  }
});
if (!web) {
  const backend = require('../../scripts/ops/backend.cjs');
  test('password input is never echoed or passed in command arguments', () => {
    const password = 'ConsoleOnlySecret#123';
    const token = core.confirmation('admin-super', local);
    const result = consoleRun(
      ['--action', 'admin-super'],
      `1\nadmin@example.test\n${password}\n${password}\nFirst\nLast\n\n2\nTest Church\n${token}\n`,
      { SUPABASE_SERVICE_ROLE_KEY: '' },
    );
    assert.notEqual(result.status, 0);
    assert.equal((result.stdout + result.stderr).includes(password), false);
    assert.match(result.stderr, /SUPABASE_SERVICE_ROLE_KEY/);
    const traced = spawnSync(
      'bash',
      [
        '-x',
        path.join(root, 'scripts/console.sh'),
        '--env',
        environment,
        '--action',
        'admin-super',
      ],
      {
        cwd: directory,
        input: `1\nadmin@example.test\n${password}\n${password}\nFirst\nLast\n\n2\nTest Church\n${token}\n`,
        encoding: 'utf8',
        env: cleanEnvironment({ SUPABASE_SERVICE_ROLE_KEY: '' }),
      },
    );
    assert.equal((traced.stdout + traced.stderr).includes(password), false);
  });
  const input = {
    role: 'church_admin',
    email: 'new@example.test',
    password: 'StrongOperator#123',
    firstName: 'First',
    lastName: 'Last',
    phone: '',
    churchMode: 'new',
    churchId: '',
    churchName: 'New Church',
    authMode: 'new',
    authId: '',
  };
  function fakeServices(fail = false) {
    const calls = [];
    const tx = {
      church: { create: async () => ({ id: 'church-a' }) },
      branch: {
        findFirst: async () => null,
        create: async (arg) => {
          calls.push(['branch', arg]);
          return { id: 'branch-a' };
        },
      },
      profile: {
        create: async (arg) => {
          calls.push(['profile', arg]);
          if (fail) throw new Error('sensitive-provider-message');
          return { id: 'profile-a' };
        },
      },
      auditLog: {
        create: async (arg) => {
          calls.push(['audit', arg]);
          return {};
        },
      },
    };
    const db = {
      role: { findFirst: async () => ({ _count: { permissions: 10 } }) },
      profile: { findFirst: async () => null, findUnique: async () => null },
      $transaction: async (fn) => fn(tx),
    };
    const auth = {
      createUser: async () => {
        calls.push(['auth-create']);
        return { data: { user: { id: 'auth-a' } } };
      },
      deleteUser: async (id) => {
        calls.push(['auth-delete', id]);
        return {};
      },
    };
    return { db, auth, calls };
  }
  test('admin creation uses exact selected role, branch/HQ scope and secret-free audit', async () => {
    for (const role of ['super_admin', 'church_admin']) {
      const { db, auth, calls } = fakeServices();
      const result = await backend.provisionAdmin(db, auth, { ...input, role });
      assert.equal(result.role, role);
      const data = calls.find((c) => c[0] === 'profile')[1].data;
      assert.deepEqual(data.role, [role]);
      assert.equal(data.branch_id, 'branch-a');
      assert.equal(data.is_admin_hq, true);
      assert.equal(JSON.stringify(calls).includes(input.password), false);
    }
  });
  test('failed profile transaction compensates only newly created auth identity', async () => {
    const { db, auth, calls } = fakeServices(true);
    await assert.rejects(
      backend.provisionAdmin(db, auth, input),
      /newly created auth account was removed/,
    );
    assert.deepEqual(calls.at(-1), ['auth-delete', 'auth-a']);
  });
  test('existing auth/profile cannot be silently promoted or have credentials reset', async () => {
    const { db, auth, calls } = fakeServices();
    db.profile.findFirst = async () => ({ id: 'already-profiled' });
    await assert.rejects(
      backend.provisionAdmin(db, auth, input),
      /Existing roles are never changed/,
    );
    assert.equal(calls.length, 0);
    const second = fakeServices();
    second.auth.getUserById = async () => ({
      data: { user: { id: '00000000-0000-4000-8000-000000000001', email: input.email } },
    });
    second.db.profile.findUnique = async () => ({ id: 'existing-profile' });
    await assert.rejects(
      backend.provisionAdmin(second.db, second.auth, {
        ...input,
        authMode: 'existing',
        authId: '00000000-0000-4000-8000-000000000001',
      }),
      /automatic role promotion is refused/,
    );
    assert.equal(second.calls.length, 0);
  });
  test('existing auth identity is retained if orphan-link database provisioning fails', async () => {
    const { db, auth, calls } = fakeServices(true);
    auth.getUserById = async () => ({
      data: { user: { id: '00000000-0000-4000-8000-000000000001', email: input.email } },
    });
    await assert.rejects(
      backend.provisionAdmin(db, auth, {
        ...input,
        authMode: 'existing',
        authId: '00000000-0000-4000-8000-000000000001',
      }),
    );
    assert.equal(
      calls.some((c) => c[0] === 'auth-delete' || c[0] === 'auth-create'),
      false,
    );
  });
  test('permission invalidation removes only perms keys across cursor pages', async () => {
    const deleted = [];
    let page = 0;
    const client = {
      scan: async () =>
        ++page === 1 ? ['3', ['perms:v20:one', 'unrelated:key']] : ['0', ['perms:v19:two']],
      del: async (...keys) => {
        deleted.push(...keys);
        return keys.length;
      },
    };
    const result = await backend.clearPermissionCache({ REDIS_URL: 'redis://localhost' }, client);
    assert.equal(result.deletedPermissionKeys, 2);
    assert.deepEqual(deleted, ['perms:v20:one', 'perms:v19:two']);
  });
  test('backup corruption and incorrect confirmation prevent destructive execution', async () => {
    const file = path.join(directory, 'corrupt.dump');
    fs.writeFileSync(file, 'not-a-backup');
    fs.writeFileSync(
      file + '.json',
      JSON.stringify({ version: 1, schema: 'public', sha256: 'bad' }),
    );
    await assert.rejects(backend.verifyBackup(file), /verification failed/);
    await assert.rejects(
      backend.destructive({ env: local }, {}, 'db-clear', ['wrong']),
      /Nothing was changed/,
    );
  });
}
