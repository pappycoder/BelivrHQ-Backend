import { createCipheriv, randomBytes, scryptSync } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { LEGACY_BRAND } from '../../../src/brand/brand';
import { secretKeys, normalizeSecret, previousSecrets } from '../../../src/config/secret-keys';
import {
  encryptStored,
  decryptStored,
  EncryptionPurpose,
} from '../../../src/config/stored-encryption';
import { rotateEncryptedRows, EncryptedRow } from '../../../scripts/lib/rotate-encryption';
import { IntegrationAccountsService } from '../../../src/integrations/integration-accounts.service';
import { AuthenticatorService } from '../../../src/auth/services/authenticator.service';
import { PastoralService } from '../../../src/pastoral/pastoral.service';
import {
  createRegistrationCheckout,
  readRegistrationCheckout,
} from '../../../src/auth/registration-checkout';

const oldKey = 'ab'.repeat(32),
  nextKey = 'cd'.repeat(32);
const purposes: EncryptionPurpose[] = [
  'INTEGRATIONS_ENCRYPTION_KEY',
  'TWO_FACTOR_ENCRYPTION_KEY',
  'PASTORAL_ENCRYPTION_KEY',
];
const config = (name: string, active: string, previous: string[] = []) =>
  new ConfigService({ [name]: active, [`${name}_PREVIOUS_KEYS`]: JSON.stringify(previous) });

describe('Secret configuration preflight', () => {
  it('accepts generated hex, canonicalizes pasted surrounding whitespace, and preserves passphrases exactly', () => {
    expect(normalizeSecret('INTEGRATIONS_ENCRYPTION_KEY', `\n${oldKey}\r\n`)).toBe(oldKey);
    expect(normalizeSecret('PASTORAL_ENCRYPTION_KEY', ' passphrase with spaces ')).toBe(
      ' passphrase with spaces ',
    );
    expect(
      normalizeSecret('TWO_FACTOR_ENCRYPTION_KEY', randomBytes(32).toString('hex')),
    ).toHaveLength(64);
  });
  it.each([
    'redactedkey',
    'x'.repeat(64),
    'a'.repeat(32),
    `"${oldKey}"`,
    `0x${oldKey}`,
    `${oldKey}\\n`,
  ])('rejects invalid key format without including the supplied value', (bad) => {
    expect(() => normalizeSecret('TWO_FACTOR_ENCRYPTION_KEY', bad)).toThrow('64 hexadecimal');
    try {
      normalizeSecret('TWO_FACTOR_ENCRYPTION_KEY', bad);
    } catch (error) {
      expect(String(error)).not.toContain(bad);
    }
  });
  it.each([
    'not-json',
    '{}',
    '[null]',
    '[""]',
    JSON.stringify(Array(6).fill(oldKey)),
    JSON.stringify(['bad']),
  ])('rejects invalid previous-key lists', (bad) => {
    expect(() => previousSecrets('INTEGRATIONS_ENCRYPTION_KEY', bad)).toThrow();
  });
  it('requires an active key and deduplicates retained keys', () => {
    expect(() =>
      secretKeys('TWO_FACTOR_ENCRYPTION_KEY', (name) =>
        name.endsWith('_PREVIOUS_KEYS') ? JSON.stringify([oldKey]) : undefined,
      ),
    ).toThrow('must be configured');
    expect(
      secretKeys('TWO_FACTOR_ENCRYPTION_KEY', (name) =>
        name.endsWith('_PREVIOUS_KEYS') ? JSON.stringify([nextKey, oldKey, oldKey]) : nextKey,
      ),
    ).toEqual([nextKey, oldKey]);
  });
});

