import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'dotenv';
import {
  SECRET_RULES,
  SecretName,
  normalizeSecret,
  previousSecrets,
  secretKeys,
} from '../../src/config/secret-keys';
import { redisNamespace } from '../../src/redis/redis-namespace';

export class EnvSyncError extends Error {}
type Target = 'preview' | 'production';
export interface Entry {
  value: string;
  source: string;
  type: 'secret' | 'config';
}
export interface EnvPlan {
  target: Target;
  entries: Record<string, Entry>;
  warnings?: string[];
}
const targets: Target[] = ['preview', 'production'];
const required = [
  'NODE_ENV',
  'DATABASE_URL',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_ANON_KEY',
  'REDIS_URL',
  'WEB_URL',
  'ALTCHA_HMAC_KEY',
  'PASTORAL_ENCRYPTION_KEY',
];
const publicSettings = new Set([
  'NODE_ENV',
  'PORT',
  'WEB_URL',
  'PUBLIC_API_URL',
  'SUPABASE_URL',
  'REDIS_NAMESPACE',
  'RESEND_FROM',
  'SUPABASE_STORAGE_BUCKET',
  'SUPABASE_PRIVATE_STORAGE_BUCKET',
  'LOG_LEVEL',
  'ENABLE_SWAGGER',
  'ENABLE_QUEUE_WORKERS',
  'ENABLE_SMS_FALLBACK',
  'SUBSCRIPTION_PAYSTACK_CURRENCIES',
  'SUBSCRIPTION_FLUTTERWAVE_CURRENCIES',
  'ASK_BELIVRHQ_AI_ENABLED',
  'ASK_BELIVRHQ_MODEL',
  'ASK_BELIVRHQ_INPUT_USD_PER_MILLION',
  'ASK_BELIVRHQ_OUTPUT_USD_PER_MILLION',
  'ASK_BELIVRHQ_CHURCH_DAILY_USD',
  'ASK_BELIVRHQ_GLOBAL_DAILY_USD',
  'ASK_BELIVRHQ_GLOBAL_DAILY_REQUESTS',
  'DB_POOL_MAX',
  'DB_SERVERLESS_POOL_MAX',
  'DB_CONNECT_TIMEOUT_MS',
  'DB_IDLE_TIMEOUT_MS',
]);
const shareFromLocal = new Set([
  ...Object.keys(SECRET_RULES),
  ...Object.keys(SECRET_RULES).map((key) => `${key}_PREVIOUS_KEYS`),
  'REDIS_URL',
  'UPSTASH_REDIS_TOKEN',
  'SENTRY_DSN',
]);

