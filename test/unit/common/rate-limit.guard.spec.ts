jest.mock('@upstash/ratelimit', () => ({
  Ratelimit: Object.assign(jest.fn(), { slidingWindow: jest.fn() }),
}));
import { ExecutionContext, HttpException, ServiceUnavailableException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Ratelimit } from '@upstash/ratelimit';
import {
  RateLimitGuard,
  RATE_LIMIT_KEY,
  RATE_LIMITS,
  SKIP_RATE_LIMIT_KEY,
} from '../../../src/common/guards/rate-limit.guard';
import { RedisService } from '../../../src/redis/redis.service';

describe('Shared rate limiting and unavailable-cache policy', () => {
  const handler = () => undefined;
  let guard: RateLimitGuard;
  let redis: { isUpstash: boolean; incr: jest.Mock; client: object };
  let cloud: jest.Mock;
  let setHeader: jest.Mock;
  let request: {
    method: string;
    baseUrl: string;
    path: string;
    ip?: string;
    socket: { remoteAddress?: string };
    headers: Record<string, string>;
    route?: { path: string };
    user?: { sub: string };
    res?: { setHeader: jest.Mock };
  };
  let context: ExecutionContext;
  beforeEach(() => {
    Reflect.deleteMetadata(RATE_LIMIT_KEY, handler);
    Reflect.deleteMetadata(SKIP_RATE_LIMIT_KEY, handler);
    redis = { isUpstash: false, incr: jest.fn().mockResolvedValue(1), client: {} };
    cloud = jest
      .fn()
      .mockResolvedValue({ success: true, limit: 100, remaining: 99, reset: Date.now() + 60000 });
    jest.mocked(Ratelimit).mockImplementation(() => ({ limit: cloud }) as unknown as Ratelimit);
    setHeader = jest.fn();
    request = {
      method: 'GET',
      baseUrl: '/api',
      path: '/records/one',
      socket: {},
      headers: {},
      res: { setHeader },
    };
    context = {
      getHandler: () => handler,
      getClass: () => RateLimitGuard,
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    guard = new RateLimitGuard(new Reflector(), redis as unknown as RedisService);
  });
  it('skips explicitly exempt endpoints without consulting cache', async () => {
    Reflect.defineMetadata(SKIP_RATE_LIMIT_KEY, true, handler);
    expect(await guard.canActivate(context)).toBe(true);
    expect(redis.incr).not.toHaveBeenCalled();
  });
  it.each([undefined, '127.0.0.1'])(
    'uses a safe unknown/socket fallback when request IP is absent (%s)',
    async (remoteAddress) => {
      request.socket.remoteAddress = remoteAddress;
      expect(await guard.canActivate(context)).toBe(true);
      expect(redis.incr.mock.calls[0][0]).toContain(
        `ip:${remoteAddress ?? 'unknown'}:GET:/api:/records/one`,
      );
    },
  );
  it('keys authenticated users and route templates independently of spoofed IP headers', async () => {
    request.user = { sub: 'verified-user' };
    request.route = { path: '/records/:id' };
    request.headers['x-forwarded-for'] = '1.2.3.4';
    await guard.canActivate(context);
    expect(redis.incr.mock.calls[0][0]).toContain('user:verified-user:GET:/api:/records/:id');
    expect(setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', 99);
  });
  it('returns 429 and retry headers when the shared TCP bucket is exhausted', async () => {
    redis.incr.mockResolvedValue(101);
    await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 429 });
    expect(setHeader).toHaveBeenCalledWith('Retry-After', expect.any(Number));
  });
  it.each([RATE_LIMITS.auth, RATE_LIMITS.sensitive])(
    'fails closed for sensitive production endpoints when Redis is unavailable (%j)',
    async (policy) => {
      jest.replaceProperty(process, 'env', { ...process.env, NODE_ENV: 'production' });
      Reflect.defineMetadata(RATE_LIMIT_KEY, policy, handler);
      redis.incr.mockRejectedValue(new Error('unavailable'));
      await expect(guard.canActivate(context)).rejects.toThrow(ServiceUnavailableException);
    },
  );
  it('uses a bounded memory fallback during development cache failures', async () => {
    jest.replaceProperty(process, 'env', { ...process.env, NODE_ENV: 'test' });
    Reflect.defineMetadata(RATE_LIMIT_KEY, { limit: 1, windowSeconds: 60 }, handler);
    redis.incr.mockRejectedValue(new Error('unavailable'));
    expect(await guard.canActivate(context)).toBe(true);
    await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 429 });
  });
  it('reuses one REST limiter for the same policy and forwards its response headers', async () => {
    redis.isUpstash = true;
    expect(await guard.canActivate(context)).toBe(true);
    expect(await guard.canActivate(context)).toBe(true);
    expect(Ratelimit).toHaveBeenCalledTimes(1);
    expect(cloud).toHaveBeenCalledTimes(2);
    expect(setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', 100);
  });
  it('propagates REST 429 responses without switching to a fresh memory allowance', async () => {
    redis.isUpstash = true;
    cloud.mockResolvedValue({
      success: false,
      limit: 100,
      remaining: 0,
      reset: Date.now() + 10000,
    });
    await expect(guard.canActivate(context)).rejects.toThrow(HttpException);
    expect(setHeader).toHaveBeenCalledWith('Retry-After', expect.any(Number));
  });
  it.each([true, false])(
    'applies the production sensitive policy to REST errors (sensitive=%s)',
    async (sensitive) => {
      jest.replaceProperty(process, 'env', { ...process.env, NODE_ENV: 'production' });
      redis.isUpstash = true;
      cloud.mockRejectedValue(new Error('unavailable'));
      Reflect.defineMetadata(
        RATE_LIMIT_KEY,
        sensitive ? RATE_LIMITS.auth : { limit: 11, windowSeconds: 60 },
        handler,
      );
      if (sensitive)
        await expect(guard.canActivate(context)).rejects.toThrow(ServiceUnavailableException);
      else {
        expect(await guard.canActivate(context)).toBe(true);
        for (let i = 0; i < 10; i++) expect(await guard.canActivate(context)).toBe(true);
        await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 429 });
      }
    },
  );
});
