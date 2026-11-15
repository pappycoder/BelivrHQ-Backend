import { RedisService } from '../../../src/redis/redis.service';
import { redisNamespace, redisKey, queuePrefix } from '../../../src/redis/redis-namespace';
import { AssistantBudget } from '../../../src/assistant/assistant.budget';
import { ConfigService } from '@nestjs/config';

describe('Shared Redis environment separation', () => {
  it('preserves production namespaces and separates default Preview queues', () => {
    expect(redisNamespace((name) => (name === 'VERCEL_ENV' ? 'production' : undefined))).toBe('');
    expect(queuePrefix((name) => (name === 'VERCEL_ENV' ? 'production' : undefined))).toBe('bull');
    expect(queuePrefix((name) => (name === 'VERCEL_ENV' ? 'preview' : undefined))).toBe(
      'belivrhq-preview:bull',
    );
    expect(redisKey('cache:tenant', 'belivrhq-preview')).toBe('belivrhq-preview:cache:tenant');
    expect(() =>
      redisNamespace((name) => (name === 'REDIS_NAMESPACE' ? '*' : undefined)),
    ).toThrow();
  });
  it.each(['ioredis', 'upstash'])(
    'namespaces cache, challenge, counters and invalidation on %s',
    async (driver) => {
      const client = {
        get: jest.fn().mockResolvedValue(null),
        mget: jest.fn().mockResolvedValue([]),
        set: jest.fn(),
        getdel: jest.fn(),
        del: jest.fn(),
        incr: jest.fn().mockResolvedValue(1),
        eval: jest.fn().mockResolvedValue(1),
        exists: jest.fn().mockResolvedValue(1),
        expire: jest.fn(),
        scan: jest.fn().mockResolvedValue(['0', ['preview:cache:1']]),
      };
      const service = Object.assign(Object.create(RedisService.prototype), {
        _driver: driver,
        _client: client,
        _namespace: 'preview',
      }) as RedisService;
      await service.get('key');
      await service.mget('one', 'two');
      await service.set('key', 'value', 60);
      await service.consume('challenge');
      await service.incr('count');
      await service.incr('ttl-count', 60);
      await service.exists('key');
      await service.expire('key', 60);
      await service.del('key');
      await service.deleteMatching('cache:*');
      expect(client.get).toHaveBeenCalledWith('preview:key');
      expect(client.mget).toHaveBeenCalledWith('preview:one', 'preview:two');
      expect(client.set.mock.calls[0][0]).toBe('preview:key');
      expect(client.getdel).toHaveBeenCalledWith('preview:challenge');
      expect(client.incr).toHaveBeenCalledWith('preview:count');
      expect(JSON.stringify(client.eval.mock.calls[0])).toContain('preview:ttl-count');
      expect(client.exists).toHaveBeenCalledWith('preview:key');
      expect(client.expire).toHaveBeenCalledWith('preview:key', 60);
      expect(client.del).toHaveBeenCalledWith('preview:key');
      expect(client.del).toHaveBeenCalledWith('preview:cache:1'); // SCAN results must not be prefixed twice.
      expect(JSON.stringify(client.scan.mock.calls[0])).toContain('preview:cache:*');
    },
  );
  it('isolates raw Lua budget counters on a shared Redis instance', async () => {
    const evalMock = jest.fn().mockResolvedValue(1);
    const budget = new AssistantBudget(
      { isUpstash: true, client: { eval: evalMock } } as unknown as RedisService,
      new ConfigService({ REDIS_NAMESPACE: 'preview' }),
    );
    await expect(budget.reserve('church', 'profile', 'community', 1)).resolves.toBe(true);
    expect(evalMock.mock.calls[0][1].every((key: string) => key.startsWith('preview:'))).toBe(true);
  });
});
