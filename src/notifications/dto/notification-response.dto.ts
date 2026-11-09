/**
 * @file notification-response.dto.ts
 * @description DTOs for notification responses.
 *
 * @module notifications/dto/notification-response.dto
 * @since 1.0.0
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class NotificationResponseDto {
  @ApiProperty({
    description: 'Notification ID (UUID)',
    example: '55555555-5555-5555-5555-555555555555',
  })
  id!: string;

  @ApiProperty({
    description: 'Church ID',
    example: '00000000-0000-0000-0000-000000000001',
  })
  churchId!: string;

  @ApiProperty({
    description: 'Profile ID of the recipient',
    example: '22222222-2222-2222-2222-222222222222',
  })
  profileId!: string;

  @ApiProperty({
    description: 'Notification type',
    enum: ['system', 'attendance', 'giving', 'event', 'pastoral', 'broadcast'],
    example: 'system',
  })
  type!: string;

  @ApiProperty({
    description: 'Notification title',
    example: 'Welcome to BelivrHQ',
  })
  title!: string;

  @ApiProperty({
    description: 'Notification body',
    example: 'Your account has been created successfully.',
  })
  body!: string;

  @ApiPropertyOptional({
    description: 'Additional data payload',
    example: { memberId: '44444444-4444-4444-4444-444444444444' },
  })
  data?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Read timestamp (null if unread)',
    example: '2026-07-22T10:00:00.000Z',
  })
  readAt?: string;

  @ApiProperty({
    description: 'Creation timestamp',
    example: '2026-07-22T08:00:00.000Z',
  })
  createdAt!: string;
}

export class NotificationListResponseDto {
  @ApiProperty({ type: [NotificationResponseDto] })
  data!: NotificationResponseDto[];

  @ApiProperty({ description: 'Total notification count', example: 25 })
  total!: number;

  @ApiProperty({ description: 'Unread notification count', example: 8 })
  unreadCount!: number;
}
