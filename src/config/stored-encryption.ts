import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { LEGACY_BRAND } from '../brand/brand';
import { SecretName } from './secret-keys';

export type EncryptionPurpose = Extract<
  SecretName,
  'INTEGRATIONS_ENCRYPTION_KEY' | 'TWO_FACTOR_ENCRYPTION_KEY' | 'PASTORAL_ENCRYPTION_KEY'
>;
export function deriveStoredKey(purpose: EncryptionPurpose, secret: string | Buffer): Buffer {
  if (Buffer.isBuffer(secret)) return Buffer.from(secret);
  return purpose === 'PASTORAL_ENCRYPTION_KEY'
    ? scryptSync(secret, LEGACY_BRAND.pastoralSalt, 32)
    : Buffer.from(secret, 'hex');
}
function format(purpose: EncryptionPurpose) {
  return purpose === 'INTEGRATIONS_ENCRYPTION_KEY'
    ? { separator: '.', encoding: 'base64' as const, prefix: ['v1'] }
    : {
        separator: ':',
        encoding: 'hex' as const,
        prefix: purpose === 'TWO_FACTOR_ENCRYPTION_KEY' ? ['v1'] : [],
      };
}
/** Preserve all existing ciphertext formats and AAD so historical records remain readable. */
export function encryptStored(
  purpose: EncryptionPurpose,
  secret: string | Buffer,
  plaintext: string,
  aad?: string,
): string {
  const derived = deriveStoredKey(purpose, secret);
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', derived, iv);
    if (aad !== undefined) cipher.setAAD(Buffer.from(aad));
    const content = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const { separator, encoding, prefix } = format(purpose);
    return [
      ...prefix,
      iv.toString(encoding),
      cipher.getAuthTag().toString(encoding),
      content.toString(encoding),
    ].join(separator);
  } finally {
    derived.fill(0);
  }
}
export function decryptStored(
  purpose: EncryptionPurpose,
  secrets: (string | Buffer)[],
  value: string,
  aad?: string,
): { plaintext: string; keyIndex: number } {
  const { separator, encoding, prefix } = format(purpose);
  const parts = value.split(separator);
  if (parts.length !== prefix.length + 3 || prefix.some((p, i) => parts[i] !== p))
    throw new Error('Invalid encrypted data format');
  const fields = parts.slice(prefix.length);
  const decoded = fields.map((p) => Buffer.from(p, encoding));
  if (
    decoded.some(
      (bytes, i) =>
        bytes.toString(encoding) !== (encoding === 'hex' ? fields[i].toLowerCase() : fields[i]),
    )
  )
    throw new Error('Invalid encrypted data encoding');
  const [iv, tag, content] = decoded;
  // Historical pastoral records use a 16-byte IV; newer records use 12 bytes.
  if (
    (iv.length !== 12 && !(purpose === 'PASTORAL_ENCRYPTION_KEY' && iv.length === 16)) ||
    tag.length !== 16
  )
    throw new Error('Invalid encrypted data format');
  for (let keyIndex = 0; keyIndex < secrets.length; keyIndex++) {
    const derived = deriveStoredKey(purpose, secrets[keyIndex]);
    try {
      const decipher = createDecipheriv('aes-256-gcm', derived, iv);
      if (aad !== undefined) decipher.setAAD(Buffer.from(aad));
      decipher.setAuthTag(tag);
      return {
        plaintext: Buffer.concat([decipher.update(content), decipher.final()]).toString('utf8'),
        keyIndex,
      };
    } catch {
      // Authentication must succeed before returning any plaintext.
    } finally {
      derived.fill(0);
    }
  }
  throw new Error('No configured key can decrypt this data');
}
