import { LEGACY_BRAND } from '../../brand/brand';
import { measureStage, queryMetrics } from '../../prisma/query-metrics';
/**
 * @file rate-limit.guard.ts
 * @description Guard that enforces rate limiting using Upstash Redis (cloud) or in-memory (local dev).
 *
 * Uses sliding window rate limiting to prevent API abuse.
 * Different limits can be applied per-route using @RateLimit() decorator.
 * Apply @SkipRateLimit() to exempt specific routes (webhooks, health checks).
 *
 * Local development uses a simple in-memory sliding window implementation
 * so rate limiting works consistently in all environments.
 *
 * @module common/guards/rate-limit.guard
 * @since 1.0.0
 */

import {
  Injectable,
  ServiceUnavailableException,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Logger,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Ratelimit } from '@upstash/ratelimit';
import { RedisService } from '../../redis/redis.service';
import { Redis } from '@upstash/redis';
import { AuthenticatedRequest } from '../decorators/current-user.decorator';
import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

export const RATE_LIMIT_KEY = 'rate_limit';
export const SKIP_RATE_LIMIT_KEY = 'skip_rate_limit';

/**
 * Rate limit configuration.
 */
export interface RateLimitConfig {
  /** Number of requests allowed in the window */
  limit: number;
  /** Time window in seconds */
  windowSeconds: number;
}

/**
 * Default rate limits for different endpoint types.
 */
export const RATE_LIMITS = {
  /** General API endpoints: 100 requests per minute */
  default: { limit: 100, windowSeconds: 60 },
  /** Auth endpoints: 10 requests per minute (login, register) */
  auth: { limit: 10, windowSeconds: 60 },
  /** Sensitive operations: 5 requests per minute */
  sensitive: { limit: 5, windowSeconds: 60 },
  /** Webhook endpoints: 500 requests per minute */
  webhook: { limit: 500, windowSeconds: 60 },
} as const;

/**
 * Rate limit decorator.
 *
 * @example
 * ```typescript
 * @Post('login')
 * @RateLimit(RATE_LIMITS.auth)
 * login() { ... }
 * ```
 */
export const RateLimit =
  (config: RateLimitConfig) =>
  (_target: object, _propertyKey?: string, descriptor?: PropertyDescriptor) => {
    if (descriptor) {
      Reflect.defineMetadata(RATE_LIMIT_KEY, config, descriptor.value);
    }
    return descriptor;
  };

/**
 * Decorator to skip rate limiting on specific routes.
 * Use for public endpoints like webhooks and health checks.
 *
 * @example
 * ```typescript
 * @Post('webhook')
 * @SkipRateLimit()
 * processWebhook() { ... }
 * ```
 */
export const SkipRateLimit = () => SetMetadata(SKIP_RATE_LIMIT_KEY, true);

/**
 * Simple in-memory sliding window rate limiter.
 * Used as a fallback when Upstash Redis is not available (local dev with ioredis).
 */
class InMemoryRateLimiter {
  private windows = new Map<string, number[]>();
  private cleanupInterval: ReturnType<typeof setInterval>;

  constructor() {
    // Clean up expired entries every 60 seconds
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
    this.cleanupInterval.unref();
  }

  /**
   * Checks if a request should be allowed through.
   *
   * @param key - Unique identifier (IP + endpoint)
   * @param limit - Max requests allowed in the window
   * @param windowMs - Time window in milliseconds
   * @returns Whether the request passes and current usage stats
   */
  check(
    key: string,
    limit: number,
    windowMs: number,
  ): { success: boolean; limit: number; remaining: number; reset: number } {
    const now = Date.now();
    const windowStart = now - windowMs;

    let timestamps = this.windows.get(key) || [];
    // Remove timestamps outside the current window
    timestamps = timestamps.filter((ts) => ts > windowStart);

    const remaining = Math.max(0, limit - timestamps.length);
    const success = timestamps.length < limit;

    if (success) {
      timestamps.push(now);
      this.windows.set(key, timestamps);
    }

    return {
      success,
      limit,
      remaining,
      reset: Math.ceil((now + windowMs) / 1000),
    };
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, timestamps] of this.windows.entries()) {
      const valid = timestamps.filter((ts) => ts > now - 60000);
      if (valid.length === 0) {
        this.windows.delete(key);
      } else {
        this.windows.set(key, valid);
      }
    }
  }
}

