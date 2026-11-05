/**
 * @file DTO for listing sermons with filters and pagination.
 * @module sermons/dto/list-sermons.dto
 * @since 1.0.0
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ListSermonsDto {
  @ApiPropertyOptional({ description: 'Filter sermons by branch' })
  @IsUUID()
  @IsOptional()
  branchId?: string;

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

  @ApiPropertyOptional({ description: 'Search by title, speaker, or scripture' })
  @IsString()
  @IsOptional()
  search?: string;

  @ApiPropertyOptional({ description: 'Filter by speaker' })
  @IsString()
  @IsOptional()
  speaker?: string;

  @ApiPropertyOptional({ description: 'Filter by series name' })
  @IsString()
  @IsOptional()
  series?: string;

  @ApiPropertyOptional({ description: 'Filter by tag' })
  @IsString()
  @IsOptional()
  tag?: string;

  @ApiPropertyOptional({ description: 'Start date range (ISO string)' })
  @IsDateString()
  @IsOptional()
  startDate?: string;

  @ApiPropertyOptional({ description: 'End date range (ISO string)' })
  @IsDateString()
  @IsOptional()
  endDate?: string;

  @ApiPropertyOptional({
    description: 'Sort field',
    default: 'sermon_date',
    enum: ['sermon_date', 'created_at', 'title'],
  })
  @IsString()
  @IsOptional()
  sortBy?: string;

  @ApiPropertyOptional({ description: 'Sort order', default: 'desc', enum: ['asc', 'desc'] })
  @IsString()
  @IsOptional()
  sortOrder?: 'asc' | 'desc';

  @ApiPropertyOptional({
    description: 'List archived records only (default: active only)',
    default: false,
  })
  @Type(() => Boolean)
  @IsOptional()
  @IsBoolean()
  archived?: boolean;
}
