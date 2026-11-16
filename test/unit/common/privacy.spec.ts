import { Logger } from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import { errorDiagnostic, observationText, requestLogPath } from '../../../src/common/privacy';
import { LoggingInterceptor } from '../../../src/common/interceptors/logging.interceptor';
import { GlobalExceptionFilter } from '../../../src/common/filters/global-exception.filter';
import { redactTelemetry } from '../../../src/config/telemetry-privacy';
import pino from 'pino';
import { HTTP_LOG_REDACTIONS } from '../../../src/common/privacy';

describe('Credential-safe operational diagnostics', () => {
  const token = 'synthetic-capability-secret';
  const detail = 'synthetic-private-record-and-password';
  it('redacts structured HTTP bindings and serialized errors in the real logger', () => {
    let output = '';
    const logger = pino(
      { redact: { paths: HTTP_LOG_REDACTIONS, censor: '[redacted]' } },
      {
        write(chunk: string) {
          output += chunk;
        },
      },
    );
    logger.info(
      {
        req: {
          method: 'POST',
          url: `/forms/public/${token}`,
          headers: { authorization: detail },
          body: { password: detail },
          params: { token },
          query: { token },
        },
        res: { headers: { 'set-cookie': detail } },
        err: { message: detail, stack: detail, cause: { password: detail } },
      },
      'Request failed',
    );
    expect(output).not.toContain(token);
    expect(output).not.toContain(detail);
    expect(JSON.parse(output).req.method).toBe('POST');
  });
  const request = {
    method: 'POST',
    headers: {},
    originalUrl: `/api/v1/forms/public/${token}/submit?token=${token}`,
    url: `/api/v1/forms/public/${token}/submit?token=${token}`,
    route: { path: '/api/v1/forms/public/:publicToken/submit' },
  };
  it.each(['forms', 'intake', 'register'])(
    'redacts %s path credentials as well as queries and fragments',
    (kind) => {
      expect(
        observationText(
          `https://user:${detail}@example.org/${kind}/public/${token}/meta?password=${detail}#${token}`,
        ),
      ).toBe('https://[redacted]@example.org/' + kind + '/public/[redacted]/meta');
    },
  );
  it('logs a route template or an unmatched marker, never the raw fallback path', () => {
    expect(requestLogPath(request)).toBe('/api/v1/forms/public/[redacted]/submit');
    expect(requestLogPath({})).toBe('/unmatched');
    expect(errorDiagnostic(new Error(detail))).toBe('unexpected_error');
    expect(errorDiagnostic({ code: 'P2002', message: detail })).toBe('P2002');
    expect(errorDiagnostic({ code: detail })).toBe('unexpected_error');
  });
  it('scrubs successful and failed HTTP logs while forwarding the original error', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const response = { statusCode: 200, headersSent: false, setHeader: jest.fn() };
      const context = {
        switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
      };
      const interceptor = new LoggingInterceptor();
      await lastValueFrom(
        interceptor.intercept(context as never, { handle: () => of({ ok: true }) }),
      );
      await expect(
        lastValueFrom(
          interceptor.intercept(context as never, {
            handle: () => throwError(() => new Error(detail)),
          }),
        ),
      ).rejects.toThrow(detail);
      const captured = JSON.stringify([log.mock.calls, errorLog.mock.calls]);
      expect(captured).not.toContain(token);
      expect(captured).not.toContain(detail);
      expect(captured).toContain('[redacted]');
    } finally {
      log.mockRestore();
      errorLog.mockRestore();
    }
  });
  it('does not send a raw exception stack to the global error logger', () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const log = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const response = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
        setHeader: jest.fn(),
      };
      const host = {
        switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
      };
      new GlobalExceptionFilter().catch(new Error(detail), host as never);
      expect(response.status).toHaveBeenCalledWith(500);
      expect(response.json.mock.calls[0][0].error.message).toBe('An unexpected error occurred');
      expect(JSON.stringify(log.mock.calls)).not.toContain(detail);
      expect(JSON.stringify(log.mock.calls)).not.toContain(token);
    } finally {
      process.env.NODE_ENV = previous;
      log.mockRestore();
    }
  });
  it('redacts SDK request paths, exception values, frame variables, breadcrumbs and database spans', () => {
    const event = {
      request: { url: request.originalUrl, data: detail, headers: { authorization: detail } },
      message: detail,
      extra: { password: detail },
      contexts: { request: { path: token }, trace: { data: { password: detail } } },
      transaction: request.originalUrl,
      tags: { url: request.originalUrl },
      exception: {
        values: [
          {
            type: 'Error',
            value: detail,
            stacktrace: { frames: [{ filename: 'service.js', vars: { password: detail } }] },
          },
        ],
      },
      breadcrumbs: [
        { category: 'http', message: detail, data: { url: request.originalUrl, body: detail } },
      ],
      spans: [{ op: 'db.query', description: `SELECT '${detail}'`, data: { password: detail } }],
    };
    const cleaned = JSON.stringify(redactTelemetry(event as never));
    expect(cleaned).not.toContain(token);
    expect(cleaned).not.toContain(detail);
    expect(cleaned).toContain('service.js');
    expect(cleaned).toContain('Database operation');
  });
});
