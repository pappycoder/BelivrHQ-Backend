import { QueryBoolean } from '../../common/decorators/query-boolean.decorator';
/**
 * @file DTO for listing events with filters and pagination.
 * @module events/dto/list-events.dto
 * @since 1.0.0
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ListEventsDto {
  @ApiPropertyOptional({ description: 'Page number', default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number;

  @ApiPropertyOptional({ description: 'Items per page', default: 20 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit?: number;

  @ApiPropertyOptional({ description: 'Filter by branch ID' })
  @IsUUID()
  @IsOptional()
  branchId?: string;

  @ApiPropertyOptional({
    description: 'Filter by event type',
    enum: ['service', 'conference', 'lifecycle', 'training', 'social'],
  })
  @IsEnum(['service', 'conference', 'lifecycle', 'training', 'social'] as const)
  @IsOptional()
  type?: string;

  @ApiPropertyOptional({
    description: 'Filter by upcoming/past/all',
    enum: ['upcoming', 'past', 'all'],
    default: 'upcoming',
  })
  @IsEnum(['upcoming', 'past', 'all'] as const)
  @IsOptional()
  dateFilter?: string;

  @ApiPropertyOptional({
    description: 'Filter by status (alias for dateFilter)',
    enum: ['upcoming', 'past', 'all'],
  })
  @IsEnum(['upcoming', 'past', 'all'] as const)
  @IsOptional()
  status?: string;

  @ApiPropertyOptional({ description: 'Start date range (ISO string)' })
  @IsDateString()
  @IsOptional()
  startDate?: string;

  @ApiPropertyOptional({ description: 'End date range (ISO string)' })
  @IsDateString()
  @IsOptional()
  endDate?: string;

  @ApiPropertyOptional({ description: 'Search by title or description' })
  @IsString()
  @IsOptional()
  search?: string;

  @ApiPropertyOptional({
    description: 'List archived events only (default: active only)',
    default: false,
  })
  @QueryBoolean()
  @IsBoolean()
  @IsOptional()
  archived?: boolean;

  @ApiPropertyOptional({
    description: 'Sort field',
    default: 'startDate',
    enum: ['start_date', 'created_at', 'title', 'startDate', 'createdAt'],
  })
  @IsEnum(['start_date', 'created_at', 'title', 'startDate', 'createdAt'] as const)
  @IsOptional()
  sortBy?: string;

  @ApiPropertyOptional({ description: 'Sort order', default: 'asc', enum: ['asc', 'desc'] })
  @IsEnum(['asc', 'desc'] as const)
  @IsOptional()
  sortOrder?: 'asc' | 'desc';
}
