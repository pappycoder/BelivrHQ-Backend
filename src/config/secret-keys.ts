/** Bounded key overlap. Previous keys are read/verify-only and never used for new writes. */
export const SECRET_RULES = {
  INTEGRATIONS_ENCRYPTION_KEY: 'hex',
  TWO_FACTOR_ENCRYPTION_KEY: 'hex',
  PASTORAL_ENCRYPTION_KEY: 16,
  ALTCHA_HMAC_KEY: 32,
  INTERNAL_PROXY_SECRET: 32,
  MEDIA_UPLOAD_SIGNING_KEY: 32,
} as const;
export type SecretName = keyof typeof SECRET_RULES;
export type SecretReader = (name: string) => unknown;

export function normalizeSecret(name: SecretName, value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined;
  const rule = SECRET_RULES[name];
  // Hex keys have a canonical representation; preserve passphrase bytes exactly.
  const key = typeof value === 'string' && rule === 'hex' ? value.trim() : value;
  if (typeof key !== 'string' || (rule === 'hex' ? !/^[a-f\d]{64}$/i.test(key) : key.length < rule))
    throw new Error(
      `${name} must be ${rule === 'hex' ? '64 hexadecimal characters (generate with openssl rand -hex 32)' : `at least ${rule} characters`}`,
    );
  return key;
}

export function previousSecrets(name: SecretName, value: unknown): string[] {
  if (value === undefined || value === '') return [];
  let values: unknown;
  try {
    values = typeof value === 'string' ? JSON.parse(value) : undefined;
  } catch {
    throw new Error(`${name}_PREVIOUS_KEYS must be a JSON array of at most 5 valid keys`);
  }
  if (!Array.isArray(values) || values.length > 5)
    throw new Error(`${name}_PREVIOUS_KEYS must be a JSON array of at most 5 valid keys`);
  return values.map((value: unknown) => {
    const key = normalizeSecret(name, value);
    if (!key) throw new Error(`${name}_PREVIOUS_KEYS cannot contain empty keys`);
    return key;
  });
}

export function secretKeys(name: SecretName, read: SecretReader): string[] {
  const active = normalizeSecret(name, read(name));
  const previous = previousSecrets(name, read(`${name}_PREVIOUS_KEYS`));
  if (!active)
    throw new Error(`${name} must be configured before using this feature or previous keys`);
  return [...new Set([active, ...previous])];
}
