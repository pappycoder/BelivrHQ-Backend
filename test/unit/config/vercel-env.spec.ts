import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  rmSync,
  statSync,
  cpSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'dotenv';
import {
  initialize,
  resolveVercelProject,
  ensureRotationKeySlots,
  migrateSingleFile,
  splitLocal,
  preparePlans,
  readEnvFile,
  pullEnvironments,
  pushPlans,
  Runner,
} from '../../../scripts/lib/vercel-env';
const key = 'ab'.repeat(32);
let root: string;
const write = (file: string, text: string) => writeFileSync(join(root, file), text);
const values = (file: string) => parse(readFileSync(join(root, file), 'utf8'));
function configured() {
  write(
    '.env.vercel.shared',
    `NODE_ENV=production\nALTCHA_HMAC_KEY=${key}\nPASTORAL_ENCRYPTION_KEY=${key}\nINTEGRATIONS_ENCRYPTION_KEY=${key}\nSENTRY_DSN=\n`,
  );
  for (const target of ['preview', 'production'])
    write(
      `.env.vercel.${target}`,
      `DATABASE_URL=postgresql://user:private@${target}.example/db\nSUPABASE_URL=https://${target}.supabase.co\nSUPABASE_SERVICE_ROLE_KEY=private-${target}\nSUPABASE_ANON_KEY=anon-${target}\nWEB_URL=https://${target}.example\nREDIS_URL=redis://private:credential@redis.example:6379\n`,
    );
}
function linked() {
  mkdirSync(join(root, '.vercel'));
  write(
    '.vercel/project.json',
    JSON.stringify({ projectId: 'prj_backend', orgId: 'team_backend' }),
  );
}
function remote(records: Record<string, unknown[]>): Runner {
  return jest.fn((_, args) => {
    const rows = records[args[args.indexOf('--environment') + 1]] || [];
    if (args[1] === 'pull') {
      const entries = rows as {
        key: string;
        value?: string;
        exportValue?: string;
        type?: string;
        visibility?: string;
        gitBranch?: string;
      }[];
      const text = entries
        .filter(
          (row) =>
            !row.gitBranch &&
            !['secret', 'sensitive'].includes(row.type || '') &&
            !['secret', 'sensitive'].includes(row.visibility || ''),
        )
        .map((row) => {
          const value = row.exportValue ?? row.value;
          return value === undefined ? '' : `${row.key}='${value}'`;
        })
        .filter(Boolean)
        .join('\n');
      writeFileSync(args[2], text);
      return { status: 0, stdout: 'Downloaded private export' };
    }
    return { status: 0, stdout: JSON.stringify({ envs: rows }) };
  });
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'belivrhq-vercel-env-'));
  mkdirSync(join(root, 'config'), { recursive: true });
  cpSync(resolve(__dirname, '../../../config/vercel'), join(root, 'config/vercel'), {
    recursive: true,
  });
  initialize(root);
  configured();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('Private local env splitting and plans', () => {
  it('splits every existing variable without copying production connections into preview or changing local runtime settings', () => {
    write(
      '.env',
      `ALTCHA_HMAC_KEY=${key}\nDATABASE_URL=postgresql://prod.example/db\nPUBLIC_API_URL=http://localhost:3001\nRESEND_API_KEY=old-provider-secret\nOPTIONAL_SETTING=\n`,
    );
    const before = readFileSync(join(root, '.env'), 'utf8');
    splitLocal(root);
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe(before);
    expect(values('.env.vercel.production').RESEND_API_KEY).toBe('old-provider-secret');
    expect(values('.env.vercel.production').DATABASE_URL).toContain('production.example'); // Preserves already configured deployment values.
    expect(values('.env.vercel.preview').RESEND_API_KEY).toBeUndefined();
    expect(values('.env.vercel.production').PUBLIC_API_URL).toBeUndefined();
    expect(values('.env.vercel.production').OPTIONAL_SETTING).toBe('');
    expect(statSync(join(root, '.env.vercel.shared')).mode & 0o777).toBe(0o600);
  });
  it('does not refill an explicit empty value from the old local runtime file during a later split', () => {
    write('.env', 'SENTRY_DSN=https://old-local.example/1\nRESEND_API_KEY=old-key\n');
    write(
      '.env.vercel.production',
      readFileSync(join(root, '.env.vercel.production'), 'utf8') + 'RESEND_API_KEY=\n',
    );
    splitLocal(root);
    expect(values('.env.vercel.shared').SENTRY_DSN).toBe('');
    expect(values('.env.vercel.production').RESEND_API_KEY).toBe('');
  });
  it('seeds production-specific values only when creating fresh private files', () => {
    for (const name of ['shared', 'preview', 'production'])
      rmSync(join(root, `.env.vercel.${name}`));
    write(
      '.env',
      `DATABASE_URL=postgresql://existing.example/db\nRESEND_API_KEY=existing-key\nPUBLIC_API_URL=http://localhost:3001\nNODE_ENV=development\nALTCHA_HMAC_KEY=${key}\n`,
    );
    initialize(root);
    expect(values('.env.vercel.production').DATABASE_URL).toBe('postgresql://existing.example/db');
    expect(values('.env.vercel.production').RESEND_API_KEY).toBe('existing-key');
    expect(values('.env.vercel.preview').DATABASE_URL).toBe('');
    expect(values('.env.vercel.production').PUBLIC_API_URL).toBe('');
    expect(values('.env.vercel.production').NODE_ENV).toBeUndefined();
    expect(values('.env.vercel.shared').ALTCHA_HMAC_KEY).toBe(key);
  });
  it('keeps explicit empty overrides instead of falling back to shared settings', () => {
    write(
      '.env.vercel.preview',
      readFileSync(join(root, '.env.vercel.preview'), 'utf8') +
        'SENTRY_DSN=\nINTEGRATIONS_ENCRYPTION_KEY=\n',
    );
    const plans = preparePlans(root, ['preview', 'production']);
    expect(plans[0].entries.INTEGRATIONS_ENCRYPTION_KEY.value).toBe('');
    expect(plans[1].entries.INTEGRATIONS_ENCRYPTION_KEY.value).toBe(key);
    expect(plans[0].entries.SENTRY_DSN.value).toBe('');
  });
  it('keeps credentials write-only while making public configuration retrievable', () => {
    const shared = values('.env.vercel.shared');
    Object.assign(shared, {
      SENTRY_DSN: 'https://public@ingest.sentry.example/1',
      TWO_FACTOR_ENCRYPTION_KEY: key,
      INTERNAL_PROXY_SECRET: key,
      MEDIA_UPLOAD_SIGNING_KEY: key,
      INTEGRATIONS_ENCRYPTION_KEY_PREVIOUS_KEYS: JSON.stringify([key]),
      RESEND_API_KEY: 'test-private-mail',
      OPENAI_API_KEY: 'test-private-ai',
      FLUTTERWAVE_SECRET_KEY: 'test-private-gateway',
      FLUTTERWAVE_WEBHOOK_SECRET: 'test-private-hook',
      PAYSTACK_SECRET_KEY: 'test-private-paystack',
      PAYSTACK_WEBHOOK_SECRET: 'test-private-paystack-hook',
      UNKNOWN_FUTURE_API_KEY: 'test-private-future',
      RESEND_FROM: 'noreply@example.invalid',
      SUPABASE_STORAGE_BUCKET: 'media',
      REDIS_NAMESPACE: 'production',
    });
    write(
      '.env.vercel.shared',
      Object.entries(shared)
        .map(([name, value]) => `${name}=${value}`)
        .join('\n'),
    );
    write(
      '.env.vercel.production',
      readFileSync(join(root, '.env.vercel.production'), 'utf8') +
        'UPSTASH_REDIS_TOKEN=test-private-token\n',
    );
    const plan = preparePlans(root, ['production'])[0];
    for (const name of [
      'SUPABASE_URL',
      'SUPABASE_ANON_KEY',
      'SUPABASE_STORAGE_BUCKET',
      'SENTRY_DSN',
      'RESEND_FROM',
      'REDIS_NAMESPACE',
      'WEB_URL',
      'NODE_ENV',
    ])
      expect(plan.entries[name].type).toBe('config');
    for (const name of [
      'DATABASE_URL',
      'SUPABASE_SERVICE_ROLE_KEY',
      'REDIS_URL',
      'UPSTASH_REDIS_TOKEN',
      'ALTCHA_HMAC_KEY',
      'PASTORAL_ENCRYPTION_KEY',
      'INTEGRATIONS_ENCRYPTION_KEY',
      'INTEGRATIONS_ENCRYPTION_KEY_PREVIOUS_KEYS',
      'TWO_FACTOR_ENCRYPTION_KEY',
      'INTERNAL_PROXY_SECRET',
      'MEDIA_UPLOAD_SIGNING_KEY',
      'FLUTTERWAVE_SECRET_KEY',
      'FLUTTERWAVE_WEBHOOK_SECRET',
      'PAYSTACK_SECRET_KEY',
      'PAYSTACK_WEBHOOK_SECRET',
      'RESEND_API_KEY',
      'OPENAI_API_KEY',
      'UNKNOWN_FUTURE_API_KEY',
    ])
      expect(plan.entries[name].type).toBe('secret');
  });
  it('does not expose legacy Sentry DSNs containing a secret component', () => {
    write(
      '.env.vercel.production',
      readFileSync(join(root, '.env.vercel.production'), 'utf8') +
        'SENTRY_DSN=https://public:private@ingest.sentry.example/1\n',
    );
    expect(preparePlans(root, ['production'])[0].entries.SENTRY_DSN.type).toBe('secret');
  });
  it('warns about required empty settings while preserving the explicitly requested empty assignment', () => {
    write('.env.vercel.production', 'DATABASE_URL=\n');
    const plan = preparePlans(root, ['production'])[0];
    expect(plan.entries.DATABASE_URL.value).toBe('');
    expect(plan.warnings?.join(' ')).toContain('DATABASE_URL');
  });
  it.each(['KEY=value\nKEY=other', 'broken assignment', 'KEY="unclosed'])(
    'rejects malformed dotenv data without revealing values',
    (content) => {
      write('test.env', content);
      expect(() => readEnvFile(join(root, 'test.env'))).toThrow();
    },
  );
  it('treats shell substitutions as literal values', () => {
    write('test.env', "KEY='$(private-command) # literal'\nEMPTY=\n");
    expect(readEnvFile(join(root, 'test.env'))).toEqual({
      KEY: '$(private-command) # literal',
      EMPTY: '',
    });
  });
  it('refuses to publish a local development Redis endpoint to Vercel', () => {
    write(
      '.env.vercel.preview',
      readFileSync(join(root, '.env.vercel.preview'), 'utf8').replace(
        'REDIS_URL=redis://private:credential@redis.example:6379',
        'REDIS_URL=redis://localhost:6379',
      ),
    );
    expect(() => preparePlans(root, ['preview'])).toThrow('hosted Redis service');
  });
  it('blocks migration-only key material and shared production database configuration', () => {
    write('.env.vercel.shared', `DATABASE_URL=postgresql://prod.example/db\n`);
    expect(() => preparePlans(root, ['production'])).toThrow('belongs in each environment');
    configured();
    write(
      '.env.vercel.shared',
      readFileSync(join(root, '.env.vercel.shared'), 'utf8') +
        'INTEGRATIONS_ENCRYPTION_KEY_ROTATION_KEYS=[]\n',
    );
    expect(() => preparePlans(root, ['production'])).toThrow('operator/platform-owned');
  });
  it('rejects matching database targets and matching shared Redis namespaces', () => {
    write('.env.vercel.preview', readFileSync(join(root, '.env.vercel.production'), 'utf8'));
    expect(() => preparePlans(root, ['preview', 'production'])).toThrow('separate database');
    configured();
    for (const target of ['preview', 'production'])
      write(
        `.env.vercel.${target}`,
        readFileSync(join(root, `.env.vercel.${target}`), 'utf8') + 'REDIS_NAMESPACE=identical\n',
      );
    expect(() => preparePlans(root, ['preview', 'production'])).toThrow(
      'different Preview and Production namespaces',
    );
  });
});

