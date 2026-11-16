import { randomBytes } from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  chmodSync,
  rmSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
import { queueRedisUrl } from '../../src/queues/redis-connection';

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
const configFile = '.env.vercel.json';
const scopedOnly = new Set([
  'DATABASE_URL',
  'WEB_URL',
  'PUBLIC_API_URL',
  'REDIS_URL',
  'UPSTASH_REDIS_TOKEN',
  'QUEUE_REDIS_URL',
]);
type Section = 'shared' | Target;
interface ConfigState {
  shared: Record<string, string>;
  preview: Record<string, string>;
  production: Record<string, string>;
  format: 'json' | 'legacy';
}
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
  'WORKER_HEALTH_PORT',
  'WEB_URL',
  'PUBLIC_API_URL',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SENTRY_DSN',
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
function variableType(name: string, value: string): Entry['type'] {
  if (value === '') return 'config';
  // Modern Sentry DSNs are public ingest identifiers; preserve legacy secret-bearing DSNs.
  if (name === 'SENTRY_DSN') {
    try {
      return new URL(value).password ? 'secret' : 'config';
    } catch {
      return 'secret';
    }
  }
  return publicSettings.has(name) ? 'config' : 'secret';
}
const shareFromLocal = new Set([
  ...Object.keys(SECRET_RULES),
  ...Object.keys(SECRET_RULES).map((key) => `${key}_PREVIOUS_KEYS`),
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
export function initialize(root: string, options: { seedLocal?: boolean } = {}): string[] {
  if (existsSync(join(root, configFile))) return [];
  const local =
    options.seedLocal !== false && existsSync(join(root, '.env'))
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
function encryptedStorageValue(value: string): boolean {
  if (!/^[A-Za-z0-9+/=_-]+$/.test(value)) return false;
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
    return (
      decoded &&
      /^v[0-9]+$/.test(decoded.v) &&
      typeof decoded.c === 'string' &&
      (Array.isArray(decoded.k) || typeof decoded.k === 'string')
    );
  } catch {
    return false;
  }
}
function loadState(root: string): ConfigState {
  if (!existsSync(join(root, configFile)))
    return {
      shared: readEnvFile(join(root, '.env.vercel.shared')),
      preview: readEnvFile(join(root, '.env.vercel.preview')),
      production: readEnvFile(join(root, '.env.vercel.production')),
      format: 'legacy',
    };
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(join(root, configFile), 'utf8'));
  } catch {
    throw new EnvSyncError(
      `Cannot parse ${configFile}. Use valid JSON with shared, preview and production sections.`,
    );
  }
  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    Object.keys(data).some((key) => !['shared', ...targets].includes(key))
  )
    throw new EnvSyncError(
      `Invalid sections in ${configFile}. Use shared, preview and production.`,
    );
  const state: ConfigState = { shared: {}, preview: {}, production: {}, format: 'json' };
  for (const section of ['shared', ...targets] as Section[]) {
    const values = (data as Record<string, unknown>)[section];
    if (!values || typeof values !== 'object' || Array.isArray(values))
      throw new EnvSyncError(`Missing or invalid ${section} section in ${configFile}.`);
    for (const [name, value] of Object.entries(values)) {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(name))
        throw new EnvSyncError(`Invalid variable name in ${configFile} ${section}.`);
      if (typeof value === 'string') state[section][name] = value;
      else if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))
        state[section][name] = String(value);
      else if (
        name.endsWith('_PREVIOUS_KEYS') &&
        Array.isArray(value) &&
        value.every((item) => typeof item === 'string')
      )
        state[section][name] = JSON.stringify(value);
      else
        throw new EnvSyncError(
          `Invalid value type for ${section}.${name}; use a string, number, boolean or previous-key string array.`,
        );
    }
  }
  return state;
}
function backupFiles(root: string, files: string[]): string {
  const backup = join(root, '.ops', `vercel-env-${Date.now()}-${randomBytes(4).toString('hex')}`);
  mkdirSync(backup, { recursive: true, mode: 0o700 });
  for (const file of files)
    if (existsSync(join(root, file)))
      writeFileSync(join(backup, file), readFileSync(join(root, file)), {
        mode: 0o600,
        flag: 'wx',
      });
  return backup;
}
function writeJsonState(root: string, state: ConfigState): void {
  const data: Record<string, Record<string, unknown>> = {};
  for (const section of ['shared', ...targets] as Section[]) {
    data[section] = {};
    for (const name of Object.keys(state[section]).sort()) {
      const value = state[section][name];
      let serialized: unknown = value;
      if (name.endsWith('_PREVIOUS_KEYS') && value) {
        try {
          const parsed: unknown = JSON.parse(value);
          if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string'))
            serialized = parsed;
        } catch {
          /* Preserve malformed input so validation can report it without guessing. */
        }
      }
      data[section][name] = serialized;
    }
  }
  const destination = join(root, configFile),
    temporary = `${destination}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  chmodSync(temporary, 0o600);
  renameSync(temporary, destination);
}
function saveState(root: string, state: ConfigState, sections: Section[]): void {
  if (state.format === 'json') {
    backupFiles(root, [configFile]);
    writeJsonState(root, state);
  } else {
    backupFiles(
      root,
      sections.map((section) => `.env.vercel.${section}`),
    );
    for (const section of sections) saveValues(root, `.env.vercel.${section}`, state[section]);
  }
}
export function migrateSingleFile(root: string): { created: boolean; cleared: string[] } {
  if (existsSync(join(root, configFile))) {
    loadState(root);
    return { created: false, cleared: [] };
  }
  initialize(root, { seedLocal: false });
  const state = loadState(root);
  const cleared: string[] = [];
  for (const section of ['shared', ...targets] as Section[])
    for (const [name, value] of Object.entries(state[section])) {
      if (encryptedStorageValue(value)) {
        state[section][name] = '';
        cleared.push(`${section}.${name}`);
      }
    }
  addRotationKeySlots(state.shared);
  const oldFiles = ['shared', ...targets].map((section) => `.env.vercel.${section}`);
  backupFiles(root, oldFiles);
  writeJsonState(root, state);
  loadState(root); // Verify before retiring the old editable copies.
  for (const file of oldFiles) rmSync(join(root, file));
  return { created: true, cleared };
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
  if (values.QUEUE_REDIS_URL) {
    try {
      const url = new URL(queueRedisUrl((name) => values[name]));
      if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error();
    } catch {
      throw new EnvSyncError(`${plan.target}: QUEUE_REDIS_URL must be a hosted Redis TCP/TLS URL.`);
    }
  } else if (values.REDIS_URL?.startsWith('https://')) {
    plan.warnings!.push(
      'QUEUE_REDIS_URL is missing: BullMQ requires the Redis TCP/TLS connection, not the HTTPS REST endpoint.',
    );
  }
  try {
    redisNamespace((name) => (name === 'VERCEL_ENV' ? plan.target : values[name]));
  } catch {
    throw new EnvSyncError(`${plan.target}: invalid REDIS_NAMESPACE.`);
  }
}
export function preparePlans(root: string, selected: Target[]): EnvPlan[] {
  const state = loadState(root);
  const shared = state.shared;
  for (const name of scopedOnly)
    if (Object.prototype.hasOwnProperty.call(shared, name))
      throw new EnvSyncError(`${name} belongs in each environment section, not shared.`);
  const plans = selected.map((target) => {
    const entries: Record<string, Entry> = {};
    for (const [source, values] of [
      ['shared', shared],
      [target, state[target]],
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
          source: state.format === 'json' ? `${configFile} → ${source}` : `.env.vercel.${source}`,
          type: variableType(name, value),
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
interface VercelProjectLink {
  projectId: string;
  orgId: string;
}
function projectLink(projectId: unknown, orgId: unknown, file: string): VercelProjectLink {
  if (![projectId, orgId].every((id) => typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id)))
    throw new EnvSyncError(
      `Invalid Vercel project IDs in ${file}. Run vercel link again for this backend.`,
    );
  return { projectId: projectId as string, orgId: orgId as string };
}
function readLink(file: string): Record<string, unknown> {
  try {
    const data: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data as Record<string, unknown>;
  } catch {
    throw new EnvSyncError(
      `Cannot read Vercel project link ${file}. Run vercel link again for this backend.`,
    );
  }
}
/** CLI links may be per-directory or repository mappings. Never choose an unrelated project. */
export function resolveVercelProject(root: string): VercelProjectLink {
  const backend = resolve(root);
  const direct = join(backend, '.vercel/project.json');
  if (existsSync(direct)) {
    const data = readLink(direct);
    return projectLink(data.projectId, data.orgId, direct);
  }
  for (let directory = backend; ; directory = dirname(directory)) {
    const file = join(directory, '.vercel/repo.json');
    if (existsSync(file)) {
      const data = readLink(file);
      if (!Array.isArray(data.projects))
        throw new EnvSyncError(`Invalid project mapping in ${file}. Run vercel link again.`);
      const matches = data.projects.filter((entry: unknown) => {
        if (!entry || typeof entry !== 'object') return false;
        const project = entry as Record<string, unknown>;
        return (
          typeof project.directory === 'string' && resolve(directory, project.directory) === backend
        );
      }) as Record<string, unknown>[];
      if (matches.length !== 1)
        throw new EnvSyncError(
          matches.length
            ? 'Multiple Vercel repository links match this backend directory. Create an explicit per-directory link before syncing.'
            : 'The Vercel repository link does not include this backend directory. Run vercel link from the backend directory.',
        );
      return projectLink(matches[0].id, matches[0].orgId ?? data.orgId, file);
    }
    if (dirname(directory) === directory) break;
  }
  throw new EnvSyncError(
    'Link this backend project first: run vercel login, then vercel link from this directory.',
  );
}
export function pushPlans(root: string, plans: EnvPlan[], run: Runner = spawnSync): number {
  const project = resolveVercelProject(root);
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
  const project = resolveVercelProject(root);
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
  const state = loadState(root);
  const { shared, production } = state;
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
  saveState(root, state, ['shared', 'production']);
  return { shared: sharedCount, production: productionCount, localOnly };
}
function addRotationKeySlots(shared: Record<string, string>): string[] {
  const added: string[] = [];
  for (const name of Object.keys(SECRET_RULES)) {
    for (const [key, defaultValue] of [
      [name, ''],
      [`${name}_PREVIOUS_KEYS`, '[]'],
    ]) {
      if (Object.prototype.hasOwnProperty.call(shared, key)) continue;
      shared[key] = defaultValue;
      added.push(key);
    }
  }
  return added;
}
/** Add configuration slots only; never generate keys or guess previous key values. */
export function ensureRotationKeySlots(root: string): string[] {
  initialize(root, { seedLocal: false });
  const state = loadState(root);
  const added = addRotationKeySlots(state.shared);
  if (added.length) saveState(root, state, ['shared']);
  return added;
}
function hiddenValue(row: { type?: string; visibility?: string }): boolean {
  return [row.type, row.visibility].some((value) =>
    ['secret', 'sensitive'].includes((value || '').toLowerCase()),
  );
}
interface RemoteEntry {
  key: string;
  type?: string;
  value?: unknown;
  visibility?: string;
  target?: string[];
  gitBranch?: string | null;
}
export interface PullResult {
  readable: number;
  unreadable: string[];
  split: string[];
}
export function pullEnvironments(
  root: string,
  selected: Target[],
  run: Runner = spawnSync,
): PullResult {
  initialize(root, { seedLocal: false });
  const { project, options } = cliContext(root, run);
  const state = loadState(root);
  const shared = state.shared;
  const scoped = { preview: state.preview, production: state.production };
  const readable: Partial<Record<Target, Record<string, string>>> = {};
  const result: PullResult = { readable: 0, unreadable: [], split: [] };
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
    const exportDirectory = join(root, '.ops', `vercel-download-${randomBytes(8).toString('hex')}`);
    const exportFile = join(exportDirectory, 'values.env');
    let exported: Record<string, string> = {};
    const needsExport = rows.some(
      (row) => !row.gitBranch && !hiddenValue(row) && !row.key?.startsWith('VERCEL_'),
    );
    if (needsExport) {
      mkdirSync(exportDirectory, { recursive: true, mode: 0o700 });
      writeFileSync(exportFile, '', { mode: 0o600, flag: 'wx' });
      try {
        const download = run(
          'vercel',
          [
            'env',
            'pull',
            exportFile,
            '--environment',
            target,
            '--yes',
            '--project',
            project.projectId,
            '--scope',
            project.orgId,
          ],
          options,
        );
        if (download.status !== 0 || download.error)
          throw new EnvSyncError(
            `Cannot export readable ${target} settings from Vercel. No local values were replaced.`,
          );
        exported = parse(readFileSync(exportFile, 'utf8'));
      } finally {
        rmSync(exportDirectory, { recursive: true, force: true });
      }
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
      const hasReadableValue = !hiddenValue(row);
      if (hasReadableValue && !Object.prototype.hasOwnProperty.call(exported, name))
        throw new EnvSyncError(
          `Readable ${target}.${name} was missing from Vercel's decrypted export. No local values were replaced.`,
        );
      if (!hasReadableValue) {
        // A hidden value is represented as empty, never filled from any local source.
        readable[target]![name] = '';
        result.unreadable.push(`${target}:${name}`);
      } else {
        const value = exported[name];
        if (encryptedStorageValue(value))
          throw new EnvSyncError(
            `Vercel exported an encrypted storage payload for ${target}.${name}; no local values were replaced.`,
          );
        readable[target]![name] = value;
        result.readable++;
      }
    }
  }
  const names = new Set(selected.flatMap((target) => Object.keys(readable[target]!)));
  for (const name of names) {
    if (scopedOnly.has(name) && selected.length === 2) delete shared[name];
    const sharedName =
      !scopedOnly.has(name) &&
      (shareFromLocal.has(name) || Object.prototype.hasOwnProperty.call(shared, name));
    const bothKnown =
      selected.length === 2 &&
      targets.every((target) => Object.prototype.hasOwnProperty.call(readable[target]!, name));
    const knownTargets = selected.filter((target) =>
      Object.prototype.hasOwnProperty.call(readable[target]!, name),
    );
    const pulledValue = readable[knownTargets[0]]![name];
    const redactedShared = knownTargets.some((target) =>
      result.unreadable.includes(`${target}:${name}`),
    );
    if (
      sharedName &&
      selected.length === 2 &&
      (bothKnown || redactedShared) &&
      knownTargets.every((target) => readable[target]![name] === pulledValue)
    ) {
      shared[name] = pulledValue;
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
  addRotationKeySlots(shared);
  saveState(root, state, ['shared', ...selected]);
  return result;
}
export function main(args: string[], root = process.cwd()): void {
  if (args.includes('--help')) {
    console.log(
      'Usage: env:vercel:init | env:vercel:migrate | env:vercel:keys | env:vercel:split | env:vercel:plan [preview|production|all] | env:vercel:push[:preview|:production] | env:vercel:pull[:preview|:production]. Explicit empty assignments are preserved. Secret values are never logged.',
    );
    return;
  }
  const migrated = migrateSingleFile(root);
  if (migrated.created)
    console.log(
      `Created ${configFile} with shared, preview and production sections. Old editable files were archived privately.`,
    );
  if (migrated.cleared.length)
    console.log(
      `Encrypted storage payloads cleared; pull again for actual readable values: ${migrated.cleared.join(', ')}`,
    );
  if (['init', 'migrate'].includes(args[0]) && args.length === 1) {
    console.log(`Edit ${configFile}. No hosted settings or runtime .env values were changed.`);
    return;
  }
  if (args[0] === 'keys' && args.length === 1) {
    const added = ensureRotationKeySlots(root);
    console.log(
      added.length
        ? `Added shared rotation slots: ${added.join(', ')}. Current keys are blank; previous-key lists default to []. No key values were generated or copied.`
        : 'All current-key and previous-key-list slots already exist in .env.vercel.json → shared.',
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
    if (result.unreadable.length)
      console.log(
        `Unreadable sensitive values written as empty local assignments (no local fallback): ${result.unreadable.join(', ')}`,
      );
    if (result.split.length)
      console.log(`Different pulled values kept environment-specific: ${result.split.join(', ')}`);
    console.log(
      'Current-key and previous-key-list slots are available in .env.vercel.json → shared. No key values were generated.',
    );
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
