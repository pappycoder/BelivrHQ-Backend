import { QueryBoolean } from '../../common/decorators/query-boolean.decorator';
/**
 * @file list-life-events.dto.ts
 * @description DTO for listing life events with filters.
 *
 * @module pastoral/dto/list-life-events.dto
 * @since 1.0.0
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsInt, Min, Max, IsIn, IsBoolean } from 'class-validator';

export class ListLifeEventsDto {
  // Default page number starting at 1
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  // Page size capped between 1 and 100
  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  // Optional member ID filter
  @ApiPropertyOptional({ description: 'Filter by member ID' })
  @IsOptional()
  @IsString()
  memberId?: string;

  // Optional event type filter
  @ApiPropertyOptional({
    description: 'Filter by event type',
    enum: ['birthday', 'wedding', 'death', 'dedication', 'baptism', 'anniversary', 'other'],
  })
  @IsOptional()
  @IsString()
  type?: string;

  // Optional upcoming filter (date >= today)
  @ApiPropertyOptional({
    description: 'Filter upcoming events (date >= today)',
  })
  @IsOptional()
  @IsIn(['true', 'false'])
  upcoming?: string;

  // Sort field defaults to date
  @ApiPropertyOptional({
    description: 'Sort by field',
    enum: ['date', 'created_at'],
    default: 'date',
  })
  @IsOptional()
  @IsString()
  sortBy?: string;

  // Sort direction defaults to ascending
  @ApiPropertyOptional({
    description: 'Sort direction',
    enum: ['asc', 'desc'],
    default: 'asc',
  })
  @IsOptional()
  @IsString()
  sortOrder?: 'asc' | 'desc';

  // List archived events only when true (default: active only)
  @ApiPropertyOptional({
    description: 'List archived records only (default: active only)',
    default: false,
  })
  @QueryBoolean()
  @IsOptional()
  @IsBoolean()
  archived?: boolean;
}