describe('Vercel link formats', () => {
  function repository(projects: unknown[], extra: Record<string, unknown> = {}) {
    mkdirSync(join(root, '.vercel'), { recursive: true });
    write('.vercel/repo.json', JSON.stringify({ remoteName: 'origin', ...extra, projects }));
  }
  it('resolves the repository link written by the current CLI for this directory', () => {
    repository([{ id: 'prj_backend_repo', orgId: 'team_repo', directory: '.', name: 'backend' }]);
    expect(resolveVercelProject(root)).toEqual({
      projectId: 'prj_backend_repo',
      orgId: 'team_repo',
    });
  });
  it('uses an explicit per-directory project link before repository mappings', () => {
    linked();
    repository([{ id: 'prj_different', orgId: 'team_different', directory: '.' }]);
    expect(resolveVercelProject(root)).toEqual({ projectId: 'prj_backend', orgId: 'team_backend' });
  });
  it('resolves an exact backend path in an ancestor repository without selecting the web project', () => {
    const parent = join(root, 'monorepo');
    const backend = join(parent, 'apps/backend');
    mkdirSync(join(parent, '.vercel'), { recursive: true });
    mkdirSync(backend, { recursive: true });
    writeFileSync(
      join(parent, '.vercel/repo.json'),
      JSON.stringify({
        orgId: 'team_parent',
        projects: [
          { id: 'prj_web', directory: 'apps/web' },
          { id: 'prj_backend_parent', directory: 'apps/backend' },
        ],
      }),
    );
    expect(resolveVercelProject(backend)).toEqual({
      projectId: 'prj_backend_parent',
      orgId: 'team_parent',
    });
  });
  it.each([
    { projects: [], message: 'does not include this backend' },
    {
      projects: [{ id: 'prj_web', orgId: 'team_repo', directory: 'web' }],
      message: 'does not include this backend',
    },
    {
      projects: [
        { id: 'prj_one', orgId: 'team_repo', directory: '.' },
        { id: 'prj_two', orgId: 'team_repo', directory: './' },
      ],
      message: 'Multiple Vercel repository links',
    },
    { projects: [{ id: 'prj_one', directory: '.' }], message: 'Invalid Vercel project IDs' },
  ])(
    'rejects unmatched, ambiguous or incomplete repository links: $message',
    ({ projects, message }) => {
      repository(projects);
      expect(() => resolveVercelProject(root)).toThrow(message);
    },
  );
  it('reports a malformed link without treating it as an authentication problem or falling back', () => {
    repository([{ id: 'prj_repo', orgId: 'team_repo', directory: '.' }]);
    write('.vercel/project.json', '{malformed');
    expect(() => resolveVercelProject(root)).toThrow('Cannot read Vercel project link');
  });
  it('uses repository project IDs for both pulls and pushes', () => {
    repository([{ id: 'prj_backend_repo', orgId: 'team_repo', directory: '.' }]);
    const run = jest.fn<ReturnType<Runner>, Parameters<Runner>>((_, args) => ({
      status: 0,
      stdout: args[0] === '--version' ? '65.9.0' : JSON.stringify({ envs: [] }),
    }));
    pullEnvironments(root, ['preview'], run);
    pushPlans(root, preparePlans(root, ['preview']), run);
    for (const [, args] of run.mock.calls.filter(([, args]) => args[0] === 'env')) {
      expect(args).toEqual(
        expect.arrayContaining(['--project', 'prj_backend_repo', '--scope', 'team_repo']),
      );
    }
  });
});