describe.each(purposes)('%s compatibility and rotation', (purpose) => {
  const aad = purpose === 'PASTORAL_ENCRYPTION_KEY' ? undefined : 'church:account:provider:v1';
  it('reads original-format ciphertext generated independently from the new implementation', () => {
    const key =
      purpose === 'PASTORAL_ENCRYPTION_KEY'
        ? scryptSync(oldKey, LEGACY_BRAND.pastoralSalt, 32)
        : Buffer.from(oldKey, 'hex');
    const iv = randomBytes(purpose === 'PASTORAL_ENCRYPTION_KEY' ? 16 : 12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    if (aad) cipher.setAAD(Buffer.from(aad));
    const data = Buffer.concat([cipher.update('legacy secret'), cipher.final()]);
    const encoding = purpose === 'INTEGRATIONS_ENCRYPTION_KEY' ? 'base64' : 'hex';
    const parts = [
      iv.toString(encoding),
      cipher.getAuthTag().toString(encoding),
      data.toString(encoding),
    ];
    if (purpose !== 'PASTORAL_ENCRYPTION_KEY') parts.unshift('v1');
    const legacy = parts.join(purpose === 'INTEGRATIONS_ENCRYPTION_KEY' ? '.' : ':');
    expect(decryptStored(purpose, [nextKey, oldKey], legacy, aad)).toEqual({
      plaintext: 'legacy secret',
      keyIndex: 1,
    });
    expect(() => decryptStored(purpose, [nextKey], legacy, aad)).toThrow();
  });
  it('writes only the current key, rejects wrong identity and tampering, and supports empty plaintext', () => {
    const encrypted = encryptStored(purpose, nextKey, '', aad);
    expect(decryptStored(purpose, [nextKey], encrypted, aad).plaintext).toBe('');
    expect(() => decryptStored(purpose, [oldKey], encrypted, aad)).toThrow();
    if (aad)
      expect(() => decryptStored(purpose, [nextKey, oldKey], encrypted, 'other-user')).toThrow();
    const encryptedData = encryptStored(purpose, nextKey, 'private', aad);
    expect(() =>
      decryptStored(purpose, [nextKey, oldKey], encryptedData.slice(0, -4), aad),
    ).toThrow();
    expect(() => decryptStored(purpose, [nextKey], encryptedData + ':extra', aad)).toThrow();
  });
  it('dry-runs without writes, resumes safely, and verifies retirement of the old key', async () => {
    let rows: EncryptedRow[] = [
      { id: '1', ciphertext: encryptStored(purpose, oldKey, 'first', aad), aad },
      { id: '2', ciphertext: encryptStored(purpose, nextKey, 'second', aad), aad },
    ];
    const replace = jest.fn(async (row: EncryptedRow, ciphertext: string) => {
      rows = rows.map((r) => (r.id === row.id ? { ...r, ciphertext } : r));
      return 1;
    });
    const store = {
      batch: async (cursor?: string) => rows.filter((row) => !cursor || row.id > cursor),
      replace,
    };
    const run = (apply = false, verifyCurrent = false) =>
      rotateEncryptedRows(purpose, [nextKey, oldKey], store, { apply, verifyCurrent });
    await expect(run()).resolves.toEqual({ changed: 1, current: 1 });
    expect(replace).not.toHaveBeenCalled();
    await expect(run(false, true)).rejects.toThrow();
    await expect(run(true)).resolves.toEqual({ changed: 1, current: 1 });
    await expect(run(true)).resolves.toEqual({ changed: 0, current: 2 });
    await expect(run(false, true)).resolves.toEqual({ changed: 0, current: 2 });
    expect(decryptStored(purpose, [nextKey], rows[0].ciphertext, aad).plaintext).toBe('first');
  });
  it('retains readable committed progress when a later row fails and resumes after repair', async () => {
    const rows = [
      { id: '1', ciphertext: encryptStored(purpose, oldKey, 'first', aad), aad },
      { id: '2', ciphertext: 'unreadable', aad },
    ];
    const store = {
      batch: async (cursor?: string) => rows.filter((row) => !cursor || row.id > cursor),
      replace: async (row: EncryptedRow, ciphertext: string) => {
        rows.find((r) => r.id === row.id)!.ciphertext = ciphertext;
        return 1;
      },
    };
    const run = () =>
      rotateEncryptedRows(purpose, [nextKey, oldKey], store, { apply: true, verifyCurrent: false });
    await expect(run()).rejects.toThrow();
    expect(decryptStored(purpose, [nextKey], rows[0].ciphertext, aad).plaintext).toBe('first');
    expect(rows[1].ciphertext).toBe('unreadable');
    rows[1].ciphertext = encryptStored(purpose, oldKey, 'second', aad);
    await expect(run()).resolves.toEqual({ changed: 1, current: 1 });
  });

  it('stops without overwriting undecryptable or concurrently changed records', async () => {
    const replace = jest.fn(async () => 0);
    const row = { id: '1', ciphertext: 'corrupt', aad };
    const store = { batch: async () => [row], replace };
    await expect(
      rotateEncryptedRows(purpose, [nextKey, oldKey], store, { apply: true, verifyCurrent: false }),
    ).rejects.toThrow();
    expect(replace).not.toHaveBeenCalled();
    row.ciphertext = encryptStored(purpose, oldKey, 'sensitive', aad);
    await expect(
      rotateEncryptedRows(purpose, [nextKey, oldKey], store, { apply: true, verifyCurrent: false }),
    ).rejects.toThrow('Concurrent');
  });
});

describe('Service use of retained keys', () => {
  it('preserves church/provider binding across integration rotations', () => {
    const service = (active: string, previous: string[] = []) =>
      new IntegrationAccountsService(
        {} as never,
        config('INTEGRATIONS_ENCRYPTION_KEY', active, previous),
        {} as never,
        {} as never,
      );
    const ciphertext = service(oldKey).encrypt('church', 'account', 'twilio', { token: 'secret' });
    expect(service(nextKey, [oldKey]).decrypt('church', 'account', 'twilio', ciphertext)).toEqual({
      token: 'secret',
    });
    expect(() =>
      service(nextKey, [oldKey]).decrypt('other', 'account', 'twilio', ciphertext),
    ).toThrow();
    expect(() => service(nextKey).decrypt('church', 'account', 'twilio', ciphertext)).toThrow();
  });
  it('reads existing and pending authenticator ciphertext without changing user binding', () => {
    const service = (active: string, previous: string[] = []) =>
      new AuthenticatorService(
        {} as never,
        {} as never,
        config('TWO_FACTOR_ENCRYPTION_KEY', active, previous),
        {} as never,
      );
    const ciphertext = service(oldKey)['encrypt']('user', 'totp-secret');
    expect(service(nextKey, [oldKey])['decrypt']('user', ciphertext)).toBe('totp-secret');
    expect(() => service(nextKey, [oldKey])['decrypt']('other-user', ciphertext)).toThrow();
    expect(() => service(nextKey)['decrypt']('user', ciphertext)).toThrow();
  });
  it('reads pastoral notes through the service after rotation', () => {
    const previous = process.env;
    try {
      process.env = {
        ...previous,
        NODE_ENV: 'test',
        PASTORAL_ENCRYPTION_KEY: nextKey,
        PASTORAL_ENCRYPTION_KEY_PREVIOUS_KEYS: JSON.stringify([oldKey]),
      };
      const service = new PastoralService({} as never, {} as never, {} as never);
      expect(
        service.decrypt(encryptStored('PASTORAL_ENCRYPTION_KEY', oldKey, 'confidential')),
      ).toBe('confidential');
      expect(
        decryptStored('PASTORAL_ENCRYPTION_KEY', [nextKey], service.encrypt('new note')).plaintext,
      ).toBe('new note');
    } finally {
      process.env = previous;
    }
  });
  it('retains unexpired registration capabilities and signs new ones with the active key', () => {
    const identity = { userId: 'user', churchId: 'church', profileId: 'profile' };
    const token = createRegistrationCheckout(config('ALTCHA_HMAC_KEY', oldKey), identity);
    expect(
      readRegistrationCheckout(config('ALTCHA_HMAC_KEY', nextKey, [oldKey]), token),
    ).toMatchObject(identity);
    const newToken = createRegistrationCheckout(
      config('ALTCHA_HMAC_KEY', nextKey, [oldKey]),
      identity,
    );
    expect(readRegistrationCheckout(config('ALTCHA_HMAC_KEY', nextKey), newToken)).toMatchObject(
      identity,
    );
    expect(() => readRegistrationCheckout(config('ALTCHA_HMAC_KEY', oldKey), newToken)).toThrow();
    expect(() => readRegistrationCheckout(config('ALTCHA_HMAC_KEY', nextKey), token)).toThrow();
  });
});
