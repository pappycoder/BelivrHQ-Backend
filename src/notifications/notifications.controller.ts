/**
 * @file notifications.controller.ts
 * @description HTTP endpoints for in-app notification management.
 *
 * @module notifications/notifications.controller
 * @since 1.0.0
 */

import {
  Controller,
  Get,
  Patch,
  Post,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiPaginatedResponse } from '../common/decorators/api-paginated.decorator';
import {
  ApiGetEndpoint,
  ApiUpdateEndpoint,
} from '../common/decorators/api-standard-responses.decorator';
import { NotificationsService } from './notifications.service';
import { NotificationResponseDto } from './dto/notification-response.dto';
import { BulkNotificationsDto } from './dto/bulk-notifications.dto';

@ApiTags('Notifications')
@ApiBearerAuth('supabase-auth')
@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  private getProfile(req: Record<string, unknown>): { church_id: string; id: string } {
    return req['profile'] as { church_id: string; id: string };
  }

  /**
   * List notifications for the current user.
   */
  @Get()
  @ApiPaginatedResponse(NotificationResponseDto)
  @ApiOperation({
    summary: 'List notifications',
    description: 'Lists notifications for the authenticated user with pagination.',
  })
  async listNotifications(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('type') type?: string,
    @Query('read') read?: 'all' | 'unread',
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Request() req?: Record<string, unknown>,
  ): Promise<{ data: NotificationResponseDto[]; total: number; unreadCount: number }> {
    const profile = req ? this.getProfile(req) : { church_id: '', id: '' };
    return this.notificationsService.listNotifications(
      profile.church_id,
      profile.id,
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 20,
      type,
      read,
      startDate,
      endDate,
    );
  }

  /**
   * Get unread notification count.
   */
  @Get('unread-count')
  @ApiGetEndpoint(
    'Get unread count',
    'Returns the count of unread notifications for the current user.',
  )
  @ApiOperation({
    summary: 'Get unread count',
    description: 'Returns the number of unread notifications.',
  })
  async getUnreadCount(@Request() req: Record<string, unknown>): Promise<{ count: number }> {
    const profile = this.getProfile(req);
    const count = await this.notificationsService.getUnreadCount(profile.church_id, profile.id);
    return { count };
  }

  /**
   * Mark multiple notifications as read (bulk).
   */
  @Patch('bulk-read')
  @ApiUpdateEndpoint(
    'Bulk mark as read',
    'Marks multiple notifications as read for the current user.',
  )
  async bulkMarkAsRead(
    @Body() dto: BulkNotificationsDto,
    @Request() req: Record<string, unknown>,
  ): Promise<{ updated: number }> {
    const profile = this.getProfile(req);
    return this.notificationsService.bulkMarkAsRead(profile.church_id, profile.id, dto.ids);
  }

  /**
   * Mark multiple notifications as unread (bulk).
   */
  @Patch('bulk-unread')
  @ApiUpdateEndpoint(
    'Bulk mark as unread',
    'Marks multiple read notifications as unread for the current user.',
  )
  async bulkMarkAsUnread(
    @Body() dto: BulkNotificationsDto,
    @Request() req: Record<string, unknown>,
  ): Promise<{ updated: number }> {
    const profile = this.getProfile(req);
    return this.notificationsService.bulkMarkAsUnread(profile.church_id, profile.id, dto.ids);
  }

  /**
   * Permanently delete multiple notifications (bulk hard delete).
   */
  @Post('bulk-delete')
  @HttpCode(HttpStatus.OK)
  @ApiUpdateEndpoint('Bulk delete', 'Permanently deletes multiple notifications.')
  async bulkRemove(
    @Body() dto: BulkNotificationsDto,
    @Request() req: Record<string, unknown>,
  ): Promise<{ deleted: number }> {
    const profile = this.getProfile(req);
    return this.notificationsService.bulkRemove(profile.church_id, profile.id, dto.ids);
  }

  /**
   * Get a single notification by ID (scoped to the current user).
   */
  @Get(':notificationId')
  @ApiGetEndpoint('Get notification', 'Returns a single notification for the current user.')
  async getOne(
    @Param('notificationId') notificationId: string,
    @Request() req: Record<string, unknown>,
  ): Promise<NotificationResponseDto> {
    const profile = this.getProfile(req);
    return this.notificationsService.getOne(notificationId, profile.church_id, profile.id);
  }

  /**
   * Mark a notification as read.
   */
  @Patch(':notificationId/read')
  @ApiUpdateEndpoint('Mark as read', 'Marks a single notification as read.')
  async markAsRead(
    @Param('notificationId') notificationId: string,
    @Request() req: Record<string, unknown>,
  ): Promise<NotificationResponseDto> {
    const profile = this.getProfile(req);
    return this.notificationsService.markAsRead(notificationId, profile.church_id, profile.id);
  }

  /**
   * Mark all notifications as read.
   */
  @Patch('read-all')
  @ApiUpdateEndpoint('Mark all as read', 'Marks all notifications as read for the current user.')
  async markAllAsRead(@Request() req: Record<string, unknown>): Promise<{ updated: number }> {
    const profile = this.getProfile(req);
    return this.notificationsService.markAllAsRead(profile.church_id, profile.id);
  }

  /**
   * Permanently delete a notification (hard delete).
   */
  @Delete(':notificationId')
  @HttpCode(HttpStatus.OK)
  @ApiUpdateEndpoint('Delete notification', 'Permanently deletes a notification.')
  async remove(
    @Param('notificationId') notificationId: string,
    @Request() req: Record<string, unknown>,
  ): Promise<{ success: boolean }> {
    const profile = this.getProfile(req);
    await this.notificationsService.remove(notificationId, profile.church_id, profile.id);
    return { success: true };
  }
}
