import { readFile, writeFile } from 'node:fs/promises';
import { LIVE_READ_PATHS } from './config.mjs';
const origin = 'https://church-os-web.vercel.app';
const [session] = JSON.parse(
  await readFile(new URL('./results/live.sessions.json', import.meta.url)),
);
const rows = [];
for (let round = 1; round <= 2; round++) {
  for (const path of ['/api/session', ...LIVE_READ_PATHS.map((path) => `/api/backend${path}`)]) {
    const started = performance.now();
    const response = await fetch(`${origin}${path}`, {
      headers: {
        Cookie: `belivrhq_token=${session.token}`,
        'x-belivrhq-client': 'web',
        Origin: origin,
        'Sec-Fetch-Site': 'same-origin',
      },
      signal: AbortSignal.timeout(15000),
      redirect: 'error',
    });
    const headersMs = performance.now() - started;
    const bytes = await response.arrayBuffer();
    const row = {
      round,
      path,
      status: response.status,
      headersMs,
      totalMs: performance.now() - started,
      bytes: bytes.byteLength,
      serverTiming: response.headers.get('server-timing'),
      vercelRegion: response.headers.get('x-vercel-id')?.split('::')[0],
      cache: response.headers.get('x-vercel-cache'),
    };
    rows.push(row);
    console.log(JSON.stringify(row));
  }
}
await writeFile(
  new URL('./results/live-diagnostics.json', import.meta.url),
  JSON.stringify({ recordedAt: new Date().toISOString(), rows }, null, 2),
);