/** Parse data only; never source env files through a shell. Detect accidental duplicate assignments. */
export function readEnvFile(file: string): Record<string, string> {
  let content: string;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    throw new EnvSyncError(`Cannot read ${file}. Run npm run env:vercel:init first.`);
  }
  const result: Record<string, string> = {};
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=(.*)$/);
    if (!match)
      throw new EnvSyncError(
        `Invalid dotenv assignment on line ${index + 1} in ${file}. Use one assignment per line; encode newlines as \\n in double quotes.`,
      );
    const [, name, raw] = match;
    if (Object.prototype.hasOwnProperty.call(result, name))
      throw new EnvSyncError(`Duplicate ${name} in ${file}`);
    const trimmed = raw.trim();
    if (/^["'`]/.test(trimmed) && !/^(["'`]).*\1\s*(?:#.*)?$/.test(trimmed))
      throw new EnvSyncError(`Unclosed quoted value for ${name} in ${file}`);
    const parsed = parse(line);
    if (parsed[name] === undefined) throw new EnvSyncError(`Invalid ${name} assignment in ${file}`);
    result[name] = parsed[name];
  }
  return result;
}
function encode(value: string): string {
  if (/[\r\n]/.test(value)) {
    const candidate = JSON.stringify(value);
    if (parse(`VALUE=${candidate}`).VALUE === value) return candidate;
    throw new EnvSyncError('A multiline value cannot be represented safely in dotenv format.');
  }
  for (const quote of ["'", '`', '"']) {
    const candidate = `${quote}${value}${quote}`;
    if (!value.includes(quote) && parse(`VALUE=${candidate}`).VALUE === value) return candidate;
  }
  throw new EnvSyncError(
    'A local value cannot be copied safely; configure it manually in the shared file.',
  );
}
export function initialize(root: string): string[] {
  const local = existsSync(join(root, '.env'))
    ? parse(readFileSync(join(root, '.env'), 'utf8'))
    : {};
  const created: string[] = [];
  for (const name of ['shared', ...targets]) {
    const destination = join(root, `.env.vercel.${name}`);
    if (existsSync(destination)) continue;
    let content = readFileSync(join(root, 'config/vercel', `${name}.env.example`), 'utf8');
    if (name === 'shared') {
      content = content
        .split('\n')
        .map((line) => {
          const key = line.match(/^([A-Z_][A-Z0-9_]*)=/)?.[1];
          return key && shareFromLocal.has(key) && local[key]
            ? `${key}=${encode(local[key])}`
            : line;
        })
        .join('\n');
    }
    if (name === 'production') {
      const scoped = parse(content);
      for (const [key, value] of Object.entries(local)) {
        if (
          shareFromLocal.has(key) ||
          key === 'NODE_ENV' ||
          key === 'REDIS_NAMESPACE' ||
          key.endsWith('_ROTATION_KEYS') ||
          key === 'PASTORAL_OLD_ENCRYPTION_KEY' ||
          key.startsWith('VERCEL_')
        )
          continue;
        if (
          ['WEB_URL', 'PUBLIC_API_URL'].includes(key) &&
          /^(http:\/\/|https?:\/\/(localhost|127\.0\.0\.1)([:/]|$))/.test(value)
        )
          continue;
        scoped[key] = value;
      }
      content =
        '# Private Production values seeded from existing .env. Review before pushing.\n' +
        Object.entries(scoped)
          .map(([key, value]) => `${key}=${encode(value)}`)
          .join('\n') +
        '\n';
    }
    writeFileSync(destination, content, { mode: 0o600, flag: 'wx' });
    created.push(destination);
  }
  return created;
}
function validate(plan: EnvPlan): void {
  const values = Object.fromEntries(
    Object.entries(plan.entries).map(([name, entry]) => [name, entry.value]),
  );
  const missing = required.filter((name) => !values[name]);
  plan.warnings = missing.length
    ? [
        `Required runtime settings are empty or absent: ${missing.join(', ')}. Explicit empty assignments will clear hosted values and may prevent startup.`,
      ]
    : [];
  if (values.NODE_ENV && values.NODE_ENV !== 'production')
    throw new EnvSyncError(`${plan.target}: NODE_ENV must be production for hosted builds.`);
  for (const name of Object.keys(SECRET_RULES) as SecretName[]) {
    try {
      const previous = previousSecrets(name, values[`${name}_PREVIOUS_KEYS`]);
      if (values[name] || previous.length) {
        secretKeys(name, (key) => values[key]);
        if (values[name]) plan.entries[name].value = normalizeSecret(name, values[name])!;
      }
    } catch {
      throw new EnvSyncError(
        `${plan.target}: invalid ${name} or its previous-key list. Run keys:check with the target settings.`,
      );
    }
  }
  if (
    values.PASTORAL_ENCRYPTION_KEY === 'dev-only-change-in-production-32b' ||
    previousSecrets(
      'PASTORAL_ENCRYPTION_KEY',
      values.PASTORAL_ENCRYPTION_KEY_PREVIOUS_KEYS,
    ).includes('dev-only-change-in-production-32b')
  )
    throw new EnvSyncError(
      `${plan.target}: production cannot use the pastoral development fallback key.`,
    );
  if (values.DATABASE_URL)
    try {
      const db = new URL(values.DATABASE_URL);
      if (
        db.protocol !== 'postgresql:' ||
        ['localhost', '127.0.0.1', '[::1]'].includes(db.hostname)
      )
        throw new Error();
    } catch {
      throw new EnvSyncError(`${plan.target}: DATABASE_URL must be a hosted PostgreSQL URL.`);
    }
  for (const name of ['WEB_URL', 'PUBLIC_API_URL', 'SUPABASE_URL']) {
    if (!values[name]) continue;
    try {
      const url = new URL(values[name]);
      if (url.protocol !== 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
        throw new Error();
    } catch {
      throw new EnvSyncError(`${plan.target}: ${name} must be a public HTTPS URL.`);
    }
  }
  if (values.REDIS_URL && !/^(rediss?:\/\/|https:\/\/)/.test(values.REDIS_URL))
    throw new EnvSyncError(`${plan.target}: invalid REDIS_URL.`);
  if (values.REDIS_URL) {
    try {
      const url = new URL(values.REDIS_URL);
      if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error();
    } catch {
      throw new EnvSyncError(
        `${plan.target}: REDIS_URL must point to the hosted Redis service, not local development Redis.`,
      );
    }
  }
  if (values.REDIS_URL?.startsWith('https://') && !values.UPSTASH_REDIS_TOKEN)
    throw new EnvSyncError(`${plan.target}: HTTPS Redis requires UPSTASH_REDIS_TOKEN.`);
  try {
    redisNamespace((name) => (name === 'VERCEL_ENV' ? plan.target : values[name]));
  } catch {
    throw new EnvSyncError(`${plan.target}: invalid REDIS_NAMESPACE.`);
  }
}
export function preparePlans(root: string, selected: Target[]): EnvPlan[] {
  const shared = readEnvFile(join(root, '.env.vercel.shared'));
  if (Object.prototype.hasOwnProperty.call(shared, 'DATABASE_URL'))
    throw new EnvSyncError('DATABASE_URL belongs in each environment file, not the shared file.');
  const plans = selected.map((target) => {
    const entries: Record<string, Entry> = {};
    for (const [source, values] of [
      ['shared', shared],
      [target, readEnvFile(join(root, `.env.vercel.${target}`))],
    ] as const) {
      for (const [name, value] of Object.entries(values)) {
        if (
          name.endsWith('_ROTATION_KEYS') ||
          name === 'PASTORAL_OLD_ENCRYPTION_KEY' ||
          name.startsWith('VERCEL_')
        )
          throw new EnvSyncError(
            `${name} is operator/platform-owned and cannot be pushed from these files.`,
          );
        entries[name] = {
          value,
          source: `.env.vercel.${source}`,
          type: value === '' || publicSettings.has(name) ? 'config' : 'secret',
        };
      }
    }
    const plan = { target, entries };
    validate(plan);
    return plan;
  });
  if (plans.length === 2) {
    if (plans.every((plan) => plan.entries.DATABASE_URL?.value)) {
      const locations = plans.map((plan) => {
        const url = new URL(plan.entries.DATABASE_URL.value);
        return `${url.hostname}:${url.port}:${url.username}:${url.pathname}`;
      });
      if (locations[0] === locations[1])
        throw new EnvSyncError('Preview and Production must use separate database targets.');
    }
    const namespaces = plans.map((plan) =>
      redisNamespace((name) => (name === 'VERCEL_ENV' ? plan.target : plan.entries[name]?.value)),
    );
    if (
      plans[0].entries.REDIS_URL?.value &&
      plans[0].entries.REDIS_URL.value === plans[1].entries.REDIS_URL?.value &&
      namespaces[0] === namespaces[1]
    )
      throw new EnvSyncError(
        'Shared Redis connections require different Preview and Production namespaces.',
      );
  }
  return plans;
}
export type Runner = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    input?: string;
    encoding: 'utf8';
    stdio: ['pipe', 'pipe', 'pipe'];
    env: NodeJS.ProcessEnv;
  },
) => { status: number | null; stdout?: string; stderr?: string; error?: unknown };
export function pushPlans(root: string, plans: EnvPlan[], run: Runner = spawnSync): number {
  let project: { projectId?: string; orgId?: string };
  try {
    project = JSON.parse(readFileSync(join(root, '.vercel/project.json'), 'utf8'));
  } catch {
    throw new EnvSyncError(
      'Link this backend project first: run vercel login, then vercel link from this directory.',
    );
  }
  if (
    ![project.projectId, project.orgId].every(
      (id) => typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id),
    )
  )
    throw new EnvSyncError(
      'Invalid Vercel project link; rerun vercel link for the backend project.',
    );
  const options = {
    cwd: root,
    encoding: 'utf8' as const,
    stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, VERCEL_TELEMETRY_DISABLED: '1' },
  };
  const version = run('vercel', ['--version'], options);
  const match = `${version.stdout || ''} ${version.stderr || ''}`.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (
    version.status !== 0 ||
    !match ||
    Number(match[1]) < 65 ||
    (Number(match[1]) === 65 && Number(match[2]) < 9)
  )
    throw new EnvSyncError(
      'Install Vercel CLI 65.9 or newer, then run vercel login and vercel link.',
    );
  let count = 0;
  for (const plan of plans) {
    for (const name of Object.keys(plan.entries).sort()) {
      const entry = plan.entries[name];
      const result = run(
        'vercel',
        [
          'env',
          'add',
          name,
          '--environment',
          plan.target,
          '--force',
          '--type',
          entry.type,
          ...(entry.value === '' ? ['--value', ''] : []),
          '--yes',
          '--project',
          project.projectId!,
          '--scope',
          project.orgId!,
        ],
        { ...options, input: entry.value },
      );
      if (result.status !== 0 || result.error)
        throw new EnvSyncError(
          `Vercel sync failed for ${name} in ${plan.target}. Some earlier updates may have succeeded; retry after checking login/project access. CLI output was suppressed to protect values.`,
        );
      count++;
    }
  }
  return count;
}
function cliContext(root: string, run: Runner) {
  let project: { projectId?: string; orgId?: string };
  try {
    project = JSON.parse(readFileSync(join(root, '.vercel/project.json'), 'utf8'));
  } catch {
    throw new EnvSyncError('Run vercel login and vercel link for this backend before pulling.');
  }
  if (
    ![project.projectId, project.orgId].every(
      (id) => typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id),
    )
  )
    throw new EnvSyncError('Invalid backend project link. Run vercel link again.');
  return {
    project,
    options: {
      cwd: root,
      encoding: 'utf8' as const,
      stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, VERCEL_TELEMETRY_DISABLED: '1' },
    },
    run,
  };
}
function saveValues(root: string, file: string, values: Record<string, string>): void {
  const path = join(root, file);
  const text =
    '# Private deployment settings. Git-ignored; do not commit.\n' +
    Object.entries(values)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${encode(value)}`)
      .join('\n') +
    '\n';
  // Check serialization before replacing the original. Values, including empty strings, must round-trip.
  const parsed = parse(text);
  if (Object.keys(values).some((key) => parsed[key] !== values[key]))
    throw new EnvSyncError(`Cannot safely serialize ${file}`);
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}
export function splitLocal(root: string): {
  shared: number;
  production: number;
  localOnly: string[];
} {
  initialize(root);
  const local = readEnvFile(join(root, '.env'));
  const shared = readEnvFile(join(root, '.env.vercel.shared'));
  const production = readEnvFile(join(root, '.env.vercel.production'));
  const localOnly: string[] = [];
  let sharedCount = 0,
    productionCount = 0;
  for (const [name, value] of Object.entries(local)) {
    if (
      name.endsWith('_ROTATION_KEYS') ||
      name === 'PASTORAL_OLD_ENCRYPTION_KEY' ||
      name.startsWith('VERCEL_') ||
      name === 'REDIS_NAMESPACE' ||
      name === 'NODE_ENV'
    ) {
      localOnly.push(name);
      continue;
    }
    if (shareFromLocal.has(name)) {
      if (!Object.prototype.hasOwnProperty.call(shared, name)) {
        shared[name] = value;
        sharedCount++;
      }
    } else {
      if (
        ['WEB_URL', 'PUBLIC_API_URL'].includes(name) &&
        /^(http:\/\/|https?:\/\/(localhost|127\.0\.0\.1)([:/]|$))/.test(value)
      ) {
        localOnly.push(name);
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(production, name)) {
        production[name] = value;
        productionCount++;
      }
    }
  }
  saveValues(root, '.env.vercel.shared', shared);
  saveValues(root, '.env.vercel.production', production);
  return { shared: sharedCount, production: productionCount, localOnly };
}
interface RemoteEntry {
  key: string;
  type?: string;
  value?: unknown;
  target?: string[];
  gitBranch?: string | null;
}
export interface PullResult {
  readable: number;
  preserved: string[];
  missing: string[];
  split: string[];
}
export function pullEnvironments(
  root: string,
  selected: Target[],
  run: Runner = spawnSync,
): PullResult {
  initialize(root);
  const { project, options } = cliContext(root, run);
  const shared = readEnvFile(join(root, '.env.vercel.shared'));
  const scoped = Object.fromEntries(
    targets.map((target) => [target, readEnvFile(join(root, `.env.vercel.${target}`))]),
  ) as Record<Target, Record<string, string>>;
  const readable: Partial<Record<Target, Record<string, string>>> = {};
  const result: PullResult = { readable: 0, preserved: [], missing: [], split: [] };
  for (const target of selected) {
    const response = run(
      'vercel',
      [
        'env',
        'list',
        '--environment',
        target,
        '--json',
        '--project',
        project.projectId!,
        '--scope',
        project.orgId!,
      ],
      options,
    );
    if (response.status !== 0 || response.error)
      throw new EnvSyncError(
        `Cannot pull ${target}; check Vercel login/project access. No local values were replaced.`,
      );
    let rows: RemoteEntry[];
    try {
      const data = JSON.parse(response.stdout || '');
      rows = Array.isArray(data) ? data : data.envs || data.variables;
      if (!Array.isArray(rows)) throw new Error();
    } catch {
      throw new EnvSyncError(
        'Unexpected Vercel environment-list format. No local values were replaced.',
      );
    }
    readable[target] = {};
    for (const row of rows) {
      if (!row || typeof row.key !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(row.key))
        throw new EnvSyncError(
          'Invalid environment metadata from Vercel. No local values were replaced.',
        );
      if (
        row.gitBranch ||
        (Array.isArray(row.target) && !row.target.includes(target)) ||
        row.key.startsWith('VERCEL_') ||
        row.key.endsWith('_ROTATION_KEYS') ||
        row.key === 'PASTORAL_OLD_ENCRYPTION_KEY'
      )
        continue;
      const name = row.key;
      const hasReadableValue =
        !['sensitive', 'secret'].includes((row.type || '').toLowerCase()) &&
        typeof row.value === 'string';
      if (!hasReadableValue) {
        const existing = Object.prototype.hasOwnProperty.call(scoped[target], name)
          ? scoped[target][name]
          : shared[name];
        (existing === undefined || existing === '' ? result.missing : result.preserved).push(
          `${target}:${name}`,
        );
        continue;
      }
      readable[target]![name] = row.value as string;
      result.readable++;
    }
  }
  const names = new Set(selected.flatMap((target) => Object.keys(readable[target]!)));
  for (const name of names) {
    const sharedName =
      name !== 'DATABASE_URL' &&
      (shareFromLocal.has(name) || Object.prototype.hasOwnProperty.call(shared, name));
    const bothKnown =
      selected.length === 2 &&
      targets.every((target) => Object.prototype.hasOwnProperty.call(readable[target]!, name));
    if (sharedName && bothKnown && readable.preview![name] === readable.production![name]) {
      shared[name] = readable.preview![name];
      for (const target of targets) delete scoped[target][name];
      continue;
    }
    for (const target of selected) {
      if (!Object.prototype.hasOwnProperty.call(readable[target]!, name)) continue;
      const value = readable[target]![name];
      if (
        sharedName &&
        Object.prototype.hasOwnProperty.call(shared, name) &&
        shared[name] === value
      )
        delete scoped[target][name];
      else scoped[target][name] = value; // An explicit remote empty string overrides the shared value.
    }
    if (sharedName && bothKnown) {
      for (const target of targets) scoped[target][name] = readable[target]![name];
      delete shared[name];
      result.split.push(name);
    }
  }
  // Keep a private snapshot before replacing user-editable files. CLI output and values are never logged.
  const backup = join(root, '.ops', `vercel-env-${Date.now()}-${randomBytes(4).toString('hex')}`);
  mkdirSync(backup, { recursive: true, mode: 0o700 });
  for (const name of ['shared', ...selected]) {
    const file = `.env.vercel.${name}`;
    writeFileSync(join(backup, file), readFileSync(join(root, file)), { mode: 0o600, flag: 'wx' });
  }
  saveValues(root, '.env.vercel.shared', shared);
  for (const target of selected) saveValues(root, `.env.vercel.${target}`, scoped[target]);
  return result;
}
export function main(args: string[], root = process.cwd()): void {
  if (args.includes('--help')) {
    console.log(
      'Usage: env:vercel:init | env:vercel:split | env:vercel:plan [preview|production|all] | env:vercel:push[:preview|:production] | env:vercel:pull[:preview|:production]. Explicit empty assignments are preserved. Secret values are never logged.',
    );
    return;
  }
  if (args[0] === 'init' && args.length === 1) {
    const created = initialize(root);
    console.log(
      created.length
        ? `Created ${created.map((file) => file.slice(root.length + 1)).join(', ')} with permissions 0600. Existing shared values were preserved; no keys were generated.`
        : 'Private environment files already exist; nothing changed.',
    );
    return;
  }
  if (args[0] === 'split' && args.length === 1) {
    const result = splitLocal(root);
    console.log(
      `Split existing local settings: ${result.shared} shared and ${result.production} production assignments filled. Existing deployment values, including explicit empty assignments, and local .env were preserved. Preview-specific connections must come from Preview settings.`,
    );
    if (result.localOnly.length) console.log(`Kept local-only: ${result.localOnly.join(', ')}`);
    return;
  }
  if (args[0] === 'pull') {
    const selected = args[1] || 'all';
    if (args.length > 2 || !['all', 'preview', 'production'].includes(selected))
      throw new EnvSyncError('Pull requires all, preview or production.');
    const result = pullEnvironments(root, selected === 'all' ? targets : [selected as Target]);
    console.log(
      `Pulled ${result.readable} readable assignments, including explicit empty values. Local-only assignments were retained.`,
    );
    if (result.preserved.length)
      console.log(
        `Unreadable hosted secrets; local copies preserved (not verified against Vercel): ${result.preserved.join(', ')}`,
      );
    if (result.missing.length)
      console.log(
        `Unreadable secrets without a nonempty local copy; recover from your secret manager: ${result.missing.join(', ')}`,
      );
    if (result.split.length)
      console.log(`Different hosted values kept environment-specific: ${result.split.join(', ')}`);
    return;
  }
  const selected = args[0] || 'all';
  if (
    !['preview', 'production', 'all'].includes(selected) ||
    args.slice(1).some((arg) => arg !== '--apply')
  )
    throw new EnvSyncError(
      'Choose preview, production or all; use --apply only when ready to push.',
    );
  const plans = preparePlans(root, selected === 'all' ? targets : [selected as Target]);
  for (const plan of plans) {
    console.log(`${plan.target}: ${Object.keys(plan.entries).length} configured values to upsert`);
    for (const warning of plan.warnings || []) console.log(`  WARNING: ${warning}`);
    for (const [name, entry] of Object.entries(plan.entries).sort(([a], [b]) => a.localeCompare(b)))
      console.log(
        `  ${name} (${entry.type}; ${entry.source}${entry.value === '' ? '; EMPTY' : ''})`,
      );
  }
  if (!args.includes('--apply')) {
    console.log(
      'Read-only local plan. Remote values were not read; explicit empty assignments are included. Removing a local entry does not delete its hosted setting.',
    );
    return;
  }
  const count = pushPlans(root, plans);
  console.log(
    `Pushed ${count} environment assignments. Redeploy the selected environments for changes to take effect. No deployment or record re-encryption was run.`,
  );
}
