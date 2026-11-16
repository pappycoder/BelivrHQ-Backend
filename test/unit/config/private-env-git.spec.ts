import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const guard = jest.requireActual<{
  isPrivateEnvPath: (name: string) => boolean;
  main: (args: string[]) => void;
  checkOutgoing: (input: string, remote?: string) => void;
}>('../../../scripts/check-private-env.cjs');
const previous = process.cwd();
let root: string;
function git(...args: string[]) {
  return execFileSync(
    'git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'user.name=Env Guard Test',
      '-c',
      'user.email=env-guard@example.invalid',
      ...args,
    ],
    { cwd: root, encoding: 'utf8' },
  ).trim();
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'belivrhq-env-git-'));
  git('init', '-q');
  process.chdir(root);
});
afterEach(() => {
  process.chdir(previous);
  rmSync(root, { recursive: true, force: true });
});
describe('Private-env Git guards', () => {
  it.each([
    '.env',
    '.env.vercel.shared',
    '.env.vercel.json',
    '.env.vercel.preview',
    '.env.vercel.production',
    'config/private.env',
    '.ops/backup/private',
    '.vercel/project.json',
  ])('blocks private path %s', (name) => expect(guard.isPrivateEnvPath(name)).toBe(true));
  it.each(['.env.example', 'config/vercel/shared.env.example', 'src/config/env.validation.ts'])(
    'permits placeholder/source path %s',
    (name) => expect(guard.isPrivateEnvPath(name)).toBe(false),
  );
  it('blocks an env file that was force-added past gitignore without exposing contents', () => {
    writeFileSync(join(root, '.gitignore'), '.env*\n');
    writeFileSync(join(root, '.env'), 'TOKEN=PRIVATE_SENTINEL\n');
    git('add', '-f', '.env');
    try {
      guard.main(['--staged']);
      throw new Error('expected blocked');
    } catch (error) {
      expect(String(error)).toContain('Blocked private environment');
      expect(String(error)).not.toContain('PRIVATE_SENTINEL');
    }
  });
  it('blocks an outgoing env-file commit even when a later commit deleted the file', () => {
    writeFileSync(join(root, '.env'), 'TOKEN=PRIVATE_SENTINEL\n');
    git('add', '.env');
    git('commit', '-qm', 'private fixture');
    git('rm', '-q', '.env');
    git('commit', '-qm', 'remove private fixture');
    const sha = git('rev-parse', 'HEAD');
    expect(() =>
      guard.checkOutgoing(`refs/heads/main ${sha} refs/heads/main ${'0'.repeat(40)}\n`),
    ).toThrow('Blocked private environment');
  });
  it('permits outgoing source and placeholder examples', () => {
    writeFileSync(join(root, '.env.example'), 'TOKEN=\n');
    git('add', '.env.example');
    git('commit', '-qm', 'placeholder fixture');
    const sha = git('rev-parse', 'HEAD');
    expect(() =>
      guard.checkOutgoing(`refs/heads/main ${sha} refs/heads/main ${'0'.repeat(40)}\n`),
    ).not.toThrow();
  });
});
