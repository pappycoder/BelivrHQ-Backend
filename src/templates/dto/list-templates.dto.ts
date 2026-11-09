/**
 * @file list-templates.dto.ts
 * @description DTO for listing message templates with pagination and filters.
 *
 * Supports filtering by channel (whatsapp, sms, email) and status (draft, published, archived).
 *
 * @module templates/dto/list-templates.dto
 * @since 1.0.0
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsIn, IsInt, Min, Max, IsBoolean, IsUUID } from 'class-validator';
import { Type } from 'class-transformer';

export class ListTemplatesDto {
  @ApiPropertyOptional({ description: 'Filter templates by branch' })
  @IsUUID()
  @IsOptional()
  branchId?: string;

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
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({ enum: ['whatsapp', 'sms', 'email'] })
  @IsOptional()
  @IsString()
  @IsIn(['whatsapp', 'sms', 'email'])
  channel?: string;

  @ApiPropertyOptional({ enum: ['draft', 'published', 'archived'] })
  @IsOptional()
  @IsString()
  @IsIn(['draft', 'published', 'archived'])
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    description: 'List archived templates only (default: active only)',
    default: false,
  })
  @Type(() => Boolean)
  @IsOptional()
  @IsBoolean()
  archived?: boolean;
  @ApiPropertyOptional({
    enum: ['name', 'createdAt', 'updatedAt', 'channel', 'status'],
    default: 'name',
  })
  @IsOptional()
  @IsIn(['name', 'createdAt', 'updatedAt', 'channel', 'status'])
  sortBy?: 'name' | 'createdAt' | 'updatedAt' | 'channel' | 'status';

  @ApiPropertyOptional({ enum: ['asc', 'desc'] })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc';
}
