import { queueRedisUrl } from '../../../src/queues/redis-connection';

describe('BullMQ Redis transport', () => {
  it('uses the dedicated TLS connection while cache uses REST', () => {
    const settings: Record<string, string> = {
      REDIS_URL: 'https://cache.example',
      QUEUE_REDIS_URL: 'rediss://default:private@queue.example:6379',
    };
    expect(queueRedisUrl((name) => settings[name])).toBe(settings.QUEUE_REDIS_URL);
  });
  it('preserves existing TCP deployments and local development', () => {
    expect(queueRedisUrl((name) => (name === 'REDIS_URL' ? 'redis://cache:6379' : ''))).toBe(
      'redis://cache:6379',
    );
    expect(queueRedisUrl(() => undefined)).toBe('redis://localhost:6379');
  });
  it.each(['https://cache.example', 'not-a-url', 'file:///private'])(
    'rejects unsupported transports without exposing credentials',
    (value) => {
      expect(() => queueRedisUrl(() => value)).toThrow(
        'BullMQ requires a redis:// or rediss:// connection',
      );
      try {
        queueRedisUrl(() => value);
      } catch (error) {
        expect((error as Error).message).not.toContain(value);
      }
    },
  );
});
