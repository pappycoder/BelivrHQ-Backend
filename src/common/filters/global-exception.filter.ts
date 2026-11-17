import { queryMetrics, serverTiming } from '../../prisma/query-metrics';
import { subscriptionError } from '../../billing/plan-errors';
import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ZodError } from 'zod';
import { requestLogPath, errorDiagnostic } from '../privacy';

/**
 * Standardized error response format.
 * All API errors follow this structure for consistent client-side handling.
 */
interface ErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
    timestamp: string;
    path: string;
    method: string;
  };
}

/**
 * Global exception filter that catches all unhandled exceptions
 * and returns a standardized JSON error response.
 *
 * Handles:
 * - HttpException (NestJS built-in): Extracts status code and message
 * - ZodError: Formats validation errors from Zod schemas
 * - Prisma errors: Maps Prisma error codes to user-friendly messages
 * - Unknown errors: Returns 500 Internal Server Error
 *
 * Also logs all errors with structured metadata for debugging.
 *
 * @example
 * // Registered globally in main.ts:
 * app.useGlobalFilters(new GlobalExceptionFilter());
 *
 * // Response format:
 * {
 *   "success": false,
 *   "error": {
 *     "code": "NOT_FOUND",
 *     "message": "Member not found",
 *     "timestamp": "2026-07-15T10:30:00.000Z",
 *     "path": "/api/v1/members/123",
 *     "method": "GET"
 *   }
 * }
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const { status, code, message, details } = this.handleError(exception);

    const errorResponse: ErrorResponse = {
      success: false,
      error: {
        code,
        message,
        details,
        timestamp: new Date().toISOString(),
        path: request.url.split('?')[0],
        method: request.method,
      },
    };

    const metrics = queryMetrics.getStore();
    if (metrics && !response.headersSent) {
      response.setHeader(
        'Server-Timing',
        serverTiming(metrics, performance.now() - metrics.startedAt),
      );
    }

    // Log the error with context
    this.logger.error(
      `${request.method} ${requestLogPath(request)} ${status} queries=${metrics?.queries ?? 0} stages=${JSON.stringify(metrics?.stages ?? {})} pool=${JSON.stringify(metrics?.pool ?? {})}`,
      errorDiagnostic(exception),
    );

    response.status(status).json(errorResponse);
  }

  /**
   * Maps exception types to HTTP status codes, error codes, and messages.
   */
  private handleError(exception: unknown): {
    status: number;
    code: string;
    message: string;
    details?: unknown;
  } {
    const planFailure = subscriptionError(exception);
    if (planFailure) return planFailure;

    // Handle Zod validation errors
    if (exception instanceof ZodError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: exception.issues.map((issue) => ({
          field: issue.path.map(String).join('.'),
          message: issue.message,
        })),
      };
    }

    // Handle NestJS HttpExceptions
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      let message: string;
      let details: unknown;

      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
        const responseObj = exceptionResponse as Record<string, unknown>;
        message = (responseObj.message as string) || exception.message;
        details = responseObj.details || responseObj.error;
      } else {
        message = exception.message;
      }

      return {
        status,
        code:
          typeof exceptionResponse === 'object' &&
          exceptionResponse !== null &&
          'code' in exceptionResponse
            ? String(exceptionResponse.code)
            : this.getErrorCode(status),
        message,
        details,
      };
    }

    // Handle Prisma errors
    if (exception && typeof exception === 'object' && 'code' in exception) {
      const prismaError = exception as { code: string; meta?: unknown; message?: string };
      if (prismaError.code.startsWith('P')) {
        return this.handlePrismaError(prismaError);
      }
    }

    // Handle generic Error objects
    if (exception instanceof Error) {
      // Don't expose internal error messages in production
      const message =
        process.env.NODE_ENV === 'production' ? 'An unexpected error occurred' : exception.message;

      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        code: 'INTERNAL_ERROR',
        message,
      };
    }

    // Unknown error type
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    };
  }

  /**
   * Maps Prisma error codes to user-friendly responses.
   * @see https://www.prisma.io/docs/reference/api-reference/error-reference
   */
  private handlePrismaError(error: { code: string; meta?: unknown; message?: string }): {
    status: number;
    code: string;
    message: string;
    details?: unknown;
  } {
    switch (error.code) {
      case 'P2002': {
        // Unique constraint violation
        const target = (error.meta as { target?: string[] })?.target;
        const field = target?.[0] || 'field';
        return {
          status: HttpStatus.CONFLICT,
          code: 'DUPLICATE_ENTRY',
          message: `A record with this ${field} already exists`,
          details: { field },
        };
      }
      case 'P2025':
        // Record not found
        return {
          status: HttpStatus.NOT_FOUND,
          code: 'NOT_FOUND',
          message: 'The requested resource was not found',
        };
      case 'P2003':
        // Foreign key constraint violation
        return {
          status: HttpStatus.BAD_REQUEST,
          code: 'FOREIGN_KEY_ERROR',
          message: 'Referenced resource does not exist',
        };
      case 'P2014':
        // Required relation violation
        return {
          status: HttpStatus.BAD_REQUEST,
          code: 'RELATION_ERROR',
          message: 'Cannot perform this action due to related records',
        };
      default:
        return {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          code: 'DATABASE_ERROR',
          message:
            process.env.NODE_ENV === 'production'
              ? 'A database error occurred'
              : error.message || 'Database error',
        };
    }
  }

  /**
   * Maps HTTP status codes to error codes.
   */
  private getErrorCode(status: number): string {
    const codes: Record<number, string> = {
      [HttpStatus.BAD_REQUEST]: 'BAD_REQUEST',
      [HttpStatus.UNAUTHORIZED]: 'UNAUTHORIZED',
      [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
      [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
      [HttpStatus.CONFLICT]: 'CONFLICT',
      [HttpStatus.UNPROCESSABLE_ENTITY]: 'VALIDATION_ERROR',
      [HttpStatus.TOO_MANY_REQUESTS]: 'RATE_LIMITED',
      [HttpStatus.INTERNAL_SERVER_ERROR]: 'INTERNAL_ERROR',
      [HttpStatus.BAD_GATEWAY]: 'BAD_GATEWAY',
      [HttpStatus.SERVICE_UNAVAILABLE]: 'SERVICE_UNAVAILABLE',
    };
    return codes[status] || 'ERROR';
  }
}
