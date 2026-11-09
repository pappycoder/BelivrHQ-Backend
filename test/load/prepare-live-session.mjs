import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const credentials = dotenv.parse(await readFile(resolve(root, '.env.load-test')));
const origin = 'https://church-os-web.vercel.app';
const headers = {
  'Content-Type': 'application/json',
  'x-belivrhq-client': 'web',
  Origin: origin,
  'Sec-Fetch-Site': 'same-origin',
};
if (!credentials.LOAD_TEST_EMAIL || !credentials.LOAD_TEST_PASSWORD)
  throw new Error(
    'Fill LOAD_TEST_EMAIL and LOAD_TEST_PASSWORD in the ignored .env.load-test file. Do not put credentials in command arguments or chat.',
  );
const response = await fetch(`${origin}/api/backend/auth/login`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    email: credentials.LOAD_TEST_EMAIL,
    password: credentials.LOAD_TEST_PASSWORD,
  }),
  signal: AbortSignal.timeout(45000),
  redirect: 'error',
});
const body = await response.json().catch(() => null);
if (!response.ok || body?.success !== true)
  throw new Error(`Login did not succeed (HTTP ${response.status}); no load was sent`);
const loginData = body.data;
if (loginData?.requiresTwoFactor)
  throw new Error(
    'This account requires MFA. Complete a normal sign-in and supply its authorized session through a private local file; load testing does not bypass MFA.',
  );
const tokenCookie = response.headers
  .getSetCookie()
  .find((value) => value.startsWith('belivrhq_token='));
const token = tokenCookie?.split(';')[0].slice('belivrhq_token='.length);
if (!token) throw new Error('Login did not issue a completed access session; no load was sent');
const profileResponse = await fetch(`${origin}/api/backend/profiles/me`, {
  headers: { ...headers, Cookie: `belivrhq_token=${token}` },
  signal: AbortSignal.timeout(45000),
});
const profileBody = await profileResponse.json().catch(() => null);
const profile = profileBody?.data;
if (!profileResponse.ok || profileBody?.success !== true || !profile?.churchId)
  throw new Error('Could not verify the test-account church; no load was sent');
const expected = (credentials.LOAD_TEST_CHURCH_NAME || 'Grace Community Church')
  .trim()
  .toLowerCase();
if (profile.church?.name?.trim().toLowerCase() !== expected)
  throw new Error(
    'The signed-in account does not match the designated test church; no load was sent',
  );
const sessionsFile = resolve(root, 'test/load/results/live.sessions.json');
await mkdir(dirname(sessionsFile), { recursive: true });
await writeFile(
  sessionsFile,
  JSON.stringify([
    { token, churchId: profile.churchId, profileId: profile.profileId, transport: 'web-cookie' },
  ]),
  { mode: 0o600 },
);
console.log(
  JSON.stringify({
    signedIn: true,
    church: profile.church.name,
    authorizedTestSessions: 1,
    sessionsFile,
    note: 'Private token stored locally, never printed. Existing production auth, permissions, plan and rate limits remain enabled.',
  }),
);