describe('Vercel push protocol', () => {
  it('sends values, including empty strings, only through stdin and scopes updates to the linked backend/environment', () => {
    linked();
    const run = jest.fn<ReturnType<Runner>, Parameters<Runner>>((_, args) => ({
      status: 0,
      stdout: args[0] === '--version' ? '65.9.0' : '',
    }));
    const plans = preparePlans(root, ['preview']);
    pushPlans(root, plans, run);
    const calls = run.mock.calls.filter(([, args]) => args[0] === 'env');
    expect(calls.length).toBe(Object.keys(plans[0].entries).length);
    for (const [, args, options] of calls) {
      expect(args).toEqual(
        expect.arrayContaining([
          '--environment',
          'preview',
          '--project',
          'prj_backend',
          '--scope',
          'team_backend',
          '--force',
          '--yes',
        ]),
      );
      expect(args.join(' ')).not.toContain(key);
      expect(options.input).toBe(plans[0].entries[args[2]].value);
    }
    expect(calls.find(([, args]) => args[2] === 'SENTRY_DSN')![2].input).toBe('');
    const empty = calls.find(([, args]) => args[2] === 'SENTRY_DSN')!;
    expect(empty[1]).toEqual(expect.arrayContaining(['--type', 'config', '--value', '']));
  });
  it('refuses to push before project linking and suppresses potentially secret CLI errors', () => {
    const plans = preparePlans(root, ['production']);
    const run = jest.fn<ReturnType<Runner>, Parameters<Runner>>(() => ({
      status: 0,
      stdout: '65.9.0',
    }));
    expect(() => pushPlans(root, plans, run)).toThrow('Link this backend');
    expect(run).not.toHaveBeenCalled();
    linked();
    run.mockImplementation((_, args) =>
      args[0] === '--version'
        ? { status: 0, stdout: '65.9.0' }
        : { status: 1, stderr: 'LEAKED_PRIVATE_VALUE' },
    );
    try {
      pushPlans(root, plans, run);
      throw new Error('should fail');
    } catch (error) {
      expect(String(error)).toContain('CLI output was suppressed');
      expect(String(error)).not.toContain('LEAKED_PRIVATE_VALUE');
    }
  });
});

