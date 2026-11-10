import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { UnauthorizedException, ServiceUnavailableException } from '@nestjs/common';
export const REGISTRATION_CHECKOUT_TTL = 86400;
interface Identity {
  userId: string;
  churchId: string;
  profileId: string;
}
interface Claims extends Identity {
  purpose: 'registration-billing';
  expires: number;
  nonce: string;
}
function key(config: { get<T = string>(name: string): T | undefined }): string {
  const value = config.get<string>('ALTCHA_HMAC_KEY');
  if (!value || value.length < 32)
    throw new ServiceUnavailableException('Registration checkout is unavailable.');
  return value;
}
function signature(payload: string, secret: string) {
  return createHmac('sha256', secret)
    .update(`belivrhq:registration-billing:v1:${payload}`)
    .digest();
}
/** Billing-only capability; this is never accepted as a workspace session. */
export function createRegistrationCheckout(
  config: { get<T = string>(name: string): T | undefined },
  identity: Identity,
) {
  const payload = Buffer.from(
    JSON.stringify({
      ...identity,
      purpose: 'registration-billing',
      expires: Math.floor(Date.now() / 1000) + REGISTRATION_CHECKOUT_TTL,
      nonce: randomBytes(16).toString('hex'),
    } satisfies Claims),
  ).toString('base64url');
  return `${payload}.${signature(payload, key(config)).toString('base64url')}`;
}
export function readRegistrationCheckout(
  config: { get<T = string>(name: string): T | undefined },
  token: unknown,
): Claims {
  const secret = key(config);
  try {
    if (typeof token !== 'string' || token.length > 2048) throw new Error();
    const parts = token.split('.');
    if (parts.length !== 2) throw new Error();
    const [payload, signed] = parts;
    const expected = signature(payload, secret),
      actual = Buffer.from(signed, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Claims;
    if (
      data.purpose !== 'registration-billing' ||
      !Number.isInteger(data.expires) ||
      data.expires <= Date.now() / 1000 ||
      data.expires > Date.now() / 1000 + REGISTRATION_CHECKOUT_TTL + 60 ||
      ![data.userId, data.churchId, data.profileId].every(
        (value) => typeof value === 'string' && !!value,
      ) ||
      typeof data.nonce !== 'string'
    )
      throw new Error();
    return data;
  } catch {
    throw new UnauthorizedException('Registration checkout expired. Sign in to continue billing.');
  }
}
