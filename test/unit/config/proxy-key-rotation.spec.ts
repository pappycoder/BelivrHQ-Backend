import { RateLimitGuard } from '../../../src/common/guards/rate-limit.guard';
import { ExecutionContext } from '@nestjs/common';

describe('Internal proxy secret rotation', () => {
  const original = process.env;
  afterEach(() => {
    process.env = original;
  });
  it.each([
    ['old-secret-'.repeat(4), true],
    ['next-secret-'.repeat(4), true],
    ['untrusted-secret-'.repeat(4), false],
  ])('accepts only active or explicitly retained proxy credentials', async (supplied, trusted) => {
    process.env = {
      ...original,
      INTERNAL_PROXY_SECRET: 'next-secret-'.repeat(4),
      INTERNAL_PROXY_SECRET_PREVIOUS_KEYS: JSON.stringify(['old-secret-'.repeat(4)]),
    };
    const incr = jest.fn().mockResolvedValue(1);
    const guard = new RateLimitGuard(
      { getAllAndOverride: () => undefined } as never,
      { isUpstash: false, incr } as never,
    );
    const request = {
      ip: '127.0.0.1',
      socket: {},
      headers: { 'x-belivrhq-proxy-secret': supplied, 'x-belivrhq-client-ip': '203.0.113.5' },
      method: 'GET',
      baseUrl: '/api/v1',
      path: '/test',
    };
    const context = {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(incr.mock.calls[0][0]).toContain(trusted ? 'ip:203.0.113.5:' : 'ip:127.0.0.1:');
  });
});