describe('Vercel pull reconciliation', () => {
  beforeEach(linked);
  it('preserves remote empty strings as scoped overrides and does not alter the other environment', () => {
    write(
      '.env.vercel.shared',
      readFileSync(join(root, '.env.vercel.shared'), 'utf8').replace(
        'SENTRY_DSN=',
        'SENTRY_DSN=https://shared.example/1',
      ),
    );
    const production = readFileSync(join(root, '.env.vercel.production'), 'utf8');
    pullEnvironments(
      root,
      ['preview'],
      remote({ preview: [{ key: 'SENTRY_DSN', type: 'config', value: '' }] }),
    );
    expect(values('.env.vercel.preview').SENTRY_DSN).toBe('');
    expect(values('.env.vercel.shared').SENTRY_DSN).toBe('https://shared.example/1');
    expect(readFileSync(join(root, '.env.vercel.production'), 'utf8')).toBe(production);
    expect(preparePlans(root, ['preview'])[0].entries.SENTRY_DSN.value).toBe('');
  });
  it('puts equal remote values, including empty values, in shared and differing values in scoped files without losing either', () => {
    const result = pullEnvironments(
      root,
      ['preview', 'production'],
      remote({
        preview: [
          { key: 'SENTRY_DSN', type: 'config', value: '' },
          {
            key: 'REDIS_URL',
            type: 'config',
            value: 'redis://private:credential@redis.example:6379',
          },
        ],
        production: [
          { key: 'SENTRY_DSN', type: 'config', value: '' },
          { key: 'REDIS_URL', type: 'config', value: 'redis://different.example:6379' },
        ],
      }),
    );
    expect(values('.env.vercel.shared').SENTRY_DSN).toBe('');
    expect(values('.env.vercel.preview').SENTRY_DSN).toBeUndefined();
    expect(values('.env.vercel.production').SENTRY_DSN).toBeUndefined();
    expect(values('.env.vercel.shared').REDIS_URL).toBeUndefined();
    expect(values('.env.vercel.preview').REDIS_URL).toContain('credential@redis.example');
    expect(values('.env.vercel.production').REDIS_URL).toBe('redis://different.example:6379');
    expect(result.split).not.toContain('REDIS_URL');
  });
  it('writes unreadable secrets as empty target values without falling back to local shared values', () => {
    const preview = readFileSync(join(root, '.env.vercel.preview'), 'utf8');
    const result = pullEnvironments(
      root,
      ['production'],
      remote({
        production: [
          { key: 'INTEGRATIONS_ENCRYPTION_KEY', type: 'secret', value: 'redactedkey' },
          { key: 'TWO_FACTOR_ENCRYPTION_KEY', type: 'sensitive' },
          {
            key: 'DATABASE_URL',
            type: 'encrypted',
            visibility: 'secret',
            value: 'redacted-database',
          },
        ],
      }),
    );
    expect(values('.env.vercel.production').INTEGRATIONS_ENCRYPTION_KEY).toBe('');
    expect(values('.env.vercel.production').TWO_FACTOR_ENCRYPTION_KEY).toBe('');
    expect(values('.env.vercel.production').DATABASE_URL).toBe('');
    expect(result.unreadable).toEqual([
      'production:INTEGRATIONS_ENCRYPTION_KEY',
      'production:TWO_FACTOR_ENCRYPTION_KEY',
      'production:DATABASE_URL',
    ]);
    expect(preparePlans(root, ['production'])[0].entries.INTEGRATIONS_ENCRYPTION_KEY.value).toBe(
      '',
    );
    expect(readFileSync(join(root, '.env.vercel.preview'), 'utf8')).toBe(preview);
    expect(readFileSync(join(root, '.env.vercel.production'), 'utf8')).not.toContain('redacted');
  });
  it('clears shared and scoped copies when both targets redact a shared key, including hidden previous-key lists', () => {
    for (const target of ['preview', 'production'])
      write(
        `.env.vercel.${target}`,
        readFileSync(join(root, `.env.vercel.${target}`), 'utf8') +
          `INTEGRATIONS_ENCRYPTION_KEY=${key}\nINTEGRATIONS_ENCRYPTION_KEY_PREVIOUS_KEYS='["${key}"]'\n`,
      );
    const records = [
      { key: 'INTEGRATIONS_ENCRYPTION_KEY', type: 'secret' },
      { key: 'INTEGRATIONS_ENCRYPTION_KEY_PREVIOUS_KEYS', type: 'secret' },
    ];
    pullEnvironments(
      root,
      ['preview', 'production'],
      remote({ preview: records, production: records }),
    );
    expect(values('.env.vercel.shared').INTEGRATIONS_ENCRYPTION_KEY).toBe('');
    expect(values('.env.vercel.shared').INTEGRATIONS_ENCRYPTION_KEY_PREVIOUS_KEYS).toBe('');
    for (const target of ['preview', 'production']) {
      expect(values(`.env.vercel.${target}`).INTEGRATIONS_ENCRYPTION_KEY).toBeUndefined();
      expect(
        values(`.env.vercel.${target}`).INTEGRATIONS_ENCRYPTION_KEY_PREVIOUS_KEYS,
      ).toBeUndefined();
    }
    // Entering the replacement shared key now applies to both targets without stale empty overrides.
    write(
      '.env.vercel.shared',
      readFileSync(join(root, '.env.vercel.shared'), 'utf8').replace(
        "INTEGRATIONS_ENCRYPTION_KEY=''",
        `INTEGRATIONS_ENCRYPTION_KEY='${key}'`,
      ),
    );
    expect(
      preparePlans(root, ['preview', 'production']).map(
        (plan) => plan.entries.INTEGRATIONS_ENCRYPTION_KEY.value,
      ),
    ).toEqual([key, key]);
  });
  it('keeps a shared redacted key empty even when it is listed in only one target', () => {
    pullEnvironments(
      root,
      ['preview', 'production'],
      remote({ production: [{ key: 'INTEGRATIONS_ENCRYPTION_KEY', type: 'secret' }] }),
    );
    expect(values('.env.vercel.shared').INTEGRATIONS_ENCRYPTION_KEY).toBe('');
    expect(values('.env.vercel.production').INTEGRATIONS_ENCRYPTION_KEY).toBeUndefined();
  });
  it('never seeds a fresh pull from .env, and adds all new current-key and previous-key slots', () => {
    for (const name of ['shared', 'preview', 'production'])
      rmSync(join(root, `.env.vercel.${name}`));
    write(
      '.env',
      `ALTCHA_HMAC_KEY=${key}\nDATABASE_URL=postgresql://local-copy.example/db\nRESEND_API_KEY=local-provider-key\n`,
    );
    pullEnvironments(
      root,
      ['preview', 'production'],
      remote({ production: [{ key: 'ALTCHA_HMAC_KEY', type: 'secret' }] }),
    );
    expect(values('.env.vercel.shared').ALTCHA_HMAC_KEY).toBe('');
    expect(values('.env.vercel.production').DATABASE_URL).toBe('');
    expect(values('.env.vercel.production').RESEND_API_KEY).toBe('');
    for (const name of [
      'INTEGRATIONS_ENCRYPTION_KEY',
      'TWO_FACTOR_ENCRYPTION_KEY',
      'PASTORAL_ENCRYPTION_KEY',
      'ALTCHA_HMAC_KEY',
      'INTERNAL_PROXY_SECRET',
      'MEDIA_UPLOAD_SIGNING_KEY',
    ]) {
      expect(values('.env.vercel.shared')).toHaveProperty(name);
      expect(values('.env.vercel.shared')[`${name}_PREVIOUS_KEYS`]).toBe('[]');
    }
  });
  it('adds missing shared key slots without generating values or refilling deliberately empty previous-key lists', () => {
    const shared = values('.env.vercel.shared');
    shared.ALTCHA_HMAC_KEY_PREVIOUS_KEYS = '';
    write(
      '.env.vercel.shared',
      Object.entries(shared)
        .map(([name, value]) => `${name}=${value}`)
        .join('\n'),
    );
    const added = ensureRotationKeySlots(root);
    expect(added).toContain('MEDIA_UPLOAD_SIGNING_KEY');
    expect(added).toContain('MEDIA_UPLOAD_SIGNING_KEY_PREVIOUS_KEYS');
    expect(values('.env.vercel.shared').ALTCHA_HMAC_KEY_PREVIOUS_KEYS).toBe('');
    expect(values('.env.vercel.shared').MEDIA_UPLOAD_SIGNING_KEY).toBe('');
    expect(values('.env.vercel.shared').MEDIA_UPLOAD_SIGNING_KEY_PREVIOUS_KEYS).toBe('[]');
    expect(values('.env.vercel.shared').INTEGRATIONS_ENCRYPTION_KEY).toBe(key);
    expect(ensureRotationKeySlots(root)).toEqual([]);
  });
  it('keeps local files unchanged if any selected remote pull fails', () => {
    const before = ['shared', 'preview', 'production'].map((name) =>
      readFileSync(join(root, `.env.vercel.${name}`), 'utf8'),
    );
    const run: Runner = (_, args) => {
      if (!args.includes('preview')) return { status: 1, stderr: 'PRIVATE_ERROR' };
      if (args[1] === 'pull') {
        writeFileSync(args[2], "SENTRY_DSN=''\n");
        return { status: 0 };
      }
      return {
        status: 0,
        stdout: JSON.stringify({ envs: [{ key: 'SENTRY_DSN', type: 'config', value: '' }] }),
      };
    };
    expect(() => pullEnvironments(root, ['preview', 'production'], run)).toThrow(
      'Cannot pull production',
    );
    expect(
      ['shared', 'preview', 'production'].map((name) =>
        readFileSync(join(root, `.env.vercel.${name}`), 'utf8'),
      ),
    ).toEqual(before);
  });
  it('does not import branch-specific overrides or platform/migration variables into default environment files', () => {
    pullEnvironments(
      root,
      ['preview'],
      remote({
        preview: [
          { key: 'SENTRY_DSN', type: 'config', value: 'wrong-branch', gitBranch: 'feature' },
          { key: 'VERCEL_OIDC_TOKEN', type: 'config', value: 'private-token' },
        ],
      }),
    );
    expect(values('.env.vercel.shared').SENTRY_DSN).toBe('');
    expect(values('.env.vercel.preview').VERCEL_OIDC_TOKEN).toBeUndefined();
  });
});

