import {
  encryptStored,
  decryptStored,
  EncryptionPurpose,
} from '../../../src/config/stored-encryption';
import { secretKeys } from '../../../src/config/secret-keys';
import {
  rotateEncryptionPlan,
  rotationKeys,
  RotationPlan,
  EncryptedRow,
} from '../../../scripts/lib/rotate-encryption';

const oldKey = 'ab'.repeat(32),
  newKey = 'cd'.repeat(32);
const purposes: EncryptionPurpose[] = [
  'INTEGRATIONS_ENCRYPTION_KEY',
  'TWO_FACTOR_ENCRYPTION_KEY',
  'PASTORAL_ENCRYPTION_KEY',
];
function fixture(purpose: EncryptionPurpose, count = 2) {
  const aad = purpose === 'PASTORAL_ENCRYPTION_KEY' ? undefined : 'tenant:user:provider:v1';
  const rows: EncryptedRow[] = Array.from({ length: count }, (_, i) => ({
    id: String(i),
    aad,
    ciphertext: encryptStored(purpose, oldKey, `preserved-${i}`, aad),
  }));
  const replace = jest.fn(async (row: EncryptedRow, ciphertext: string) => {
    const stored = rows.find((r) => r.id === row.id)!;
    if (stored.ciphertext !== row.ciphertext) return 0;
    stored.ciphertext = ciphertext;
    return 1;
  });
  const plan: RotationPlan = {
    purpose,
    keys: [newKey, oldKey],
    store: {
      batch: async (cursor) => rows.filter((r) => !cursor || r.id > cursor).map((r) => ({ ...r })),
      replace,
    },
  };
  return { plan, rows, replace };
}

describe('Complete stored-record rotation', () => {
  it('migrates every selected table and verifies persisted records using only the new keys', async () => {
    const fixtures = purposes.map((purpose) => fixture(purpose));
    const results = await rotateEncryptionPlan(
      fixtures.map((f) => f.plan),
      { apply: true, verifyCurrent: false },
    );
    expect(results).toEqual(
      purposes.map((purpose) => ({ purpose, changed: 2, current: 0, verified: 2 })),
    );
    for (const { plan, rows } of fixtures) {
      rows.forEach((row, index) => {
        expect(decryptStored(plan.purpose, [newKey], row.ciphertext, row.aad).plaintext).toBe(
          `preserved-${index}`,
        );
        expect(() => decryptStored(plan.purpose, [oldKey], row.ciphertext, row.aad)).toThrow();
      });
    }
  });
  it('checks every table before writing any table', async () => {
    const fixtures = purposes.map((purpose) => fixture(purpose));
    fixtures[2].rows[1].ciphertext = 'unreadable';
    await expect(
      rotateEncryptionPlan(
        fixtures.map((f) => f.plan),
        { apply: true, verifyCurrent: false },
      ),
    ).rejects.toThrow();
    fixtures.forEach((f) => expect(f.replace).not.toHaveBeenCalled());
  });
  it('dry-runs all tables without writes', async () => {
    const fixtures = purposes.map((purpose) => fixture(purpose));
    const result = await rotateEncryptionPlan(
      fixtures.map((f) => f.plan),
      { apply: false, verifyCurrent: false },
    );
    expect(result.map((r) => r.changed)).toEqual([2, 2, 2]);
    fixtures.forEach((f) => expect(f.replace).not.toHaveBeenCalled());
  });
  it('allows unconfigured empty features but refuses to skip encrypted records without their key', async () => {
    const empty = fixture('TWO_FACTOR_ENCRYPTION_KEY', 0);
    empty.plan.keys = [];
    await expect(
      rotateEncryptionPlan([empty.plan], { apply: true, verifyCurrent: false }),
    ).resolves.toEqual([{ purpose: empty.plan.purpose, changed: 0, current: 0, verified: 0 }]);
    const populated = fixture('TWO_FACTOR_ENCRYPTION_KEY');
    populated.plan.keys = [];
    await expect(
      rotateEncryptionPlan([populated.plan], { apply: true, verifyCurrent: false }),
    ).rejects.toThrow();
    expect(populated.replace).not.toHaveBeenCalled();
  });
  it('resumes all tables after an interrupted apply without rewriting completed records', async () => {
    const fixtures = purposes.map((purpose) => fixture(purpose));
    fixtures[1].replace.mockResolvedValueOnce(0);
    const plans = fixtures.map((f) => f.plan);
    await expect(
      rotateEncryptionPlan(plans, { apply: true, verifyCurrent: false }),
    ).rejects.toThrow('Concurrent');
    const firstTable = fixtures[0].rows.map((r) => r.ciphertext);
    const results = await rotateEncryptionPlan(plans, { apply: true, verifyCurrent: false });
    expect(results.map((r) => r.changed)).toEqual([0, 2, 2]);
    expect(results.map((r) => r.verified)).toEqual([2, 2, 2]);
    expect(fixtures[0].rows.map((r) => r.ciphertext)).toEqual(firstTable);
  });
  it('does not report completion if a late old-key write fails current-only verification', async () => {
    const { plan, rows, replace } = fixture('INTEGRATIONS_ENCRYPTION_KEY', 1);
    replace.mockImplementationOnce(async () => 1);
    await expect(
      rotateEncryptionPlan([plan], { apply: true, verifyCurrent: false }),
    ).rejects.toThrow('No configured key');
    expect(decryptStored(plan.purpose, [oldKey], rows[0].ciphertext, rows[0].aad).plaintext).toBe(
      'preserved-0',
    );
  });
  it('rejects conflicting modes before reading or writing', async () => {
    const { plan, replace } = fixture('INTEGRATIONS_ENCRYPTION_KEY');
    await expect(
      rotateEncryptionPlan([plan], { apply: true, verifyCurrent: true }),
    ).rejects.toThrow('mutually exclusive');
    expect(replace).not.toHaveBeenCalled();
  });
});

describe('Isolated migration keys', () => {
  const purpose = 'INTEGRATIONS_ENCRYPTION_KEY' as const;
  it('lets the migrator decrypt the old records without making the old key available to API readers', () => {
    const values: Record<string, string> = {
      [purpose]: newKey,
      [`${purpose}_ROTATION_KEYS`]: JSON.stringify([oldKey]),
    };
    const read = (name: string) => values[name];
    expect(rotationKeys(purpose, read)).toEqual([newKey, oldKey]);
    expect(secretKeys(purpose, read)).toEqual([newKey]);
  });
  it('permits unconfigured features with empty lists', () => {
    expect(rotationKeys(purpose, (name) => (name.endsWith('_KEYS') ? '[]' : undefined))).toEqual(
      [],
    );
  });
  it('requires a new current key when old migration keys are supplied', () => {
    expect(() =>
      rotationKeys(purpose, (name) =>
        name.endsWith('_ROTATION_KEYS') ? JSON.stringify([oldKey]) : undefined,
      ),
    ).toThrow('must be configured');
  });
  it('rejects malformed or oversized migration-key lists before database access', () => {
    expect(() =>
      rotationKeys(purpose, (name) => (name.endsWith('_ROTATION_KEYS') ? '["bad"]' : newKey)),
    ).toThrow();
    const retained = Array.from({ length: 5 }, (_, i) => String(i + 1).repeat(64));
    expect(() =>
      rotationKeys(purpose, (name) =>
        name.endsWith('_ROTATION_KEYS')
          ? JSON.stringify([oldKey])
          : name.endsWith('_PREVIOUS_KEYS')
            ? JSON.stringify(retained)
            : newKey,
      ),
    ).toThrow('at most 5');
  });
});
