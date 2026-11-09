import { databasePoolSettings } from '../../../src/prisma/pool-config';

function environment(overrides: NodeJS.ProcessEnv = {}) {
  const previous = process.env;
  let result: typeof import('../../../src/config/env.validation').env;
  process.env = {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://test:test@localhost:5433/config_test',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
    SUPABASE_ANON_KEY: 'test-anon-key',
    REDIS_URL: 'redis://localhost:6379',
    ALTCHA_HMAC_KEY: 'a'.repeat(64),
    ...overrides,
  };
  try {
    jest.isolateModules(() => {
      result = jest.requireActual<typeof import('../../../src/config/env.validation')>(
        '../../../src/config/env.validation',
      ).env;
    });
    return result!;
  } finally {
    process.env = previous;
  }
}

describe('Environment defaults', () => {
  it.each([{}, { VERCEL: '1' }, { AWS_LAMBDA_FUNCTION_NAME: 'test' }])(
    'matches the actual database runtime when overrides are omitted: %j',
    (flags) => {
      const env = environment(flags);
      const pool = databasePoolSettings(flags);
      expect(env.DB_CONNECT_TIMEOUT_MS).toBe(pool.connectionTimeoutMillis);
      expect(env.DB_IDLE_TIMEOUT_MS).toBe(pool.idleTimeoutMillis);
      expect(env.DB_POOL_MAX).toBe(10);
      expect(env.DB_SERVERLESS_POOL_MAX).toBe(1);
    },
  );
  it('keeps explicit database timeout overrides', () => {
    const env = environment({ DB_CONNECT_TIMEOUT_MS: '4000', DB_IDLE_TIMEOUT_MS: '5000' });
    expect(env.DB_CONNECT_TIMEOUT_MS).toBe(4000);
    expect(env.DB_IDLE_TIMEOUT_MS).toBe(5000);
  });
  it('keeps SMS fallback disabled when omitted or explicitly false', () => {
    expect(environment().ENABLE_SMS_FALLBACK).toBe(false);
    expect(environment({ ENABLE_SMS_FALLBACK: 'false' }).ENABLE_SMS_FALLBACK).toBe(false);
    expect(environment({ ENABLE_SMS_FALLBACK: 'true' }).ENABLE_SMS_FALLBACK).toBe(true);
  });
  it('allows empty unconfigured key slots locally', () => {
    const env = environment({
      PASTORAL_ENCRYPTION_KEY: '',
      TWO_FACTOR_ENCRYPTION_KEY: '',
      INTEGRATIONS_ENCRYPTION_KEY: '',
      INTERNAL_PROXY_SECRET: '',
      PUBLIC_API_URL: '',
    });
    expect(env.PASTORAL_ENCRYPTION_KEY).toBeUndefined();
    expect(env.TWO_FACTOR_ENCRYPTION_KEY).toBeUndefined();
    expect(env.INTEGRATIONS_ENCRYPTION_KEY).toBeUndefined();
    expect(env.INTERNAL_PROXY_SECRET).toBeUndefined();
    expect(env.PUBLIC_API_URL).toBeUndefined();
  });

  it('preserves explicitly configured production encryption keys', () => {
    const values = {
      NODE_ENV: 'production',
      PASTORAL_ENCRYPTION_KEY: 'p'.repeat(32),
      TWO_FACTOR_ENCRYPTION_KEY: 'b'.repeat(64),
      INTEGRATIONS_ENCRYPTION_KEY: 'a'.repeat(64),
      INTERNAL_PROXY_SECRET: 's'.repeat(32),
    };
    expect(environment(values)).toMatchObject(values);
  });

  it('rejects a blank production-required pastoral encryption key', () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('configuration rejected');
    });
    const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => environment({ NODE_ENV: 'production', PASTORAL_ENCRYPTION_KEY: '' })).toThrow(
        'configuration rejected',
      );
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      exit.mockRestore();
      log.mockRestore();
    }
  });
});
