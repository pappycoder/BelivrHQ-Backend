import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { SECRET_RULES } from '../../../src/config/secret-keys';
const root = resolve(__dirname, '../../..');
const readEnv = (overrides: NodeJS.ProcessEnv = {}) => ({
  ...process.env,
  ...Object.fromEntries(
    Object.keys(SECRET_RULES).flatMap((key) => [
      [key, ''],
      [`${key}_PREVIOUS_KEYS`, '[]'],
    ]),
  ),
  NODE_ENV: 'production',
  ALTCHA_HMAC_KEY: 'valid-hmac-test-secret-'.repeat(3),
  PASTORAL_ENCRYPTION_KEY: 'valid-pastoral-test-secret-'.repeat(2),
  ...overrides,
});
describe('Key operator commands', () => {
  it('generates only one correctly formatted secret', () => {
    const result = execFileSync(process.execPath, ['scripts/generate-secret-key.cjs'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(result).toMatch(/^[a-f0-9]{64}\n$/);
  });
  it('accepts empty previous-key lists for unconfigured optional features without bootstrapping the app', () => {
    const result = spawnSync(process.execPath, ['scripts/check-secret-keys.cjs'], {
      cwd: root,
      encoding: 'utf8',
      env: readEnv(),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('TWO_FACTOR_ENCRYPTION_KEY: unconfigured');
    expect(result.stdout).not.toContain('valid-hmac-test-secret-');
  });
  it('returns nonzero for malformed values without disclosing them', () => {
    const result = spawnSync(process.execPath, ['scripts/check-secret-keys.cjs'], {
      cwd: root,
      encoding: 'utf8',
      env: readEnv({
        INTEGRATIONS_ENCRYPTION_KEY: 'private-but-invalid-value',
        TWO_FACTOR_ENCRYPTION_KEY_PREVIOUS_KEYS: '["retained-but-invalid"]',
      }),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('INVALID');
    expect(result.stdout + result.stderr).not.toMatch(
      /private-but-invalid-value|retained-but-invalid/,
    );
  });
});
