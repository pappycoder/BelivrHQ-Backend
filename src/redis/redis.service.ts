import { redisNamespace, redisKey } from './redis-namespace';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis as UpstashRedis } from '@upstash/redis';
import IORedis from 'ioredis';

type RedisClient = IORedis | UpstashRedis;

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly _client: RedisClient;
  private readonly _driver: 'ioredis' | 'upstash';
  private readonly _namespace: string;

  constructor(private readonly config: ConfigService) {
    this._namespace = redisNamespace((name) => this.config.get(name));
    const url = this.config.get<string>('REDIS_URL');
    if (!url) {
      throw new Error('REDIS_URL must be set');
    }

    if (url.startsWith('https://')) {
      this._driver = 'upstash';
      const token = this.config.get<string>('UPSTASH_REDIS_TOKEN');
      this._client = new UpstashRedis({ url, token });
      this.logger.log('Upstash Redis client initialized');
    } else {
      this._driver = 'ioredis';
      this._client = new IORedis(url, {
        maxRetriesPerRequest: 3,
        retryStrategy(times) {
          const delay = Math.min(times * 200, 2000);
          return delay;
        },
      });
      this._client.on('connect', () => this.logger.log('ioredis connected'));
      this._client.on('error', (err) => this.logger.error('ioredis error', err));
    }
  }

  key(key: string): string {
    return redisKey(key, this._namespace || '');
  }

  get client(): RedisClient {
    return this._client;
  }

  get isUpstash(): boolean {
    return this._driver === 'upstash';
  }

  async onModuleDestroy(): Promise<void> {
    if (this._driver === 'ioredis') {
      await (this._client as IORedis).quit();
    }
    this.logger.log('Redis client disconnected');
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    key = this.key(key);
    if (this._driver === 'upstash') {
      return (this._client as UpstashRedis).get<T>(key);
    }
    const raw = await (this._client as IORedis).get(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return raw as unknown as T;
    }
  }

  /** One atomic read of related keys, with the same decoding as get(). */
  async mget(...keys: string[]): Promise<unknown[]> {
    keys = keys.map((key) => this.key(key));
    if (!keys.length) return [];
    if (this._driver === 'upstash') return (this._client as UpstashRedis).mget(...keys);
    const values = await (this._client as IORedis).mget(...keys);
    return values.map((value) => {
      if (value === null) return null;
      try {
        return JSON.parse(value) as unknown;
      } catch {
        return value;
      }
    });
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    key = this.key(key);
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    if (this._driver === 'upstash') {
      if (ttlSeconds) {
        await (this._client as UpstashRedis).set(key, serialized, { ex: ttlSeconds });
      } else {
        await (this._client as UpstashRedis).set(key, serialized);
      }
    } else {
      if (ttlSeconds) {
        await (this._client as IORedis).set(key, serialized, 'EX', ttlSeconds);
      } else {
        await (this._client as IORedis).set(key, serialized);
      }
    }
  }

  /** Atomically consume a one-use authentication challenge. */
  async consume(key: string): Promise<unknown | null> {
    key = this.key(key);
    if (this._driver === 'upstash') return (this._client as UpstashRedis).getdel(key);
    return (this._client as IORedis).getdel(key);
  }

  /** Bounded SCAN iteration; Redis DEL does not expand glob patterns. */
  async deleteMatching(pattern: string): Promise<void> {
    pattern = this.key(pattern);
    let cursor = '0';
    do {
      if (this._driver === 'upstash') {
        const page = await (this._client as UpstashRedis).scan(Number(cursor), {
          match: pattern,
          count: 100,
        });
        cursor = String(page[0]);
        if (page[1].length) await (this._client as UpstashRedis).del(...page[1]);
      } else {
        const page = await (this._client as IORedis).scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = page[0];
        if (page[1].length) await (this._client as IORedis).del(...page[1]);
      }
    } while (cursor !== '0');
  }

  async del(key: string): Promise<void> {
    key = this.key(key);
    if (this._driver === 'upstash') {
      await (this._client as UpstashRedis).del(key);
    } else {
      await (this._client as IORedis).del(key);
    }
  }

  /**
   * Atomically increments a counter, optionally refreshing its TTL.
   *
   * Used by the cache-version interceptor to invalidate a tenant's cached
   * responses after any mutation.
   *
   * @param key - Counter key
   * @param ttlSeconds - Optional TTL to set after incrementing
   * @returns The new counter value
   */
  async incr(key: string, ttlSeconds = 0): Promise<number> {
    key = this.key(key);
    // One atomic round trip: a counter must never be left without its TTL.
    if (!ttlSeconds) return this._client.incr(key);
    const script =
      "local n = redis.call('INCR', KEYS[1]); redis.call('EXPIRE', KEYS[1], ARGV[1]); return n";
    if (this._driver === 'upstash')
      return Number(await (this._client as UpstashRedis).eval(script, [key], [ttlSeconds]));
    return Number(await (this._client as IORedis).eval(script, 1, key, ttlSeconds));
  }

  async exists(key: string): Promise<boolean> {
    key = this.key(key);
    if (this._driver === 'upstash') {
      const result = await (this._client as UpstashRedis).exists(key);
      return result === 1;
    }
    const result = await (this._client as IORedis).exists(key);
    return result === 1;
  }

  async expire(key: string, ttlSeconds: number): Promise<void> {
    key = this.key(key);
    if (this._driver === 'upstash') {
      await (this._client as UpstashRedis).expire(key, ttlSeconds);
    } else {
      await (this._client as IORedis).expire(key, ttlSeconds);
    }
  }

  async ping(): Promise<string> {
    if (this._driver === 'upstash') {
      await (this._client as UpstashRedis).ping();
      return 'pong';
    }
    return (this._client as IORedis).ping();
  }
}
