import { ConfigService } from '@nestjs/config';

/** Email destinations use the configured WEB_URL directly, independent of Supabase Site URL settings. */
export function publicWebUrl(config: Pick<ConfigService, 'get'>): string {
  const configured = config.get<string>('WEB_URL');
  if (!configured) throw new Error('WEB_URL is required for BelivrHQ email links');
  const url = new URL(configured);
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('WEB_URL must be a website origin');
  const local =
    ['localhost', '127.0.0.1', '[::1]', '0.0.0.0'].includes(url.hostname) ||
    url.hostname.endsWith('.localhost');
  if (config.get<string>('NODE_ENV') === 'production' && (local || url.protocol !== 'https:'))
    throw new Error('WEB_URL must be a public HTTPS website in production');
  return url.origin;
}
