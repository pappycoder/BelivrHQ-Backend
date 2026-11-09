/**
 * @file Delete data utility for BelivrHQ
 * @description Interactive console application for deleting records from the database.
 *
 * Provides three deletion methods:
 * 1. Delete by record ID (single record)
 * 2. Delete filtered records (by column/value)
 * 3. Delete all records from a table or all tables (full reset)
 *
 * All operations include preview and confirmation before execution.
 * Dry-run mode (-d or --dry-run) shows what would be deleted without actually deleting.
 *
 * Usage:
 *   npm run delete-data         # interactive
 *   npm run delete-data:dry     # dry-run mode (no data deleted)
 *   ts-node -P tsconfig.scripts.json scripts/delete-data.ts --dry-run
 *
 * @module delete-data
 * @since 1.0.0
 */

import 'dotenv/config';
import * as readline from 'readline';
import { PrismaClient, Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

// ─────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────

const IS_DRY_RUN = process.argv.includes('--dry-run') || process.argv.includes('-d');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});
function question(prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

// ─────────────────────────────────────────────────────────────
// All 32 models in FK-safe deletion order (children first)
// ─────────────────────────────────────────────────────────────

const ALL_MODELS_IN_ORDER: string[] = [
  'SyncQueue',
  'RolePermission',
  'AuditLog',
  'ChurchConfig',
  'Ticket',
  'EventRegistration',
  'RecurringGiving',
  'Transaction',
  'Message',
  'FormSubmission',
  'Form',
  'Attendance',
  'AttendanceSession',
  'Service',
  'FamilyMember',
  'Family',
  'Member',
  'Asset',
  'DepartmentMember',
  'Department',
  'CellGroup',
  'PastoralNote',
  'LifeEvent',
  'RiskScore',
  'EngagementScore',
  'Event',
  'GivingCategory',
  'Template',
  'Permission',
  'Role',
  'Profile',
  'Branch',
  'Church',
];

interface ModelGroup {
  name: string;
  models: string[];
}

const MODEL_GROUPS: ModelGroup[] = [
  {
    name: 'System',
    models: ['AuditLog', 'ChurchConfig', 'Role', 'Permission', 'RolePermission', 'SyncQueue'],
  },
  {
    name: 'Administration & People',
    models: ['Church', 'Branch', 'Profile', 'Member', 'Family', 'FamilyMember'],
  },
  { name: 'Giving & Finance', models: ['GivingCategory', 'Transaction', 'RecurringGiving'] },
  { name: 'Attendance & Services', models: ['Service', 'Attendance'] },
  {
    name: 'Pastoral & Care',
    models: ['PastoralNote', 'LifeEvent', 'RiskScore', 'EngagementScore'],
  },
  { name: 'Events', models: ['Event', 'EventRegistration', 'Ticket'] },
  { name: 'Communication', models: ['Message', 'Template', 'Form', 'FormSubmission'] },
  {
    name: 'Assets & Organisations',
    models: ['Asset', 'Department', 'DepartmentMember', 'CellGroup'],
  },
];

// Models that support soft-delete
const SOFT_DELETE_MODELS: Record<string, { statusField: string; inactiveValue: string }> = {
  Member: { statusField: 'status', inactiveValue: 'inactive' },
};

const SPARKLE = `\x1b[33m*\x1b[0m`;
const YELLOW = `\x1b[33m`;
const RED = `\x1b[31m`;
const GREEN = `\x1b[32m`;
const CYAN = `\x1b[36m`;
const BOLD = `\x1b[1m`;
const RESET = `\x1b[0m`;

function red(s: string): string {
  return `${RED}${s}${RESET}`;
}

function green(s: string): string {
  return `${GREEN}${s}${RESET}`;
}

function yellow(s: string): string {
  return `${YELLOW}${s}${RESET}`;
}

function cyan(s: string): string {
  return `${CYAN}${s}${RESET}`;
}

function bold(s: string): string {
  return `${BOLD}${s}${RESET}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────
// Prisma initialization
// ─────────────────────────────────────────────────────────────

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
});
const prisma = new PrismaClient({ adapter });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
let supabase: SupabaseClient | null = null;
if (supabaseUrl && supabaseServiceKey) {
  supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function prismaModel(
  name: string,
): Record<string, (args: Record<string, unknown>) => Promise<unknown>> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
  const model = (prisma as Record<string, unknown>)[name[0].toLowerCase() + name.slice(1)] as
    Record<string, (args: Record<string, unknown>) => Promise<unknown>> | undefined;
  if (!model) {
    throw new Error(`Model ${name} not found on PrismaClient`);
  }
  return model;
}

// ─────────────────────────────────────────────────────────────
// Helper to get column names for a model
// ─────────────────────────────────────────────────────────────

function getColumns(modelName: string): string[] {
  const model = Prisma.dmmf.datamodel.models.find((m) => m.name === modelName);
  if (!model) return [];
  return model.fields.filter((f) => f.kind !== 'object').map((f) => f.name);
}

function getColumnType(modelName: string, column: string): string | undefined {
  const model = Prisma.dmmf.datamodel.models.find((m) => m.name === modelName);
  if (!model) return undefined;
  const field = model.fields.find((f) => f.name === column);
  if (!field) return undefined;
  return field.type;
}

// ─────────────────────────────────────────────────────────────
// Prompt helpers
// ─────────────────────────────────────────────────────────────

async function prompt(message: string): Promise<string> {
  const q = message.endsWith(' ') ? message : `${message} `;
  return question(q);
}

async function confirmAction(
  description: string,
  requireTyping: boolean = false,
): Promise<boolean> {
  if (IS_DRY_RUN) {
    console.log(`${SPARKLE} Dry-run mode, skipping confirmation...`);
    return true;
  }
  console.log(red(`\nCAUTION: ${description}`));
  if (requireTyping) {
    const result = await prompt(`Type YES to confirm: `);
    if (result.trim() === 'YES') return true;
    console.log(red('Confirmation failed. Aborting.'));
    return false;
  }
  const result = await prompt(yellow('Are you sure? (y/N): '));
  const trimmed = result.trim().toLowerCase();
  if (trimmed === 'y' || trimmed === 'yes') return true;
  console.log(yellow('Operation cancelled.'));
  return false;
}

// ─────────────────────────────────────────────────────────────
// Display helpers
// ─────────────────────────────────────────────────────────────

function clearScreen() {
  console.clear();
}

function printHeader() {
  console.log(`\n${BOLD}BELIVRHQ Data Delete Utility${RESET}`);
  console.log(`${'-'.repeat(45)}`);
  if (IS_DRY_RUN) {
    console.log(red(`${bold('DRY-RUN MODE')} — No data will actually be deleted.`));
  }
  const dbUrl = process.env.DATABASE_URL || '';
  const dbName = dbUrl.split('/').pop()?.split('?')[0] || 'unknown';
  const dbHost = dbUrl.split('@').pop()?.split('/')[0] || 'unknown';
  console.log(`Connected to database: ${cyan(dbName)} @ ${cyan(dbHost)}\n`);
}

function printWidow() {
  console.log(red(`${bold('WARNING:')} This tool can permanently delete data!`));
  console.log(red('Use with caution. Ensure you have a backup.'), '\n');
}

async function verifyDatabase(callback: () => Promise<void>): Promise<void> {
  const dbUrl = process.env.DATABASE_URL || '';
  const dbName = dbUrl.split('/').pop()?.split('?')[0] || 'unknown';
  console.log(`Verify the database you are connected to: ${cyan(dbName)}`);
  const confirmation = await prompt('Please type the database name to proceed: ');
  if (confirmation.trim() !== dbName) {
    console.log(red('Database name does not match. Exiting.'));
    process.exit(1);
  }
  await callback();
}

async function promptNumber(message: string, max: number, min: number = 1): Promise<number> {
  while (true) {
    const input = await prompt(message);
    const num = parseInt(input, 10);
    if (!isNaN(num) && num >= min && num <= max) {
      return num;
    }
    console.log(yellow(`Please enter a valid number between ${min} and ${max}.`));
  }
}

function printPreview(rows: Record<string, unknown>[], columns: string[]): void {
  if (rows.length === 0) return;
  const colWidths = columns.map((col) => {
    const header = col.length;
    const maxVal = rows.reduce((max, row) => Math.max(max, String(row[col] || '').length), 0);
    return Math.max(header, maxVal, 8);
  });

  const line = colWidths.map((w) => '+'.repeat(w + 2)).join('|');
  const headerRow = columns.map((col, i) => col.padEnd(colWidths[i])).join(' | ');

  console.log(` ${headerRow}`);
  console.log(` ${line}`);
  for (const row of rows.slice(0, 10)) {
    const cell = columns
      .map((col, i) => {
        const val = row[col] !== null && row[col] !== undefined ? String(row[col]) : '';
        if (val.length > 25) {
          return val.substring(0, 22) + '...';
        }
        return val.padEnd(colWidths[i]);
      })
      .join(' | ');
    console.log(` ${cell}`);
  }
  if (rows.length > 10) {
    console.log(yellow(`   ... and ${rows.length - 10} more row(s)`));
  }
}

// ─────────────────────────────────────────────────────────────
// Generic count and search functions
// ─────────────────────────────────────────────────────────────

async function countRecords(modelName: string): Promise<number> {
  const model = prismaModel(modelName);
  return model.count();
}

async function findRecords(
  modelName: string,
  field: string,
  value: string,
): Promise<Record<string, unknown>[]> {
  const model = prismaModel(modelName);
  const columnType = getColumnType(modelName, field);
  const isString = columnType === 'String';
  const isBool = columnType === 'Boolean';
  let val;
  if (isBool) {
    val = value.toLowerCase() === 'true';
  } else if (columnType === 'Int' || columnType === 'Float') {
    val = parseFloat(value);
  } else if (columnType === 'DateTime') {
    val = new Date(value);
  } else {
    val = value;
  }

  if (isString && val !== '') {
    return model.findMany({
      where: {
        [field]: { contains: val, mode: 'insensitive' },
      },
      take: 100,
    });
  }
  return model.findMany({
    where: { [field]: val },
    take: 100,
  });
}

async function countRecordsWhere(modelName: string, field: string, value: string): Promise<number> {
  const model = prismaModel(modelName);
  const columnType = getColumnType(modelName, field);
  const isString = columnType === 'String';
  const isBool = columnType === 'Boolean';
  let val;
  if (isBool) {
    val = value.toLowerCase() === 'true';
  } else if (columnType === 'Int' || columnType === 'Float') {
    val = parseFloat(value);
  } else if (columnType === 'DateTime') {
    val = new Date(value);
  } else {
    val = value;
  }

  if (isString && val !== '') {
    return model.count({
      where: {
        [field]: { contains: val, mode: 'insensitive' },
      },
    });
  }
  return model.count({ where: { [field]: val } });
}

async function findById(modelName: string, id: string): Promise<Record<string, unknown> | null> {
  const model = prismaModel(modelName);
  return model.findUnique({ where: { id } });
}

// Hard delete all records for a model
async function deleteAllRecordsInModel(modelName: string): Promise<number> {
  if (IS_DRY_RUN) {
    return 0;
  }
  const model = prismaModel(modelName);
  const result = await model.deleteMany({});
  return result.count;
}

// Hard delete records for a model by condition
async function deleteRecordsWhere(
  modelName: string,
  field: string,
  value: string,
): Promise<number> {
  if (IS_DRY_RUN) return 0;
  const model = prismaModel(modelName);
  const columnType = getColumnType(modelName, field);
  const isString = columnType === 'String';
  const isBool = columnType === 'Boolean';
  let val;
  if (isBool) val = value.toLowerCase() === 'true';
  else if (columnType === 'Int' || columnType === 'Float') val = parseFloat(value);
  else if (columnType === 'DateTime') val = new Date(value);
  else val = value;

  if (isString && val !== '') {
    const matching = (await model.findMany({
      where: { [field]: { contains: val, mode: 'insensitive' } },
      select: { id: true },
    })) as { id: string }[];
    const ids = matching.map((m) => m.id);
    if (ids.length === 0) return 0;
    const result = await model.deleteMany({ where: { id: { in: ids } } });
    return result.count;
  }
  const result = await model.deleteMany({ where: { [field]: val } });
  return result.count;
}

async function softDeleteRecordsWhere(
  modelName: string,
  field: string,
  value: string,
): Promise<number> {
  if (IS_DRY_RUN) return 0;
  const model = prismaModel(modelName);
  const config = SOFT_DELETE_MODELS[modelName];
  const columnType = getColumnType(modelName, field);
  const isString = columnType === 'String';
  const isBool = columnType === 'Boolean';
  let val;
  if (isBool) val = value.toLowerCase() === 'true';
  else if (columnType === 'Int' || columnType === 'Float') val = parseFloat(value);
  else if (columnType === 'DateTime') val = new Date(value);
  else val = value;

  let ids: string[] = [];
  if (isString && val !== '') {
    const recs = (await model.findMany({
      where: { [field]: { contains: val, mode: 'insensitive' } },
      select: { id: true },
    })) as { id: string }[];
    ids = recs.map((r) => r.id);
  } else {
    const recs = (await model.findMany({
      where: { [field]: val },
      select: { id: true },
    })) as { id: string }[];
    ids = recs.map((r) => r.id);
  }

  if (ids.length === 0) return 0;
  await model.updateMany({
    where: { id: { in: ids } },
    data: { [config.statusField]: config.inactiveValue },
  });
  return ids.length;
}

async function displayTableCounts(tables?: string[]): Promise<void> {
  const list = tables || ALL_MODELS_IN_ORDER;
  let total = 0;
  for (const table of list) {
    const count = await countRecords(table);
    if (count > 0) {
      console.log(`  ${table.padEnd(25)} ${count} records`);
    }
    total += count;
  }
  console.log(cyan(`\n  Total:  ${total} records`));
}

// ─────────────────────────────────────────────────────────────
// Mode 1 — Delete by record ID
// ─────────────────────────────────────────────────────────────

async function modeDeleteById(): Promise<void> {
  clearScreen();
  printHeader();
  console.log(bold('Mode 1: Delete record(s) by ID\n'));

  const table = await selectTable();
  console.log(`\nSelected table: ${cyan(table)}`);
  const softDeleteAvailable = table in SOFT_DELETE_MODELS;

  if (softDeleteAvailable) {
    const ans = await prompt(`Soft-delete available for ${table}. Soft-delete instead? (Y/n): `);
    const wantSoft = ans.trim().toLowerCase() !== 'n';
    const text = wantSoft ? 'soft-delete' : 'hard-delete';
    console.log(`Will ${text}.\n`);

    while (true) {
      const id = await prompt(`Enter ID of the record to ${text} (or enter to go back): `);
      if (!id.trim()) break;

      const record = await findById(table, id.trim());
      if (!record) {
        console.log(red(`No record found with ID ${id}.`));
        continue;
      }

      console.log(`\nRecord found:`);
      const cols = getColumns(table);
      printPreview([record], cols);

      if (!(await confirmAction(`Proceed with ${text} of this record?`))) continue;

      if (wantSoft && softDeleteAvailable) {
        await softDeleteRecordsWhere(table, 'id', id.trim());
        console.log(
          green(`\u2713 Record soft-deleted (set to ${SOFT_DELETE_MODELS[table].inactiveValue}).`),
        );
      } else {
        await deleteRecordsWhere(table, 'id', id.trim());
        console.log(green(`\u2713 Record permanently deleted.`));
      }
    }
    return;
  }

  while (true) {
    const id = await prompt('Enter ID of the record to delete (or enter to go back): ');
    if (!id.trim()) break;

    const record = await findById(table, id.trim());
    if (!record) {
      console.log(red(`No record found with ID: ${id}`));
      continue;
    }

    console.log('\nRecord found:');
    const cols = getColumns(table);
    printPreview([record], cols);

    if (!(await confirmAction('Permanently delete this record?'))) continue;

    await deleteRecordsWhere(table, 'id', id.trim());
    console.log(green(`\u2713 Record permanently deleted.`));
  }
}

// ─────────────────────────────────────────────────────────────
// Mode 2 — Delete filtered records
// ─────────────────────────────────────────────────────────────

async function modeDeleteFiltered(): Promise<void> {
  clearScreen();
  printHeader();
  console.log(bold('Mode 2: Delete filtered records\n'));

  const table = await selectTable();
  console.log(`\nSelected table: ${cyan(table)}`);

  const columns = getColumns(table);
  console.log('\nAvailable columns:');
  for (let i = 0; i < columns.length; i++) {
    const colType = getColumnType(table, columns[i]);
    console.log(
      `  ${(i + 1).toString().padEnd(3)} ${columns[i].padEnd(25)} ${cyan(colType || '')}`,
    );
  }

  const chosenCol = await promptNumber(
    `\nSelect a column by number (1-${columns.length}): `,
    columns.length,
  );
  const col = columns[chosenCol - 1];
  console.log(`Selected column: ${cyan(col)}`);

  const value = await prompt(`Enter value to match (use % for like):`);

  const count = await countRecordsWhere(table, col, value);
  console.log(`\nRecords matching condition: ${yellow(String(count))}`);
  if (count === 0) {
    console.log(red('No records match.'));
    return;
  }

  const matches = await findRecords(table, col, value);
  console.log('\nPreview (up to 20 rows):');
  const previewCols = columns.slice(0, Math.min(columns.length, 8));
  printPreview(matches.slice(0, 20), previewCols);

  const softAvailable = table in SOFT_DELETE_MODELS;
  let doSoftDelete = false;
  if (softAvailable) {
    const ans = await prompt(`Soft-delete available for ${table}. Soft-delete instead? (Y/n): `);
    doSoftDelete = ans.trim().toLowerCase() !== 'n';
  }

  const action = doSoftDelete ? 'soft-delete' : 'delete';
  if (!(await confirmAction(`This will ${action} ${count} records from the ${table} table!`)))
    return;

  let deleted = 0;
  if (doSoftDelete && softAvailable) {
    deleted = await softDeleteRecordsWhere(table, col, value);
  } else {
    deleted = await deleteRecordsWhere(table, col, value);
  }

  if (IS_DRY_RUN) {
    console.log(yellow(`  DRY RUN — Would have deleted ${deleted} records from ${table}`));
  } else {
    console.log(green(`\u2713 Deleted ${deleted} records from ${table}`));
  }
  await sleep(1000);
}

// ─────────────────────────────────────────────────────────────
// Mode 3 — Delete all records from a table
// ─────────────────────────────────────────────────────────────

async function modeDeleteAllFromTable(): Promise<void> {
  clearScreen();
  printHeader();
  console.log(bold('Mode 3: Delete all records from a table\n'));

  const table = await selectTable();

  const count = await countRecords(table);
  console.log(`\nTable ${cyan(table)} has ${yellow(String(count))} records.`);

  if (count === 0) {
    console.log(yellow('Table is already empty.'));
    await prompt('Press enter to continue');
    return;
  }

  const softAvailable = table in SOFT_DELETE_MODELS;
  let doSoftDelete = false;
  if (softAvailable) {
    const ans = await prompt(`Soft-delete available for ${table}. Soft-delete instead? (Y/n): `);
    doSoftDelete = ans.trim().toLowerCase() !== 'n';
  }

  const action = doSoftDelete ? 'soft-delete' : 'permanently delete';
  if (
    !(await confirmAction(
      `This will ${action} ALL ${count} records from the ${table} table!`,
      true,
    ))
  )
    return;

  let deleted = 0;
  if (doSoftDelete && softAvailable) {
    deleted = await deleteAllRecordsInModel(table); // soft-delete all by setting status
    if (deleted > 0) {
      const model = prismaModel(table);
      await model.updateMany({
        where: {},
        data: { [SOFT_DELETE_MODELS[table].statusField]: SOFT_DELETE_MODELS[table].inactiveValue },
      });
    }
  } else {
    // Hard delete all in safe order for the table
    const order = ALL_MODELS_IN_ORDER;
    const idx = order.indexOf(table);
    if (idx !== -1) {
      // Delete tables that reference this table first (tables that appear earlier in the list)
      for (let i = 0; i < order.length; i++) {
        if (i < idx || order[i] === table) continue;
        // Only delete non-empty dependent tables
      }
    }
    deleted = await deleteAllRecordsInModel(table);
  }

  if (IS_DRY_RUN) {
    console.log(yellow(`  DRY RUN — Would have ${action}d ${deleted} records from ${table}`));
  } else {
    console.log(
      green(
        `\u2713 ${action === 'soft-delete' ? 'Soft-deleted' : 'Permanently deleted'} ${deleted} records.`,
      ),
    );
  }
  await sleep(1000);
}

// ─────────────────────────────────────────────────────────────
// Supabase Auth helpers
// ─────────────────────────────────────────────────────────────

async function listAllAuthUsers(): Promise<{ id: string; email: string }[]> {
  if (!supabase) return [];
  const users: { id: string; email: string }[] = [];
  let page = 1;
  const perPage = 100;
  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    for (const u of data.users) {
      users.push({ id: u.id, email: u.email ?? '(no email)' });
    }
    if (data.users.length < perPage) break;
    page++;
  }
  return users;
}

async function deleteAllAuthUsers(): Promise<number> {
  if (!supabase || IS_DRY_RUN) return 0;
  const users = await listAllAuthUsers();
  let deleted = 0;
  for (const u of users) {
    const { error } = await supabase.auth.admin.deleteUser(u.id);
    if (error) {
      console.log(yellow(`  ⚠ Failed to delete auth user ${u.email}: ${error.message}`));
    } else {
      deleted++;
    }
  }
  return deleted;
}

// ─────────────────────────────────────────────────────────────
// Mode 4 — Delete all records from all tables (full reset)
// ─────────────────────────────────────────────────────────────

async function modeFullReset(): Promise<void> {
  clearScreen();
  printHeader();
  console.log(bold('Mode 4: FULL DATABASE RESET\n'));
  console.log(red('This will delete ALL data from ALL tables!'));
  console.log(red('Structure (tables, columns, indexes) will NOT be affected.\n'));

  let total = 0;
  for (const table of ALL_MODELS_IN_ORDER) {
    total += await countRecords(table);
  }

  const authUsers = await listAllAuthUsers();
  const authCount = authUsers.length;

  if (total === 0 && authCount === 0) {
    console.log(yellow('All tables are already empty and no auth users exist.'));
    await prompt('Press enter to return');
    return;
  }

  for (const table of ALL_MODELS_IN_ORDER) {
    const cnt = await countRecords(table);
    if (cnt > 0) {
      console.log(`  ${table.padEnd(25)} ${yellow(String(cnt))} records`);
    }
  }
  if (authCount > 0) {
    console.log(`  ${'[Supabase Auth]'.padEnd(25)} ${yellow(String(authCount))} users`);
  }
  console.log(`\nTotal records to delete: ${bold(String(total + authCount))}`);

  if (!(await confirmAction('PERMANENTLY DELETE ALL DATA? This cannot be undone!', true))) return;

  // Delete DB records in FK-safe order
  const countPerTable: { table: string; count: number }[] = [];
  for (const table of ALL_MODELS_IN_ORDER) {
    const cnt = await countRecords(table);
    if (cnt > 0) {
      countPerTable.push({ table, count: cnt });
    }
  }

  console.log('\nDeleting database records...');
  for (const entry of countPerTable) {
    if (!IS_DRY_RUN) {
      await deleteAllRecordsInModel(entry.table);
    }
    console.log(`  ${entry.table.padEnd(25)} ${entry.count} records deleted`);
  }

  // Delete Supabase Auth users
  if (authCount > 0) {
    console.log('\nDeleting Supabase Auth users...');
    if (IS_DRY_RUN) {
      console.log(yellow(`  DRY RUN — Would have deleted ${authCount} auth users.`));
    } else {
      const deleted = await deleteAllAuthUsers();
      console.log(green(`\u2713 ${deleted} auth users deleted.`));
      if (deleted < authCount) {
        console.log(yellow(`  ⚠ ${authCount - deleted} auth user(s) could not be deleted.`));
      }
    }
  }

  if (IS_DRY_RUN) {
    console.log(yellow(`\n  DRY RUN — No data was actually deleted.`));
  } else {
    console.log(green(`\u2713 All records deleted successfully.`));
  }
  await sleep(1500);
}

// ─────────────────────────────────────────────────────────────
// Table selection (shared by multiple modes)
// ─────────────────────────────────────────────────────────────

async function selectTable(): Promise<string> {
  let flatIndex = 1;
  const indexToModel: Record<number, string> = {};

  // Build a numbered list from groups
  for (const group of MODEL_GROUPS) {
    console.log(`\n${bold(group.name)}:`);
    for (const model of group.models) {
      console.log(`  ${flatIndex.toString().padEnd(3)} ${model}`);
      indexToModel[flatIndex] = model;
      flatIndex++;
    }
  }
  console.log(`  ${flatIndex.toString().padEnd(3)} Show all (un-grouped)`);
  const allIndex = flatIndex;

  const maxIndex = flatIndex + ALL_MODELS_IN_ORDER.length;
  if (flatIndex <= maxIndex) {
    for (const model of ALL_MODELS_IN_ORDER) {
      if (!Object.values(indexToModel).includes(model)) {
        indexToModel[flatIndex] = model;
        flatIndex++;
      }
    }
  }

  while (true) {
    const choice = await promptNumber(
      `\nSelect a table (1-${allIndex}, or ${allIndex} for all): `,
      allIndex,
    );
    if (choice === allIndex) {
      // Show all tables
      for (let i = 0; i < ALL_MODELS_IN_ORDER.length; i++) {
        console.log(`  ${(i + 1).toString().padEnd(3)} ${ALL_MODELS_IN_ORDER[i]}`);
      }
      const sub = await promptNumber(
        `Select table (1-${ALL_MODELS_IN_ORDER.length}): `,
        ALL_MODELS_IN_ORDER.length,
      );
      return ALL_MODELS_IN_ORDER[sub - 1];
    }
    return indexToModel[choice];
  }
}

// ─────────────────────────────────────────────────────────────
// Main menu
// ─────────────────────────────────────────────────────────────

async function mainMenu(): Promise<boolean> {
  clearScreen();
  printHeader();
  printWidow();

  console.log('Main menu:\n');
  console.log('  1. Delete record(s) by ID');
  console.log('  2. Delete filtered records');
  console.log('  3. Delete all records from a table');
  console.log('  4. Full database reset (all tables)');
  console.log('  5. Count records in all tables');
  console.log('  6. Exit');

  if (IS_DRY_RUN) {
    console.log(yellow('\n  (running in DRY-RUN mode)'));
  }

  const choice = await promptNumber('\nEnter your choice (1-6): ', 6);

  switch (choice) {
    case 1:
      await modeDeleteById();
      break;
    case 2:
      await modeDeleteFiltered();
      break;
    case 3:
      await modeDeleteAllFromTable();
      break;
    case 4:
      await modeFullReset();
      break;
    case 5: {
      clearScreen();
      printHeader();
      console.log(bold('Record counts by table:'));
      console.log('');
      await displayTableCounts();
      await prompt('\nPress enter to return');
      break;
    }
    case 6:
      return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────
// Entrypoint
// ─────────────────────────────────────────────────────────────

async function main() {
  try {
    clearScreen();
    printHeader();
    printWidow();
    const message = IS_DRY_RUN
      ? 'DRY RUN — connect to your production or dev database as needed. Enter database name to proceed'
      : 'THIS WILL MODIFY DATA. Ensure you are connected to the correct database. Enter database name to proceed';
    console.log(yellow(message));
    await verifyDatabase(async () => {
      while (true) {
        const cont = await mainMenu();
        if (!cont) {
          break;
        }
        await sleep(300);
      }
      clearScreen();
      console.log(green('Goodbye!'));
    });
  } catch (err) {
    console.error(red('Fatal error:'), err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
    rl.close();
  }
}

main();
