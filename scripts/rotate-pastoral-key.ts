/** Compatibility entrypoint. Prefer keys:rotate -- pastoral for current/previous key rings. */
import 'dotenv/config';
import { previousSecrets } from '../src/config/secret-keys';
const old = process.env.PASTORAL_OLD_ENCRYPTION_KEY;
if (old) {
  process.env.PASTORAL_ENCRYPTION_KEY_PREVIOUS_KEYS = JSON.stringify([
    ...new Set([
      ...previousSecrets(
        'PASTORAL_ENCRYPTION_KEY',
        process.env.PASTORAL_ENCRYPTION_KEY_PREVIOUS_KEYS,
      ),
      old,
    ]),
  ]);
}
process.argv.splice(2, 0, 'pastoral');
// Load after translating the legacy setting and arguments.
void import('./rotate-encryption-keys').catch(() => {
  console.error('Unable to load key rotation command.');
  process.exitCode = 1;
});