const envelope = Buffer.from(
  JSON.stringify({ v: 'v2', c: 'encrypted-storage-payload', k: [1, 2, 3] }),
).toString('base64');
describe('Decrypted URL export and single-file configuration', () => {
  beforeEach(linked);
  it('uses the supported export for readable URLs instead of encrypted env-list storage fields', () => {
    const run = remote({
      preview: [
        {
          key: 'WEB_URL',
          type: 'encrypted',
          value: envelope,
          exportValue: 'https://preview-web.example',
        },
        {
          key: 'PUBLIC_API_URL',
          type: 'encrypted',
          value: envelope,
          exportValue: 'https://preview-api.example',
        },
      ],
      production: [
        {
          key: 'WEB_URL',
          type: 'encrypted',
          value: envelope,
          exportValue: 'https://live-web.example',
        },
        {
          key: 'PUBLIC_API_URL',
          type: 'encrypted',
          value: envelope,
          exportValue: 'https://live-api.example',
        },
      ],
    });
    pullEnvironments(root, ['preview', 'production'], run);
    expect(values('.env.vercel.preview').WEB_URL).toBe('https://preview-web.example');
    expect(values('.env.vercel.preview').PUBLIC_API_URL).toBe('https://preview-api.example');
    expect(values('.env.vercel.production').WEB_URL).toBe('https://live-web.example');
    expect(values('.env.vercel.production').PUBLIC_API_URL).toBe('https://live-api.example');
    expect(readFileSync(join(root, '.env.vercel.production'), 'utf8')).not.toContain(envelope);
  });
  it('refuses to persist a storage envelope even if an export contains one', () => {
    const before = readFileSync(join(root, '.env.vercel.production'), 'utf8');
    expect(() =>
      pullEnvironments(
        root,
        ['production'],
        remote({ production: [{ key: 'WEB_URL', type: 'encrypted', value: envelope }] }),
      ),
    ).toThrow('encrypted storage payload');
    expect(readFileSync(join(root, '.env.vercel.production'), 'utf8')).toBe(before);
  });
  it('migrates all three files into private JSON, preserving values and empty overrides while clearing unusable envelopes', () => {
    write(
      '.env.vercel.preview',
      readFileSync(join(root, '.env.vercel.preview'), 'utf8').replace(
        'https://preview.example',
        envelope,
      ) + 'SENTRY_DSN=\n',
    );
    const result = migrateSingleFile(root);
    expect(result.created).toBe(true);
    expect(result.cleared).toContain('preview.WEB_URL');
    const data = JSON.parse(readFileSync(join(root, '.env.vercel.json'), 'utf8'));
    expect(data.shared.INTEGRATIONS_ENCRYPTION_KEY).toBe(key);
    expect(data.shared.INTEGRATIONS_ENCRYPTION_KEY_PREVIOUS_KEYS).toEqual([]);
    expect(data.preview.WEB_URL).toBe('');
    expect(data.preview.SENTRY_DSN).toBe('');
    expect(data.production.WEB_URL).toBe('https://production.example');
    expect(statSync(join(root, '.env.vercel.json')).mode & 0o777).toBe(0o600);
    expect(() => readFileSync(join(root, '.env.vercel.preview'))).toThrow();
    expect(migrateSingleFile(root).created).toBe(false);
  });
  it('pulls directly into JSON sections, keeps hidden Secrets empty and never recreates the old editable files', () => {
    migrateSingleFile(root);
    pullEnvironments(
      root,
      ['preview', 'production'],
      remote({
        preview: [
          {
            key: 'WEB_URL',
            type: 'encrypted',
            value: envelope,
            exportValue: 'https://preview-web.example',
          },
          { key: 'ALTCHA_HMAC_KEY', type: 'secret' },
        ],
        production: [
          {
            key: 'WEB_URL',
            type: 'encrypted',
            value: envelope,
            exportValue: 'https://live-web.example',
          },
          { key: 'ALTCHA_HMAC_KEY', type: 'secret' },
        ],
      }),
    );
    const data = JSON.parse(readFileSync(join(root, '.env.vercel.json'), 'utf8'));
    expect(data.shared.ALTCHA_HMAC_KEY).toBe('');
    expect(data.preview.WEB_URL).toBe('https://preview-web.example');
    expect(data.production.WEB_URL).toBe('https://live-web.example');
    expect(() => readFileSync(join(root, '.env.vercel.shared'))).toThrow();
    expect(preparePlans(root, ['production'])[0].entries.WEB_URL.source).toContain(
      '.env.vercel.json',
    );
  });
  it('serializes JSON previous-key arrays for Vercel and preserves deliberately empty overrides', () => {
    migrateSingleFile(root);
    const data = JSON.parse(readFileSync(join(root, '.env.vercel.json'), 'utf8'));
    data.shared.INTEGRATIONS_ENCRYPTION_KEY_PREVIOUS_KEYS = [key];
    data.preview.INTEGRATIONS_ENCRYPTION_KEY_PREVIOUS_KEYS = '';
    data.preview.INTEGRATIONS_ENCRYPTION_KEY = '';
    data.shared.SENTRY_DSN = 'https://public@ingest.sentry.example/1';
    data.preview.SENTRY_DSN = '';
    write('.env.vercel.json', JSON.stringify(data));
    const plans = preparePlans(root, ['preview', 'production']);
    expect(plans[0].entries.SENTRY_DSN.value).toBe('');
    expect(plans[0].entries.INTEGRATIONS_ENCRYPTION_KEY_PREVIOUS_KEYS.value).toBe('');
    expect(plans[1].entries.INTEGRATIONS_ENCRYPTION_KEY_PREVIOUS_KEYS.value).toBe(
      JSON.stringify([key]),
    );
  });
  it('keeps identical URLs in their target sections instead of promoting them into shared', () => {
    migrateSingleFile(root);
    const rows = [
      { key: 'WEB_URL', type: 'config', value: 'https://same.example' },
      { key: 'PUBLIC_API_URL', type: 'config', value: 'https://same-api.example' },
    ];
    pullEnvironments(root, ['preview', 'production'], remote({ preview: rows, production: rows }));
    const data = JSON.parse(readFileSync(join(root, '.env.vercel.json'), 'utf8'));
    expect(data.shared.WEB_URL).toBeUndefined();
    expect(data.shared.PUBLIC_API_URL).toBeUndefined();
    expect(data.preview.WEB_URL).toBe('https://same.example');
    expect(data.production.PUBLIC_API_URL).toBe('https://same-api.example');
  });
});

