/**
 * @file notifications.service.ts
 * @description Service for in-app notification management.
 *
 * Handles notification creation, listing, read status, and preferences.
 * Notifications are church-scoped and profile-scoped.
 *
 * @module notifications/notifications.service
 * @since 1.0.0
 */

import { Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmailDeliveryService } from '../communication/email-delivery.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { NotificationResponseDto } from './dto/notification-response.dto';
import { Prisma } from '@prisma/client';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly resendService?: EmailDeliveryService,
    private readonly whatsappService?: WhatsAppService,
  ) {}

  /**
   * List notifications for a profile with pagination.
   */
  async listNotifications(
    churchId: string,
    profileId: string,
    page = 1,
    limit = 20,
    type?: string,
    read?: 'all' | 'unread',
    startDate?: string,
    endDate?: string,
  ): Promise<{ data: NotificationResponseDto[]; total: number; unreadCount: number }> {
    const skip = (page - 1) * limit;

    const where: Prisma.NotificationWhereInput = {
      church_id: churchId,
      profile_id: profileId,
    };

    if (type) {
      where.type = type;
    }

    if (read === 'unread') {
      where.read_at = null;
    }

    const createdAt: Prisma.DateTimeFilter | undefined = {};
    if (startDate) {
      createdAt.gte = new Date(`${startDate}T00:00:00.000Z`);
    }
    if (endDate) {
      createdAt.lte = new Date(`${endDate}T23:59:59.999Z`);
    }
    if (startDate || endDate) {
      where.created_at = createdAt;
    }

    const notifications = await this.prisma.notification.findMany({
      where,
      orderBy: { created_at: 'desc' },
      skip,
      take: limit,
    });
    const total = await this.prisma.notification.count({ where });
    const unreadCount = await this.prisma.notification.count({
      where: { ...where, read_at: null },
    });

    return {
      data: notifications.map((n) => this.mapNotificationToDto(n)),
      total,
      unreadCount,
    };
  }

  /**
   * Get unread notification count for a profile.
   */
  async getUnreadCount(churchId: string, profileId: string): Promise<number> {
    return this.prisma.notification.count({
      where: {
        church_id: churchId,
        profile_id: profileId,
        read_at: null,
      },
    });
  }

  /**
   * Mark a single notification as read.
   */
  async markAsRead(
    notificationId: string,
    churchId: string,
    profileId: string,
  ): Promise<NotificationResponseDto> {
    const notification = await this.prisma.notification.findFirst({
      where: {
        id: notificationId,
        church_id: churchId,
        profile_id: profileId,
      },
    });

    if (!notification) {
      throw new NotFoundException('Notification not found');
    }

    const updated = await this.prisma.notification.update({
      where: { id: notificationId },
      data: { read_at: new Date() },
    });

    return this.mapNotificationToDto(updated);
  }

  /**
   * Mark all notifications as read for a profile.
   */
  async markAllAsRead(churchId: string, profileId: string): Promise<{ updated: number }> {
    const result = await this.prisma.notification.updateMany({
      where: {
        church_id: churchId,
        profile_id: profileId,
        read_at: null,
      },
      data: { read_at: new Date() },
    });

    this.logger.log(`Marked ${result.count} notifications as read for profile ${profileId}`);

    return { updated: result.count };
  }

  /**
   * Mark multiple notifications as read (bulk), scoped to a profile.
   */
  async bulkMarkAsRead(
    churchId: string,
    profileId: string,
    ids: string[],
  ): Promise<{ updated: number }> {
    const result = await this.prisma.notification.updateMany({
      where: {
        id: { in: ids },
        church_id: churchId,
        profile_id: profileId,
        read_at: null,
      },
      data: { read_at: new Date() },
    });

    this.logger.log(`Bulk marked ${result.count} notifications as read for profile ${profileId}`);
    return { updated: result.count };
  }

  /**
   * Mark multiple notifications as unread (bulk), scoped to a profile.
   * The inverse of `bulkMarkAsRead` — only rows that were actually read flip.
   */
  async bulkMarkAsUnread(
    churchId: string,
    profileId: string,
    ids: string[],
  ): Promise<{ updated: number }> {
    const result = await this.prisma.notification.updateMany({
      where: {
        id: { in: ids },
        church_id: churchId,
        profile_id: profileId,
        read_at: { not: null },
      },
      data: { read_at: null },
    });

    this.logger.log(`Bulk marked ${result.count} notifications as unread for profile ${profileId}`);
    return { updated: result.count };
  }

  /**
   * Permanently delete multiple notifications (bulk hard delete), scoped to a profile.
   */
  async bulkRemove(
    churchId: string,
    profileId: string,
    ids: string[],
  ): Promise<{ deleted: number }> {
    const result = await this.prisma.notification.deleteMany({
      where: {
        id: { in: ids },
        church_id: churchId,
        profile_id: profileId,
      },
    });

    this.logger.log(`Bulk deleted ${result.count} notifications for profile ${profileId}`);
    return { deleted: result.count };
  }

  /**
   * Get a single notification scoped to a profile.
   */
  async getOne(
    notificationId: string,
    churchId: string,
    profileId: string,
  ): Promise<NotificationResponseDto> {
    const notification = await this.prisma.notification.findFirst({
      where: {
        id: notificationId,
        church_id: churchId,
        profile_id: profileId,
      },
    });

    if (!notification) {
      throw new NotFoundException('Notification not found');
    }

    return this.mapNotificationToDto(notification);
  }

  /**
   * Permanently delete a notification scoped to a profile (hard delete).
   */
  async remove(notificationId: string, churchId: string, profileId: string): Promise<void> {
    const notification = await this.prisma.notification.findFirst({
      where: {
        id: notificationId,
        church_id: churchId,
        profile_id: profileId,
      },
    });

    if (!notification) {
      throw new NotFoundException('Notification not found');
    }

    await this.prisma.notification.delete({ where: { id: notificationId } });
    this.logger.log(`Notification ${notificationId} deleted for profile ${profileId}`);
  }

  /**
   * Create a notification (internal use by other services).
   */
  async createNotification(
    churchId: string,
    profileId: string,
    type: string,
    title: string,
    body: string,
    data?: Record<string, unknown>,
  ): Promise<NotificationResponseDto> {
    const notification = await this.prisma.notification.create({
      data: {
        church_id: churchId,
        profile_id: profileId,
        type,
        title,
        body,
        data: data as Prisma.InputJsonValue,
      },
    });

    return this.mapNotificationToDto(notification);
  }

  /**
   * Send notifications to all profiles in a church (broadcast).
   */
  async broadcastToChurch(
    churchId: string,
    type: string,
    title: string,
    body: string,
    data?: Record<string, unknown>,
  ): Promise<{ sent: number }> {
    const profiles = await this.prisma.profile.findMany({
      where: { church_id: churchId },
      select: { id: true },
    });

    let sent = 0;

    for (const profile of profiles) {
      try {
        await this.prisma.notification.create({
          data: {
            church_id: churchId,
            profile_id: profile.id,
            type,
            title,
            body,
            data: data as Prisma.InputJsonValue,
          },
        });
        sent++;
      } catch (err) {
        this.logger.warn(
          `Failed to send notification to profile ${profile.id}: ${(err as Error).message}`,
        );
      }
    }

    this.logger.log(
      `Broadcast notification to ${sent}/${profiles.length} profiles in church ${churchId}`,
    );

    return { sent };
  }

  /**
   * Sends a document via WhatsApp.
   *
   * Currently creates an in-app notification. Full WhatsApp document
   * sending will be implemented when the WhatsApp media upload API is integrated.
   */
  async sendWhatsAppWithDocument(
    phone: string,
    _buffer: Buffer,
    _filename: string,
    caption: string,
    churchId: string,
  ): Promise<void> {
    this.logger.log(`WhatsApp document to ${phone}: ${caption} (church: ${churchId})`);

    const profiles = await this.prisma.profile.findMany({
      where: { church_id: churchId, phone },
      select: { id: true },
    });

    if (this.whatsappService) {
      try {
        await this.whatsappService.sendMessage(phone, `${caption}\n\nFile: ${_filename}`, churchId);
      } catch (err) {
        this.logger.warn(`WhatsApp delivery failed: ${(err as Error).message}`);
      }
    }

    for (const profile of profiles) {
      await this.prisma.notification.create({
        data: {
          church_id: churchId,
          profile_id: profile.id,
          type: 'receipt',
          title: 'Receipt Sent',
          body: caption,
        },
      });
    }
  }

  /**
   * Sends an email with attachment.
   *
   * Delivers through the church email account and records a notification after acceptance.
   */
  async sendEmailWithAttachment(
    email: string,
    subject: string,
    body: string,
    buffer: Buffer,
    filename: string,
    churchId: string,
    text?: string,
  ): Promise<void> {
    this.logger.log(`Email with attachment to ${email}: ${subject} (church: ${churchId})`);

    const members = await this.prisma.member.findMany({
      where: { church_id: churchId, email },
      select: { id: true },
    });

    const memberIds = members.map((m) => m.id);

    if (!this.resendService)
      throw new ServiceUnavailableException('Email receipt delivery is not configured');
    try {
      const attachment = { filename, content: buffer };
      if (text)
        await this.resendService.sendEmail(email, subject, body, churchId, attachment, { text });
      else await this.resendService.sendEmail(email, subject, body, churchId, attachment);
    } catch {
      this.logger.warn('Receipt email delivery was not accepted');
      throw new ServiceUnavailableException('Receipt email could not be delivered. Please retry.');
    }

    if (memberIds.length === 0) return;

    const profiles = await this.prisma.profile.findMany({
      where: { church_id: churchId, member_id: { in: memberIds } },
      select: { id: true },
    });

    for (const profile of profiles) {
      await this.prisma.notification.create({
        data: {
          church_id: churchId,
          profile_id: profile.id,
          type: 'receipt',
          title: 'Receipt Sent',
          body: subject,
        },
      });
    }
  }

  private mapNotificationToDto(
    notification: Record<string, unknown> & { id: string; created_at: Date },
  ): NotificationResponseDto {
    return {
      id: notification.id,
      churchId: notification.church_id as string,
      profileId: notification.profile_id as string,
      type: notification.type as string,
      title: notification.title as string,
      body: notification.body as string,
      data: (notification.data as Record<string, unknown>) || undefined,
      readAt: notification.read_at ? (notification.read_at as Date).toISOString() : undefined,
      createdAt: notification.created_at.toISOString(),
    };
  }
}
