import { BadRequestException } from '@nestjs/common';

/** Fixed return path, with local browser origins allowed only outside production. */
export function subscriptionCallback(
  webUrl: string,
  requestedOrigin?: string,
  environment = 'production',
) {
  const canonical = new URL(webUrl);
  let origin = canonical.origin;
  if (requestedOrigin !== undefined) {
    let requested: URL;
    try {
      requested = new URL(requestedOrigin);
    } catch {
      throw new BadRequestException('Invalid subscription return origin');
    }
    const local =
      ['development', 'test'].includes(environment) &&
      ['localhost', '127.0.0.1', '[::1]'].includes(requested.hostname) &&
      ['http:', 'https:'].includes(requested.protocol);
    if (requestedOrigin !== requested.origin || (requested.origin !== canonical.origin && !local))
      throw new BadRequestException('Invalid subscription return origin');
    origin = requested.origin;
  }
  return new URL('/subscription?payment_window=1', origin).href;
}