describe('Single-file and export failure boundaries', () => {
  beforeEach(linked);
  it('does not change configuration if a Config field is absent from the decrypted export', () => {
    migrateSingleFile(root);
    const before = readFileSync(join(root, '.env.vercel.json'), 'utf8');
    const run: Runner = (_, args) =>
      args[1] === 'pull'
        ? { status: 0 }
        : {
            status: 0,
            stdout: JSON.stringify({
              envs: [{ key: 'WEB_URL', type: 'encrypted', value: envelope }],
            }),
          };
    expect(() => pullEnvironments(root, ['production'], run)).toThrow('missing from Vercel');
    expect(readFileSync(join(root, '.env.vercel.json'), 'utf8')).toBe(before);
  });
  it('rejects invalid JSON sections/value types without displaying values', () => {
    migrateSingleFile(root);
    write(
      '.env.vercel.json',
      JSON.stringify({
        shared: {},
        preview: {},
        production: { PRIVATE_VALUE: { secret: 'DONT_LOG_ME' } },
      }),
    );
    try {
      preparePlans(root, ['production']);
      throw new Error('should reject');
    } catch (error) {
      expect(String(error)).toContain('Invalid value type');
      expect(String(error)).not.toContain('DONT_LOG_ME');
    }
  });
});

describe('Environment-specific Redis credentials', () => {
  beforeEach(linked);
  it.each(['REDIS_URL', 'UPSTASH_REDIS_TOKEN'])('rejects %s in shared before pushing', (name) => {
    write(
      '.env.vercel.shared',
      readFileSync(join(root, '.env.vercel.shared'), 'utf8') + `${name}=private-test-value\n`,
    );
    expect(() => preparePlans(root, ['preview'])).toThrow(`${name} belongs in each environment`);
  });
  it('keeps equal readable Redis URLs and tokens target-specific when pulling both environments', () => {
    migrateSingleFile(root);
    const rows = [
      { key: 'REDIS_URL', type: 'config', value: 'https://redis.example' },
      { key: 'UPSTASH_REDIS_TOKEN', type: 'config', value: 'private-test-token' },
    ];
    pullEnvironments(root, ['preview', 'production'], remote({ preview: rows, production: rows }));
    const data = JSON.parse(readFileSync(join(root, '.env.vercel.json'), 'utf8'));
    expect(data.shared.REDIS_URL).toBeUndefined();
    expect(data.shared.UPSTASH_REDIS_TOKEN).toBeUndefined();
    for (const target of ['preview', 'production']) {
      expect(data[target].REDIS_URL).toBe('https://redis.example');
      expect(data[target].UPSTASH_REDIS_TOKEN).toBe('private-test-token');
    }
  });
  it('keeps hidden Redis credentials empty in each target without recreating shared values', () => {
    migrateSingleFile(root);
    const rows = [
      { key: 'REDIS_URL', type: 'secret' },
      { key: 'UPSTASH_REDIS_TOKEN', type: 'secret' },
    ];
    pullEnvironments(root, ['preview', 'production'], remote({ preview: rows, production: rows }));
    const data = JSON.parse(readFileSync(join(root, '.env.vercel.json'), 'utf8'));
    expect(data.shared.REDIS_URL).toBeUndefined();
    expect(data.shared.UPSTASH_REDIS_TOKEN).toBeUndefined();
    expect(data.preview.REDIS_URL).toBe('');
    expect(data.production.REDIS_URL).toBe('');
    expect(data.preview.UPSTASH_REDIS_TOKEN).toBe('');
    expect(data.production.UPSTASH_REDIS_TOKEN).toBe('');
  });
});
