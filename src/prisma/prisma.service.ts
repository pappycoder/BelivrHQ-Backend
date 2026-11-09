/**
 * @file prisma.service.ts
 * @description Prisma database client service for the BelivrHQ Backend.
 *
 * This service extends PrismaClient and integrates with the NestJS dependency
 * injection system. It manages the database connection lifecycle by connecting
 * when the application module initializes and disconnecting when the module
 * is destroyed.
 *
 * PrismaService is registered as a global provider in PrismaModule, so it can
 * be injected into any service across the application via constructor injection.
 *
 * @example
 * ```typescript
 * @Injectable()
 * export class MembersService {
 *   constructor(private readonly prisma: PrismaService) {}
 *
 *   async findAll(churchId: string) {
 *     return this.prisma.member.findMany({ where: { church_id: churchId } });
 *   }
 * }
 * ```
 *
 * @module prisma/prisma.service
 * @since 1.0.0
 */

import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { InstrumentedPrismaPg } from './query-metrics';
import type { PoolConfig } from 'pg';
import { databasePoolSettings } from './pool-config';

/**
 * PrismaService provides database access through Prisma ORM.
 *
 * Extends PrismaClient to inherit all model query methods (findMany, create,
 * update, delete, etc.) and implements NestJS lifecycle hooks for connection
 * management.
 *
 * Uses the @prisma/adapter-pg driver adapter for PostgreSQL connections
 * as required by Prisma 7's "client" engine type.
 *
 * Connection pooling is configured via environment variables:
 * - DATABASE_URL: PostgreSQL connection string (required)
 * - DB_POOL_MAX: Persistent-process connections (default: 10)
 * - DB_SERVERLESS_POOL_MAX: Serverless per-instance connections (default: 1, maximum: 10)
 * - DB_IDLE_TIMEOUT_MS: Idle connection timeout in ms (default: 10000)
 * - DB_CONNECT_TIMEOUT_MS: Connection timeout in ms (default: 0 = no timeout)
 *
 * @extends PrismaClient
 * @implements OnModuleInit
 * @implements OnModuleDestroy
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    const { serverless: isServerless, ...settings } = databasePoolSettings(process.env);
    const poolConfig: PoolConfig = {
      connectionString: PrismaService.getConnectionString(isServerless),
      ...settings,
    };

    const adapter = new InstrumentedPrismaPg(poolConfig);
    super({ adapter });

    this.logger.log(
      `Connection pool configured: max=${poolConfig.max}, idleTimeout=${poolConfig.idleTimeoutMillis}ms, connectTimeout=${poolConfig.connectionTimeoutMillis}ms, serverless=${isServerless}`,
    );
  }

  /**
   * Supabase's session pooler caps client sessions to its configured pool size.
   * Serverless instances should use its transaction pooler instead. The
   * transaction pooler uses port 6543 and needs PgBouncer compatibility mode
   * so Prisma does not use prepared statements across pooled transactions.
   */
  private static getConnectionString(isServerless: boolean): string | undefined {
    const configuredUrl = process.env.DATABASE_URL;
    if (!configuredUrl || !isServerless) return configuredUrl;

    try {
      const url = new URL(configuredUrl);
      if (url.hostname.endsWith('.pooler.supabase.com') && (!url.port || url.port === '5432')) {
        url.port = '6543';
        url.searchParams.set('pgbouncer', 'true');
        return url.toString();
      }
    } catch {
      // Leave validation and connection errors to the PostgreSQL driver.
    }

    return configuredUrl;
  }

  /**
   * Called automatically when the application module is initialized.
   * Establishes the database connection pool.
   *
   * @returns {Promise<void>}
   */
  async onModuleInit(): Promise<void> {
    this.logger.log('Connecting to database...');
    await this.$connect();
    this.logger.log('Database connection established');
  }

  /**
   * Called automatically when the application module is destroyed.
   * Gracefully closes the database connection pool.
   *
   * @returns {Promise<void>}
   */
  async onModuleDestroy(): Promise<void> {
    this.logger.log('Disconnecting from database...');
    await this.$disconnect();
    this.logger.log('Database connection closed');
  }
}
