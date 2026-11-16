import * as Sentry from '@sentry/nestjs';
import { initializeTelemetry } from '../../../src/config/telemetry';

jest.mock('@sentry/nestjs', () => ({ init: jest.fn() }));
jest.mock('@sentry/profiling-node', () => ({ nodeProfilingIntegration: jest.fn(() => ({})) }));

describe('Shared HTTP and worker telemetry privacy', () => {
  it('does not initialize an unconfigured exporter', () => {
    initializeTelemetry({ NODE_ENV: 'test' });
    expect(Sentry.init).not.toHaveBeenCalled();
  });
  it.each(['production', 'test'] as const)(
    'scrubs credentials and request content in %s',
    (environment) => {
      const original = process.env.VERCEL_ENV;
      process.env.VERCEL_ENV = 'preview';
      try {
        initializeTelemetry({
          SENTRY_DSN: 'https://public@ingest.example/1',
          NODE_ENV: environment,
        });
        const options = jest.mocked(Sentry.init).mock.calls[0][0]!;
        expect(options.environment).toBe('preview');
        expect(options.sendDefaultPii).toBe(false);
        expect(options.traceLifecycle).toBe('static');
        const event = {
          request: {
            headers: { Authorization: 'private' },
            cookies: 'private',
            data: 'private',
            query_string: 'private',
            url: 'https://example/path?token=private',
          },
        };
        const clean = options.beforeSend!(event as never, {} as never);
        expect(JSON.stringify(clean)).not.toContain('private');
        const transaction = {
          ...event,
          spans: [
            { data: { password: 'private' }, description: 'request?token=private' },
            { data: {} },
          ],
        };
        expect(
          JSON.stringify(options.beforeSendTransaction!(transaction as never, {} as never)),
        ).not.toContain('private');
        expect(options.beforeSend!({} as never, {} as never)).toEqual({});
        expect(options.beforeSendTransaction!({} as never, {} as never)).toEqual({});
      } finally {
        if (original === undefined) delete process.env.VERCEL_ENV;
        else process.env.VERCEL_ENV = original;
      }
    },
  );
});
