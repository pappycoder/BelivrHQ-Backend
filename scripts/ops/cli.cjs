#!/usr/bin/env node
'use strict';
const path = require('node:path');
const core = require('./core.cjs');
const actions = require('./actions.cjs');
const root = path.resolve(__dirname, '../..');
const web = require(path.join(root, 'package.json')).name === 'belivrhq-web';
const [file, manager, mode, action] = process.argv.slice(2);
function definition(id) {
  const item = actions.find((entry) => entry.id === id);
  if (!item) throw new core.ConsoleError('Unknown action. Use --list to see supported actions.');
  return item;
}
function commands(item, _ctx, port = '3000') {
  const pm = core.managerCommands(manager);
  switch (item.id) {
    case 'dev':
      return [
        pm.script(
          web ? 'dev' : 'start:dev',
          web ? ['--hostname', '127.0.0.1', '--port', port] : [],
        ),
      ];
    case 'build':
      return [pm.script('build')];
    case 'test':
      return [pm.script('test', web ? [] : ['--runInBand'])];
    case 'migration-deploy':
      return [[path.join(root, 'node_modules/.bin/prisma'), 'migrate', 'deploy']];
    default:
      return [];
  }
}
async function main() {
  if (mode === 'list') {
    for (const item of actions) console.log(`${item.id}\t${item.label}`);
    return;
  }
  const item = definition(action);
  const ctx = core.loadEnvironment(root, file);
  core.managerCommands(manager);
  if (mode === 'input') {
    console.log(item.input || 'none');
    return;
  }
  if (mode === 'token') {
    console.log(core.confirmation(action, ctx.env));
    return;
  }
  if (mode === 'plan') {
    console.log(
      `DRY RUN: ${item.label}\nEnvironment: ${ctx.file}\nNo commands, network requests or mutations will run.`,
    );
    for (const command of commands(item, ctx))
      console.log(command.map((arg) => JSON.stringify(arg)).join(' '));
    if (item.input === 'confirm')
      console.log('Requires target confirmation and a verified database backup before migrations.');
    if (item.input === 'admin')
      console.log('Requires target confirmation and hidden password input.');
    if (item.input === 'subscription')
      console.log(
        'Prompts for the user email, plan and cycle, then requires target confirmation before writing.',
      );
    return;
  }
  if (mode === 'preview') {
    const target = core.databaseTarget(ctx.env);
    console.log(`Environment: ${ctx.file}\nDatabase: ${target.label}`);
    if (action.startsWith('admin-'))
      console.log(`Auth project: ${core.publicUrl(ctx.env.SUPABASE_URL).origin}`);
    return;
  }
  if (mode !== 'run') throw new core.ConsoleError('Unknown console operation.');
  const fields = item.input && item.input !== 'none' ? core.readFields() : [];
  if (
    item.input === 'port' &&
    (!/^\d+$/.test(fields[0] || '') || Number(fields[0]) < 1 || Number(fields[0]) > 65535)
  )
    throw new core.ConsoleError('Port must be between 1 and 65535.');
  if (['confirm', 'admin', 'subscription'].includes(item.input))
    core.assertConfirmation(action, ctx.env, fields[0]);
  if (item.input === 'admin') {
    const backend = require('./backend.cjs');
    const [
      ,
      email,
      password,
      firstName,
      lastName,
      phone,
      churchMode,
      churchId,
      churchName,
      authMode,
      authId,
    ] = fields;
    const input = {
      email,
      password,
      firstName,
      lastName,
      phone,
      churchMode,
      churchId,
      churchName,
      authMode,
      authId,
      role: action === 'admin-super' ? 'super_admin' : 'church_admin',
    };
    backend.validateAdmin(input);
    const auth = backend.openAuth(ctx.env);
    const db = backend.openDatabase(ctx.env);
    try {
      console.log(await backend.provisionAdmin(db, auth, input));
      console.log('Account created. Password was not printed or saved.');
    } finally {
      await db.$disconnect();
    }
    return;
  }
  if (item.input === 'subscription') {
    const backend = require('./backend.cjs');
    const [, email, plan, cycle, members, staff, locations] = fields;
    const input = { email, plan, cycle, members, staff, locations };
    backend.validateSubscriptionSwitch(input);
    const db = backend.openDatabase(ctx.env);
    try {
      console.log(await backend.switchSubscriptionByEmail(db, input));
    } finally {
      await db.$disconnect();
    }
    return;
  }
  if (action === 'migration-deploy') await require('./backend.cjs').backupDatabase(ctx);
  const lifecycle = action === 'dev' ? 'development' : action === 'test' ? 'test' : 'production';
  for (const step of commands(item, ctx, fields[0] || '3000')) {
    console.log('$ ' + step.map((arg) => JSON.stringify(arg)).join(' '));
    core.child(step[0], step.slice(1), { ...ctx, env: { ...ctx.env, NODE_ENV: lifecycle } });
  }
}
if (require.main === module) {
  process.umask(0o077);
  main().catch((error) => {
    console.error(core.safeMessage(error));
    process.exitCode = error.exitCode || 1;
  });
}
module.exports = { main, commands };
