'use strict';
// Explicit opt-in: real PostgreSQL plus a local HTTP fixture for Supabase Admin.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const core = require('../../scripts/ops/core.cjs');
const backend = require('../../scripts/ops/backend.cjs');
const root = path.resolve(__dirname, '../..');
const connection = process.env.OPS_TEST_DATABASE_URL;
if (!connection)
  throw new Error(
    'Set OPS_TEST_DATABASE_URL to a disposable local database containing test in its name.',
  );
const target = core.requireLocalDatabase({ DATABASE_URL: connection });
if (!/test/i.test(target.name))
  throw new Error('Operations integration tests require test in the database name.');

test(
  'operations against disposable PostgreSQL and local authentication HTTP fixture',
  { timeout: 120000 },
  async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'belivrhq-db-console-'));
    const startedAt = new Date();
    const migrationCount = fs
      .readdirSync(path.join(root, 'prisma/migrations'))
      .filter((name) =>
        fs.existsSync(path.join(root, 'prisma/migrations', name, 'migration.sql')),
      ).length;
    const users = new Map();
    let createdCount = 0,
      removedCount = 0;
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      let data = '';
      for await (const chunk of req) data += chunk;
      const body = data ? JSON.parse(data) : {};
      res.setHeader('Content-Type', 'application/json');
      if (req.headers.authorization !== 'Bearer local-fixture-service-key') {
        res.writeHead(401);
        res.end('{}');
        return;
      }
      if (url.pathname === '/auth/v1/admin/users' && req.method === 'POST') {
        const user = {
          id: randomUUID(),
          email: body.email,
          aud: 'authenticated',
          role: 'authenticated',
          created_at: new Date().toISOString(),
        };
        users.set(user.id, user);
        createdCount++;
        res.end(JSON.stringify(user));
        return;
      }
      if (url.pathname === '/auth/v1/admin/users' && req.method === 'GET') {
        res.end(JSON.stringify({ users: [...users.values()], total: users.size }));
        return;
      }
      const id = url.pathname.split('/').at(-1);
      if (req.method === 'DELETE') {
        users.delete(id);
        removedCount++;
        res.end('{}');
        return;
      }
      const user = users.get(id);
      if (!user) {
        res.writeHead(404);
        res.end(JSON.stringify({ message: 'not found' }));
        return;
      }
      if (req.method === 'PUT') user.banned_until = '2126-01-01T00:00:00Z';
      res.end(JSON.stringify(user));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const env = {
      ...process.env,
      DATABASE_URL: connection,
      SUPABASE_URL: `http://127.0.0.1:${server.address().port}`,
      SUPABASE_SERVICE_ROLE_KEY: 'local-fixture-service-key',
    };
    delete env.NODE_TEST_CONTEXT;
    if (process.env.OPS_TEST_PG_CONTAINER) {
      const container = process.env.OPS_TEST_PG_CONTAINER;
      if (!/^[a-zA-Z0-9_-]+$/.test(container)) throw new Error('Invalid test container name.');
      const tools = path.join(directory, 'pg-tools');
      fs.mkdirSync(tools);
      for (const command of ['pg_dump', 'pg_restore']) {
        const wrapper = `#!/usr/bin/env node
const fs=require('node:fs'),{spawnSync}=require('node:child_process');
const command=${JSON.stringify(command)},container=${JSON.stringify(container)};
const args=process.argv.slice(2);let input='ignore',output='inherit';
if(command==='pg_dump'&&args.includes('--file')){const index=args.indexOf('--file');output=fs.openSync(args[index+1],'w');args.splice(index,2);}
else if(command==='pg_restore'&&args.length&&fs.existsSync(args.at(-1))){input=fs.openSync(args.pop(),'r');}
const result=spawnSync('docker',['exec','-i','-e','PGDATABASE','-e','PGUSER','-e','PGPASSWORD',container,command,...args],{stdio:[input,output,'inherit'],env:process.env});
process.exit(result.status??1);
`;
        fs.writeFileSync(path.join(tools, command), wrapper, { mode: 0o700 });
      }
      env.OPS_PG_BIN_DIR = tools;
    }
    const environment = path.join(directory, 'ops.env');
    fs.writeFileSync(
      environment,
      [
        'DATABASE_URL',
        'SUPABASE_URL',
        'SUPABASE_SERVICE_ROLE_KEY',
        ...(env.OPS_PG_BIN_DIR ? ['OPS_PG_BIN_DIR'] : []),
      ]
        .map((k) => `${k}=${env[k]}`)
        .join('\n'),
      { mode: 0o600 },
    );
    const context = { root, env, file: environment };
    let db = backend.openDatabase(env);
    const auth = backend.openAuth(env);
    const run = (command, args, input = '') =>
      new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd: root, env });
        let stdout = '',
          stderr = '';
        child.stdout.on('data', (chunk) => {
          stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
          stderr += chunk;
        });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stdout, stderr }));
        child.stdin.end(input);
      });
    const base = {
      password: 'IsolatedTestOnly#123',
      firstName: 'Console',
      lastName: 'Test',
      phone: '',
      churchMode: 'new',
      churchId: '',
      churchName: 'Console Integration',
      authMode: 'new',
      authId: '',
    };
    let churchAdmin, superAdmin, snapshot;
    try {
      await t.test('seed reference grants only in the selected test database', async () => {
        const result = await run(path.join(root, 'node_modules/.bin/ts-node'), [
          '-P',
          'tsconfig.seed.json',
          'prisma/seed-permissions.ts',
        ]);
        assert.equal(result.code, 0, result.stderr);
        assert.equal(await db.role.count(), 10);
        await db.$executeRawUnsafe('CREATE SCHEMA IF NOT EXISTS auth');
        await db.$executeRawUnsafe(
          'CREATE TABLE IF NOT EXISTS auth.console_sentinel (id text PRIMARY KEY)',
        );
        await db.$executeRawUnsafe(
          "INSERT INTO auth.console_sentinel(id) VALUES ('identity-must-survive') ON CONFLICT DO NOTHING",
        );
      });
      await t.test(
        'interactive Bash creates a real church admin profile through local Supabase HTTP',
        async () => {
          const token = core.confirmation('admin-church', env);
          const input = `1\nchurch-admin@example.test\n${base.password}\n${base.password}\nConsole\nAdmin\n\n2\nConsole Integration\n${token}\n`;
          const result = await run(
            'bash',
            ['scripts/console.sh', '--env', environment, '--action', 'admin-church'],
            input,
          );
          assert.equal(result.code, 0, result.stderr);
          assert.equal((result.stdout + result.stderr).includes(base.password), false);
          churchAdmin = await db.profile.findFirst({
            where: { email: 'church-admin@example.test' },
          });
          assert.deepEqual(churchAdmin.role, ['church_admin']);
          assert.equal(churchAdmin.is_admin_hq, true);
          assert.ok(churchAdmin.branch_id);
          assert.ok(users.has(churchAdmin.user_id));
          assert.equal(createdCount, 1);
        },
      );
      await t.test(
        'super admin uses an existing church and the same HQ branch without changing existing roles',
        async () => {
          superAdmin = await backend.provisionAdmin(db, auth, {
            ...base,
            role: 'super_admin',
            email: 'super-admin@example.test',
            churchMode: 'existing',
            churchId: churchAdmin.church_id,
          });
          assert.equal(superAdmin.churchId, churchAdmin.church_id);
          assert.equal(superAdmin.branchId, churchAdmin.branch_id);
          assert.deepEqual((await db.profile.findUnique({ where: { id: churchAdmin.id } })).role, [
            'church_admin',
          ]);
        },
      );
      await t.test(
        'failed real SQL transaction rolls back church and compensates newly created auth identity',
        async () => {
          const before = await db.church.count();
          const failing = {
            role: db.role,
            profile: db.profile,
            church: db.church,
            $transaction: (fn, opts) =>
              db.$transaction(
                (tx) =>
                  fn({
                    church: tx.church,
                    branch: tx.branch,
                    auditLog: tx.auditLog,
                    profile: {
                      create: async () => {
                        throw new Error('forced after church insert');
                      },
                    },
                  }),
                opts,
              ),
          };
          await assert.rejects(
            backend.provisionAdmin(failing, auth, {
              ...base,
              role: 'church_admin',
              email: 'rollback@example.test',
            }),
            /newly created auth account was removed/,
          );
          assert.equal(await db.church.count(), before);
          assert.equal(
            [...users.values()].some((user) => user.email === 'rollback@example.test'),
            false,
          );
          assert.equal(removedCount, 1);
        },
      );
      await t.test(
        'orphan auth UUID can be linked explicitly without changing its password',
        async () => {
          const orphan = await auth.createUser({
            email: 'orphan@example.test',
            password: base.password,
            email_confirm: true,
          });
          const before = createdCount;
          await backend.provisionAdmin(db, auth, {
            ...base,
            role: 'church_admin',
            email: 'orphan@example.test',
            password: '',
            authMode: 'existing',
            authId: orphan.data.user.id,
            churchMode: 'existing',
            churchId: churchAdmin.church_id,
          });
          assert.equal(createdCount, before);
          assert.equal(await db.profile.count(), 3);
        },
      );
      await t.test(
        'external table references block clearing without cascading into other tables',
        async () => {
          await db.$executeRawUnsafe(
            'CREATE TABLE public.console_external (profile_id text REFERENCES profiles(id))',
          );
          try {
            await assert.rejects(backend.clearDatabase(db), /Unmanaged tables/);
            assert.equal(await db.profile.count(), 3);
          } finally {
            await db.$executeRawUnsafe('DROP TABLE public.console_external');
          }
        },
      );
      await t.test('schema reset refuses dependencies from protected schemas', async () => {
        await db.$executeRawUnsafe(
          'CREATE VIEW auth.console_profile_view AS SELECT id FROM public.profiles',
        );
        try {
          await assert.rejects(
            backend.assertNoExternalSchemaDependencies(db),
            /Objects outside public/,
          );
        } finally {
          await db.$executeRawUnsafe('DROP VIEW auth.console_profile_view');
        }
      });
      await t.test('backup uses restrictive permissions and rejects corruption', async () => {
        snapshot = await backend.backupDatabase(context);
        assert.equal(fs.statSync(snapshot).mode & 0o777, 0o600);
        await backend.verifyBackup(snapshot);
        assert.equal(fs.statSync(path.dirname(snapshot)).mode & 0o777, 0o700);
        const badRoot = path.join(directory, 'unsafe-backup-root');
        const outside = path.join(directory, 'outside-backups');
        fs.mkdirSync(badRoot);
        fs.mkdirSync(outside);
        fs.symlinkSync(outside, path.join(badRoot, '.ops'), 'dir');
        await assert.rejects(
          backend.backupDatabase({ ...context, root: badRoot }),
          /must not be symlinks/,
        );
        assert.deepEqual(fs.readdirSync(outside), []);
        const corrupted = path.join(directory, 'corrupted.dump');
        fs.copyFileSync(snapshot, corrupted);
        fs.copyFileSync(snapshot + '.json', corrupted + '.json');
        fs.appendFileSync(corrupted, 'tampered');
        await assert.rejects(backend.verifyBackup(corrupted), /verification failed/);
      });
      await t.test('failed mandatory backup prevents any clear operation', async () => {
        await assert.rejects(
          backend.destructive(
            { ...context, env: { ...env, OPS_PG_BIN_DIR: directory, PATH: directory } },
            db,
            'db-clear',
            [core.confirmation('db-clear', env)],
          ),
          /pg_dump|Backup\/destructive action was refused/,
        );
        assert.equal(await db.profile.count(), 3);
      });
      await t.test(
        'internal clear utility preserves migration journal and auth schema',
        async () => {
          await backend.destructive(context, db, 'db-clear', [core.confirmation('db-clear', env)]);
          assert.equal(await db.profile.count(), 0);
          assert.equal(await db.role.count(), 0);
          const history = await db.$queryRawUnsafe(
            'SELECT count(*)::int AS count FROM _prisma_migrations WHERE finished_at IS NOT NULL',
          );
          assert.equal(history[0].count, migrationCount);
          assert.equal(
            (
              await db.$queryRawUnsafe('SELECT count(*)::int AS count FROM auth.console_sentinel')
            )[0].count,
            1,
          );
        },
      );
      await t.test(
        'internal restore utility recovers profiles, branch scope and roles atomically',
        async () => {
          await backend.destructive(context, db, 'db-restore', [
            core.confirmation('db-restore', env),
            snapshot,
          ]);
          assert.equal(await db.profile.count(), 3);
          assert.equal(await db.role.count(), 10);
          assert.equal(
            (await db.profile.findUnique({ where: { id: churchAdmin.id } })).branch_id,
            churchAdmin.branch_id,
          );
          assert.equal(
            (
              await db.$queryRawUnsafe('SELECT count(*)::int AS count FROM auth.console_sentinel')
            )[0].count,
            1,
          );
        },
      );
      await t.test(
        'demo retirement bans only demo identities and revokes their backend approval',
        async () => {
          const demo = await auth.createUser({
            email: 'temporary@churchos.dev',
            password: base.password,
            email_confirm: true,
          });
          const p = await db.profile.create({
            data: {
              church_id: churchAdmin.church_id,
              branch_id: churchAdmin.branch_id,
              user_id: demo.data.user.id,
              first_name: 'Demo',
              last_name: 'Only',
            },
          });
          await db.verifiedMfaSession.create({
            data: {
              user_id: demo.data.user.id,
              session_id: 'fixture-session',
              revision: 'test',
              expires_at: new Date(Date.now() + 60000),
            },
          });
          const result = await backend.retireDemoUsers(db, auth);
          assert.equal(result.disabledDemoAccounts, 1);
          assert.equal((await db.profile.findUnique({ where: { id: p.id } })).status, 'inactive');
          assert.equal(await db.verifiedMfaSession.count(), 0);
          assert.equal(users.get(demo.data.user.id).banned_until, '2126-01-01T00:00:00Z');
          assert.equal(users.get(churchAdmin.user_id).banned_until, undefined);
        },
      );
      await t.test(
        'confirmed local reset reapplies all migrations without touching auth schema or seeding demos',
        async () => {
          await backend.destructive(context, db, 'db-reset', [core.confirmation('db-reset', env)]);
          await db.$disconnect();
          db = backend.openDatabase(env);
          assert.equal(await db.profile.count(), 0);
          assert.equal(await db.role.count(), 0);
          assert.equal(
            (
              await db.$queryRawUnsafe(
                'SELECT count(*)::int AS count FROM _prisma_migrations WHERE finished_at IS NOT NULL',
              )
            )[0].count,
            migrationCount,
          );
          assert.equal(
            (
              await db.$queryRawUnsafe('SELECT count(*)::int AS count FROM auth.console_sentinel')
            )[0].count,
            1,
          );
        },
      );
    } finally {
      await db.$disconnect();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(directory, { recursive: true, force: true });
      const backups = path.join(root, '.ops/backups');
      if (fs.existsSync(backups))
        for (const file of fs.readdirSync(backups).filter((file) => file.endsWith('.dump.json'))) {
          const metadata = JSON.parse(fs.readFileSync(path.join(backups, file), 'utf8'));
          if (metadata.targetId === target.id && new Date(metadata.createdAt) >= startedAt) {
            fs.rmSync(path.join(backups, file.slice(0, -5)), { force: true });
            fs.rmSync(path.join(backups, file));
          }
        }
    }
  },
);
