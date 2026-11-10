import { subscriptionCallback } from '../../../src/billing/subscription-callback';

describe('subscription return origin', () => {
  const canonical = 'https://belivrhq.example';
  it('preserves the configured return path for legacy callers', () => {
    expect(subscriptionCallback(canonical)).toBe(canonical + '/subscription?payment_window=1');
  });
  it('accepts the configured production origin', () => {
    expect(subscriptionCallback(canonical, canonical, 'production')).toContain(canonical);
  });
  it.each(['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000'])(
    'returns local development checkout to %s even with a production WEB_URL',
    (origin) => {
      expect(subscriptionCallback(canonical, origin, 'development')).toBe(
        origin + '/subscription?payment_window=1',
      );
      expect(() => subscriptionCallback(canonical, origin, 'production')).toThrow('Invalid');
    },
  );
  it.each([
    'https://attacker.example',
    'http://127.0.0.1.evil.example:3000',
    'http://localhost:3000/subscription',
    'http://localhost:3000?next=evil',
    'http://user:pass@localhost:3000',
    'javascript:alert(1)',
    'null',
  ])('rejects %s', (origin) => {
    expect(() => subscriptionCallback(canonical, origin, 'development')).toThrow('Invalid');
  });
});
