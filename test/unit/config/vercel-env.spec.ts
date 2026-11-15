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
    `NODE_ENV=production\nALTCHA_HMAC_KEY=${key}\nPASTORAL_ENCRYPTION_KEY=${key}\nINTEGRATIONS_ENCRYPTION_KEY=${key}\nREDIS_URL=redis://private:credential@redis.example:6379\nSENTRY_DSN=\n`,
  );
  for (const target of ['preview', 'production'])
    write(
      `.env.vercel.${target}`,
      `DATABASE_URL=postgresql://user:private@${target}.example/db\nSUPABASE_URL=https://${target}.supabase.co\nSUPABASE_SERVICE_ROLE_KEY=private-${target}\nSUPABASE_ANON_KEY=anon-${target}\nWEB_URL=https://${target}.example\n`,
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
  return jest.fn((_, args) => ({
    status: 0,
    stdout: JSON.stringify({ envs: records[args[args.indexOf('--environment') + 1]] || [] }),
  }));
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
      readFileSync(join(root, '.env.vercel.preview'), 'utf8') +
        'REDIS_URL=redis://localhost:6379\n',
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
    expect(result.split).toContain('REDIS_URL');
  });
  it('never replaces local secrets with redacted placeholders and reports unrecoverable local copies', () => {
    const result = pullEnvironments(
      root,
      ['production'],
      remote({
        production: [
          { key: 'INTEGRATIONS_ENCRYPTION_KEY', type: 'secret', value: 'redactedkey' },
          { key: 'TWO_FACTOR_ENCRYPTION_KEY', type: 'sensitive' },
        ],
      }),
    );
    expect(values('.env.vercel.shared').INTEGRATIONS_ENCRYPTION_KEY).toBe(key);
    expect(result.preserved).toContain('production:INTEGRATIONS_ENCRYPTION_KEY');
    expect(result.missing).toContain('production:TWO_FACTOR_ENCRYPTION_KEY');
    expect(readFileSync(join(root, '.env.vercel.production'), 'utf8')).not.toContain('redactedkey');
  });
  it('keeps local files unchanged if any selected remote pull fails', () => {
    const before = ['shared', 'preview', 'production'].map((name) =>
      readFileSync(join(root, `.env.vercel.${name}`), 'utf8'),
    );
    const run: Runner = (_, args) =>
      args.includes('preview')
        ? {
            status: 0,
            stdout: JSON.stringify({ envs: [{ key: 'SENTRY_DSN', type: 'config', value: '' }] }),
          }
        : { status: 1, stderr: 'PRIVATE_ERROR' };
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
