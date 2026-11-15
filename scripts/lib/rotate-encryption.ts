import {
  deriveStoredKey,
  decryptStored,
  encryptStored,
  EncryptionPurpose,
} from '../../src/config/stored-encryption';
import { previousSecrets, SecretReader, secretKeys } from '../../src/config/secret-keys';
export interface EncryptedRow {
  id: string;
  ciphertext: string;
  aad?: string;
}
export interface RotationStore {
  batch(cursor?: string): Promise<EncryptedRow[]>;
  replace(row: EncryptedRow, ciphertext: string): Promise<number>;
}

/** Old keys may exist only in the operator's environment, never in API/worker settings. */
export function rotationKeys(purpose: EncryptionPurpose, read: SecretReader): string[] {
  const isolated = previousSecrets(purpose, read(`${purpose}_ROTATION_KEYS`));
  const previous = previousSecrets(purpose, read(`${purpose}_PREVIOUS_KEYS`));
  if (!read(purpose) && !previous.length && !isolated.length) return [];
  const keys = [...new Set([...secretKeys(purpose, read), ...isolated])];
  if (keys.length > 6) throw new Error('Rotation supports a current key and at most 5 old keys');
  return keys;
}

export interface RotationPlan {
  purpose: EncryptionPurpose;
  keys: string[];
  store: RotationStore;
}

/** Check every selected table before writing; apply then independently verify every table. */
export async function rotateEncryptionPlan(
  plans: RotationPlan[],
  options: { apply: boolean; verifyCurrent: boolean },
) {
  if (options.apply && options.verifyCurrent)
    throw new Error('Apply and verify-only are mutually exclusive');
  const results: {
    purpose: EncryptionPurpose;
    changed: number;
    current: number;
    verified?: number;
  }[] = [];
  for (const plan of plans) {
    const counts = await rotateEncryptedRows(plan.purpose, plan.keys, plan.store, {
      apply: false,
      verifyCurrent: options.verifyCurrent,
    });
    results.push({ purpose: plan.purpose, ...counts });
  }
  if (!options.apply) return results;
  for (let index = 0; index < plans.length; index++) {
    const plan = plans[index];
    const counts = await rotateEncryptedRows(plan.purpose, plan.keys, plan.store, {
      apply: true,
      verifyCurrent: false,
    });
    results[index] = { purpose: plan.purpose, ...counts };
  }
  for (let index = 0; index < plans.length; index++) {
    const plan = plans[index];
    const verified = await rotateEncryptedRows(plan.purpose, plan.keys, plan.store, {
      apply: false,
      verifyCurrent: true,
    });
    results[index].verified = verified.current;
  }
  return results;
}
/** Resumable, bounded-memory rotation. A failed row is never overwritten. */
export async function rotateEncryptedRows(
  purpose: EncryptionPurpose,
  keys: string[],
  store: RotationStore,
  options: { apply: boolean; verifyCurrent: boolean },
) {
  const derivedKeys = keys.map((secret) => deriveStoredKey(purpose, secret));
  try {
    let cursor: string | undefined;
    let changed = 0,
      current = 0;
    while (true) {
      const rows = await store.batch(cursor);
      if (!rows.length) break;
      for (const row of rows) {
        const result = decryptStored(
          purpose,
          options.verifyCurrent ? derivedKeys.slice(0, 1) : derivedKeys,
          row.ciphertext,
          row.aad,
        );
        if (result.keyIndex === 0) {
          current++;
          continue;
        }
        if (options.apply) {
          const ciphertext = encryptStored(purpose, derivedKeys[0], result.plaintext, row.aad);
          if (
            decryptStored(purpose, derivedKeys.slice(0, 1), ciphertext, row.aad).plaintext !==
            result.plaintext
          )
            throw new Error('Encryption verification failed');
          if ((await store.replace(row, ciphertext)) !== 1)
            throw new Error('Concurrent change detected; rerun rotation');
        }
        changed++;
      }
      cursor = rows[rows.length - 1].id;
    }
    return { changed, current };
  } finally {
    for (const key of derivedKeys) key.fill(0);
  }
}
