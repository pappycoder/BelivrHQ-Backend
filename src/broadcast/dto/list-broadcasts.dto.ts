/**
 * @file list-broadcasts.dto.ts
 * @description DTO for listing broadcasts with pagination and filters.
 *
 * @module broadcast/dto/list-broadcasts.dto
 * @since 1.0.0
 */

import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsUUID, IsOptional, IsString, IsIn, IsInt, Min, Max } from 'class-validator';

export class ListBroadcastsDto {
  @ApiPropertyOptional({ description: 'Filter by audience branch' })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ enum: ['draft', 'scheduled', 'sending', 'sent', 'cancelled', 'failed'] })
  @IsOptional()
  @IsString()
  @IsIn(['draft', 'scheduled', 'sending', 'sent', 'cancelled', 'failed'])
  status?: string;

  @ApiPropertyOptional({ enum: ['whatsapp', 'sms', 'email'] })
  @IsOptional()
  @IsString()
  @IsIn(['whatsapp', 'sms', 'email'])
  channel?: string;
  @ApiPropertyOptional({
    enum: ['name', 'createdAt', 'scheduledAt', 'sentAt', 'totalRecipients', 'channel', 'status'],
    default: 'createdAt',
  })
  @IsOptional()
  @IsIn(['name', 'createdAt', 'scheduledAt', 'sentAt', 'totalRecipients', 'channel', 'status'])
  sortBy?:
    'name' | 'createdAt' | 'scheduledAt' | 'sentAt' | 'totalRecipients' | 'channel' | 'status';

  @ApiPropertyOptional({ enum: ['asc', 'desc'] })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc';
}
