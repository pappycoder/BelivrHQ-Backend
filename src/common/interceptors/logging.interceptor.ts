/**
 * @file logging.interceptor.ts
 * @description NestJS interceptor for structured request/response logging.
 *
 * Logs every incoming HTTP request with:
 * - Method, URL, status code
 * - Response time in milliseconds
 * - User agent and IP (for audit trail)
 * - Request ID for tracing
 *
 * Uses NestJS Logger for output (integrates with any LoggerService).
 *
 * @module common/interceptors/logging.interceptor
 * @since 1.0.0
 */

import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
  HttpException,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { Request, Response } from 'express';
import { queryMetrics, serverTiming } from '../../prisma/query-metrics';
import { randomUUID } from 'crypto';
import { requestLogPath, errorDiagnostic } from '../privacy';

/**
 * Interceptor that logs all HTTP requests with timing and metadata.
 *
 * @example
 * // Registered globally in main.ts:
 * app.useGlobalInterceptors(new LoggingInterceptor());
 *
 * // Output:
 * // [LOG] GET /api/v1/members 200 45ms - user_agent: Mozilla/5.0...
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();

    const { method } = request;
    const url = requestLogPath(request);
    const suppliedId = request.headers['x-request-id'];
    const requestId =
      typeof suppliedId === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(suppliedId)
        ? suppliedId
        : randomUUID();

    // Attach request ID to request and response header for tracing
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    (request as unknown as Record<string, unknown>)['requestId'] = requestId;
    response.setHeader('X-Request-Id', requestId);

    const metrics = queryMetrics.getStore();
    const handlerStarted = performance.now();
    const startTime = metrics?.startedAt ?? handlerStarted;
    const recordHandler = () => {
      if (metrics) {
        metrics.stages ??= {};
        metrics.stages.handler = performance.now() - handlerStarted;
      }
    };

    return next.handle().pipe(
      tap({
        next: () => {
          recordHandler();
          const { statusCode } = response;
          const duration = Math.round(performance.now() - startTime);

          if (!response.headersSent)
            response.setHeader('Server-Timing', serverTiming(metrics, duration));
          this.logger.log(
            `${method} ${url} ${statusCode} ${duration}ms queries=${metrics?.queries ?? 0} dbMs=${Math.round(metrics?.milliseconds ?? 0)} stages=${JSON.stringify(metrics?.stages ?? {})} pool=${JSON.stringify(metrics?.pool ?? {})} requestId=${requestId}`,
          );
        },
        error: (error) => {
          recordHandler();
          const statusCode = error instanceof HttpException ? error.getStatus() : 500;
          const duration = Math.round(performance.now() - startTime);

          this.logger.error(
            `${method} ${url} ${statusCode} ${duration}ms queries=${metrics?.queries ?? 0} dbMs=${Math.round(metrics?.milliseconds ?? 0)} stages=${JSON.stringify(metrics?.stages ?? {})} pool=${JSON.stringify(metrics?.pool ?? {})} requestId=${requestId}`,
            errorDiagnostic(error),
          );
        },
      }),
    );
  }
}
