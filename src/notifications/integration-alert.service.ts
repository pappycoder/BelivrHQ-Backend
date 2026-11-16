import { errorDiagnostic } from '../common/privacy';
/**
 * @file integration-alert.service.ts
 * @description Fault-tolerance alerting for external integrations.
 *
 * When a third-party integration (Resend, Termii, Paystack, Flutterwave)
 * fails, an operator should be notified without the notification itself ever
 * crashing or blocking the underlying request. This service raises in-app
 * "system" alerts to the church super_admins + church_admins (the bell).
 *
 * Alerting is intentionally fire-and-forget: every path is wrapped in
 * try/catch (and any resolved notification failures are swallowed), so an
 * alert can never propagate an error back into the caller. If a request is
 * already failing due to an unavailable gateway, the last thing we want is
 * the alert mechanism itself failing the request again.
 *
 * @module notifications/integration-alert.service
 * @since 1.0.0
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from './notifications.service';

const ADMIN_ROLES = ['super_admin', 'church_admin'];

@Injectable()
export class IntegrationAlertService {
  private readonly logger = new Logger(IntegrationAlertService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Raises an in-app "system" alert to a church's super_admins and
   * church_admins notifying them that an external integration failed.
   *
   * Never throws: any failure to query admins or create a notification is
   * logged and swallowed so the caller is unaffected.
   *
   * @param churchId - Church whose admins should be notified
   * @param integration - Integration name, e.g. 'resend' | 'termii' | 'paystack' | 'flutterwave'
   * @param title - Short alert title
   * @param message - Longer human-readable message
   * @param data - Optional extra context (eg. transaction reference)
   */
  async notify(
    churchId: string,
    integration: string,
    title: string,
    message: string,
    data?: Record<string, unknown>,
  ): Promise<void> {
    if (!churchId) return;

    try {
      const profiles = await this.prisma.profile.findMany({
        where: {
          church_id: churchId,
          role: { hasSome: ADMIN_ROLES },
        },
        select: { id: true },
      });

      if (profiles.length === 0) {
        this.logger.warn(
          `Integration alert for ${integration}: no super_admin/church_admin in church ${churchId}`,
        );
        return;
      }

      const payload = { integration, ...(data ?? {}) };
      await Promise.all(
        profiles.map((profile) =>
          this.notifications
            .createNotification(churchId, profile.id, 'system', title, message, payload)
            .catch((err) =>
              this.logger.warn(
                `Failed to send integration alert to ${profile.id}: ${this.msg(err)}`,
              ),
            ),
        ),
      );
    } catch (err) {
      this.logger.error(
        `Integration alert failed for ${integration} in church ${churchId}: ${this.msg(err)}`,
      );
    }
  }

  private msg(err: unknown): string {
    return errorDiagnostic(err);
  }
}
