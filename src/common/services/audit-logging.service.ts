/**
 * @file audit-logging.service.ts
 * @description Service for recording audit logs of data mutations.
 *
 * Records create, update, and delete operations against the audit_logs table
 * for compliance, debugging, and security review.
 *
 * Each audit entry captures:
 * - Who (user_id, church_id)
 * - What (entity, action, entity_id)
 * - Before/after state (old_values / new_values)
 * - IP address and user agent
 *
 * @module common/services/audit-logging.service
 * @since 1.0.0
 */

import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { NOTIFICATIONS_SERVICE_TOKEN } from '../../notifications/notification-tokens';

export type AuditAction =
  'CREATE' | 'UPDATE' | 'DELETE' | 'LOGIN' | 'LOGOUT' | 'EXPORT' | 'ARCHIVE' | 'RESTORE';

export interface AuditLogParams {
  userId: string;
  churchId: string;
  entity: string;
  action: AuditAction;
  entityId?: string;
  oldValues?: Record<string, unknown>;
  newValues?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Audit actions that produce an in-app notification for the acting user.
 * Only mutating CRUD actions notify — reads/login/logout/exports do not.
 */
const NOTIFICATION_ACTIONS: AuditAction[] = ['CREATE', 'UPDATE', 'DELETE', 'ARCHIVE', 'RESTORE'];

const ACTION_VERB: Record<string, string> = {
  CREATE: 'created',
  UPDATE: 'updated',
  DELETE: 'deleted',
  ARCHIVE: 'archived',
  RESTORE: 'restored',
};

const CRUD_TITLE: Record<string, string> = {
  CREATE: 'Created',
  UPDATE: 'Updated',
  DELETE: 'Deleted',
  ARCHIVE: 'Archived',
  RESTORE: 'Restored',
};

/**
 * Pulls a human-friendly record name out of the audit `newValues` payload so a
 * notification can read "Member <name> updated" instead of just "Member".
 */
function resolveEntityLabel(entity: string, newValues?: Record<string, unknown>): string | null {
  if (!newValues) return null;

  const nameCandidates =
    entity === 'member'
      ? ['firstName', 'first_name', 'fullName', 'name']
      : ['name', 'fullName', 'title', 'firstName', 'first_name', 'label'];

  for (const key of nameCandidates) {
    const value = newValues[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Converts a snake_case entity name into a readable title-cased label
 * (e.g. "giving_category" → "Giving Category", "cell_group" → "Cell Group").
 */
function humanizeEntity(entity: string): string {
  return entity
    .split('_')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Builds the notification title/body for a CRUD action on an entity.
 */
function crudNotificationText(
  action: AuditAction,
  entity: string,
  label: string,
): { title: string; body: string } {
  const title = `${CRUD_TITLE[action]} ${humanizeEntity(entity)}`;
  const verb = ACTION_VERB[action];
  return { title, body: `You ${verb} ${label}.` };
}

/**
 * Service for recording audit trail entries.
 *
 * All mutations to sensitive data (members, transactions, giving, etc.)
 * should be logged through this service for compliance and security.
 *
 * @example
 * ```typescript
 * await this.audit.log({
 *   userId,
 *   churchId,
 *   entity: 'member',
 *   action: 'CREATE',
 *   entityId: member.id,
 *   newValues: member,
 * });
 * ```
 */
@Injectable()
export class AuditLoggingService {
  private readonly logger = new Logger(AuditLoggingService.name);
  private notifications?: {
    createNotification(
      churchId: string,
      profileId: string,
      type: string,
      title: string,
      body: string,
      data?: Record<string, unknown>,
    ): Promise<unknown>;
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * Records an audit log entry.
   *
   * @param params - Audit log data
   */
  async log(params: AuditLogParams): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          church_id: params.churchId,
          user_id: params.userId,
          entity: params.entity,
          action: params.action,
          entity_id: params.entityId,
          old_values: params.oldValues as Prisma.InputJsonValue | undefined,
          new_values: params.newValues as Prisma.InputJsonValue | undefined,
          ip_address: params.ipAddress,
          user_agent: params.userAgent,
        },
      });
    } catch (error) {
      this.logger.error(
        `Failed to write audit log: ${params.action} on ${params.entity}`,
        error instanceof Error ? error.stack : String(error),
      );
    }

    // Mirror every user CRUD mutation with an in-app notification for the
    // acting user. LOAD/EXPORT reads are excluded — only create, update,
    // delete (and archive/restore) notify.
    if (NOTIFICATION_ACTIONS.includes(params.action)) {
      await this.createCrudNotification(params);
    }
  }

  /**
   * Creates an in-app notification describing a user's CRUD action. Failures
   * are swallowed so a notification issue can never break the CRUD operation.
   *
   * `NotificationsService` is resolved lazily through the container rather
   * than injected directly: `NotificationsService` depends on `WhatsAppService`,
   * which depends on `AuditLoggingService`, so a direct constructor dependency
   * would be circular. Lazy resolution breaks that cycle while still working.
   */
  /** Notify after a caller has committed its own transactional audit entry. */
  async notifyMutation(params: AuditLogParams): Promise<void> {
    if (NOTIFICATION_ACTIONS.includes(params.action)) await this.createCrudNotification(params);
  }

  private async createCrudNotification(params: AuditLogParams): Promise<void> {
    try {
      if (!params.userId) return;

      const notifications = (this.notifications ??= this.moduleRef.get(
        NOTIFICATIONS_SERVICE_TOKEN,
        { strict: false },
      ));
      if (!notifications) return;

      const profile = await this.prisma.profile.findUnique({
        where: { user_id: params.userId },
        select: { id: true },
      });
      if (!profile) return;

      const resolvedName = resolveEntityLabel(params.entity, params.newValues);
      const label = resolvedName || humanizeEntity(params.entity);
      const { title, body } = crudNotificationText(params.action, params.entity, label);

      await notifications.createNotification(params.churchId, profile.id, 'system', title, body, {
        entity: params.entity,
        entityId: params.entityId,
        action: params.action,
      });
    } catch (error) {
      this.logger.warn(
        `Failed to create CRUD notification for ${params.action} on ${params.entity}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Queries audit logs for a church with optional filters.
   */
  async query(
    churchId: string,
    filters?: {
      entity?: string;
      action?: AuditAction;
      userId?: string;
      startDate?: Date;
      endDate?: Date;
      limit?: number;
      offset?: number;
    },
  ): Promise<unknown[]> {
    const where: Record<string, unknown> = { church_id: churchId };

    if (filters?.entity) where.entity = filters.entity;
    if (filters?.action) where.action = filters.action;
    if (filters?.userId) where.user_id = filters.userId;

    if (filters?.startDate || filters?.endDate) {
      where.created_at = {
        ...(filters.startDate && { gte: filters.startDate }),
        ...(filters.endDate && { lte: filters.endDate }),
      };
    }

    return this.prisma.auditLog.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: filters?.limit || 100,
      skip: filters?.offset || 0,
    });
  }
}
