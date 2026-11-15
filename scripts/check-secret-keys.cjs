#!/usr/bin/env node
// Standalone preflight; no app bootstrap, database access or secret disclosure.
require('dotenv').config({ quiet: true });
require('ts-node').register({
  project: require('node:path').join(__dirname, '../tsconfig.scripts.json'),
});
const { SECRET_RULES, secretKeys, previousSecrets } = require('../src/config/secret-keys');
for (const name of Object.keys(SECRET_RULES)) {
  const configured = !!process.env[name];
  let previous;
  try {
    previous = previousSecrets(name, process.env[`${name}_PREVIOUS_KEYS`]);
  } catch {
    console.error(`${name}_PREVIOUS_KEYS: INVALID JSON key list`);
    process.exitCode = 1;
    continue;
  }
  if (!configured && !previous.length) {
    const required =
      name === 'ALTCHA_HMAC_KEY' ||
      (name === 'PASTORAL_ENCRYPTION_KEY' && process.env.NODE_ENV === 'production');
    console.log(
      `${name}: unconfigured${required ? ' (REQUIRED)' : name === 'MEDIA_UPLOAD_SIGNING_KEY' ? ' (legacy Supabase signing fallback)' : ' (feature unavailable)'}`,
    );
    if (required) process.exitCode = 1;
    continue;
  }
  try {
    const keys = secretKeys(name, (key) => process.env[key]);
    if (
      name === 'PASTORAL_ENCRYPTION_KEY' &&
      process.env.NODE_ENV === 'production' &&
      keys.includes('dev-only-change-in-production-32b')
    )
      throw new Error();
    console.log(`${name}: valid; ${keys.length - 1} retained key(s)`);
  } catch {
    console.error(
      `${name}: INVALID. Expected ${SECRET_RULES[name] === 'hex' ? '64 hexadecimal characters' : `at least ${SECRET_RULES[name]} characters`}; previous keys must be a JSON array of at most 5 valid keys and require a current key.`,
    );
    process.exitCode = 1;
  }
}