/**
 * Guard that enforces rate limiting per IP address.
 *
 * Uses Upstash Redis (cloud) or in-memory (local dev) sliding window
 * algorithm for consistent rate limiting across all environments.
 * Registered globally via APP_GUARD in AppModule.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);
  private readonly limiterCache = new Map<string, Ratelimit>();
  private readonly inMemoryLimiter = new InMemoryRateLimiter();

  constructor(
    private readonly reflector: Reflector,
    private readonly redis: RedisService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    return measureStage('rate_limit', () => this.check(context));
  }

  private async check(context: ExecutionContext): Promise<boolean> {
    const metrics = queryMetrics.getStore();
    if (metrics) metrics.redisDriver = this.redis.isUpstash ? 'upstash-rest' : 'ioredis';
    // Check if route is explicitly exempt from rate limiting
    const handler = context.getHandler();
    const classRef = context.getClass();
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_RATE_LIMIT_KEY, [
      handler,
      classRef,
    ]);
    if (skip) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    let ip = request.ip || request.socket.remoteAddress || 'unknown';
    const modern = request.headers['x-belivrhq-proxy-secret'] !== undefined;
    const supplied =
      request.headers[modern ? 'x-belivrhq-proxy-secret' : LEGACY_BRAND.proxySecretHeader];
    const secret = process.env.INTERNAL_PROXY_SECRET;
    const forwarded = request.headers[modern ? 'x-belivrhq-client-ip' : LEGACY_BRAND.proxyIpHeader];
    if (
      secret &&
      typeof supplied === 'string' &&
      Buffer.byteLength(secret) === Buffer.byteLength(supplied) &&
      timingSafeEqual(Buffer.from(secret), Buffer.from(supplied)) &&
      typeof forwarded === 'string' &&
      isIP(forwarded)
    )
      ip = forwarded;
    const identity = request.user?.sub ? `user:${request.user.sub}` : `ip:${ip}`;
    const routeKey = `${request.method}:${request.baseUrl}:${request.route?.path ?? request.path}`;

    // Check for custom rate limit on the handler
    const customConfig = this.reflector.getAllAndOverride<RateLimitConfig>(RATE_LIMIT_KEY, [
      handler,
    ]);

    const config = customConfig || RATE_LIMITS.default;

    try {
      if (!this.redis.isUpstash) {
        const key = `${identity}:${routeKey}`;
        const now = Date.now();
        let result;
        try {
          const bucket = Math.floor(now / (config.windowSeconds * 1000));
          const count = await this.redis.incr(`rate:${key}:${bucket}`, config.windowSeconds + 1);
          result = {
            success: count <= config.limit,
            limit: config.limit,
            remaining: Math.max(0, config.limit - count),
            reset: (bucket + 1) * config.windowSeconds,
          };
        } catch {
          if (process.env.NODE_ENV === 'production' && config.limit <= RATE_LIMITS.auth.limit)
            throw new ServiceUnavailableException('Please try again when the service is available');
          result = this.inMemoryLimiter.check(key, config.limit, config.windowSeconds * 1000);
        }

        request.res?.setHeader('X-RateLimit-Limit', result.limit);
        request.res?.setHeader('X-RateLimit-Remaining', result.remaining);
        request.res?.setHeader('X-RateLimit-Reset', result.reset);

        if (!result.success) {
          request.res?.setHeader(
            'Retry-After',
            Math.max(1, result.reset - Math.floor(Date.now() / 1000)),
          );
          throw new HttpException(
            'Too many requests. Please try again later.',
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }

        return true;
      }

      // Use Upstash Redis rate limiter for production
      const cacheKey = `${config.limit}:${config.windowSeconds}`;
      let limiter = this.limiterCache.get(cacheKey);
      if (!limiter) {
        limiter = new Ratelimit({
          redis: this.redis.client as unknown as Redis,
          limiter: Ratelimit.slidingWindow(config.limit, `${config.windowSeconds} s`),
          analytics: true,
        });
        this.limiterCache.set(cacheKey, limiter);
      }

      const key = `${identity}:${routeKey}`;
      const { success, limit, remaining, reset } = await limiter.limit(key);

      request.res?.setHeader('X-RateLimit-Limit', limit);
      request.res?.setHeader('X-RateLimit-Remaining', remaining);
      request.res?.setHeader('X-RateLimit-Reset', reset);

      if (!success) {
        request.res?.setHeader('Retry-After', Math.max(1, Math.ceil((reset - Date.now()) / 1000)));
        throw new HttpException(
          'Too many requests. Please try again later.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      return true;
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      this.logger.warn('Shared rate limiter unavailable');
      if (process.env.NODE_ENV === 'production' && config.limit <= RATE_LIMITS.auth.limit)
        throw new ServiceUnavailableException('Please try again when the service is available');
      const result = this.inMemoryLimiter.check(
        `${identity}:${routeKey}`,
        config.limit,
        config.windowSeconds * 1000,
      );
      if (!result.success)
        throw new HttpException(
          'Too many requests. Please try again later.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      return true;
    }
  }
}
