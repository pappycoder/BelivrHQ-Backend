/**
 * @file list-services.dto.ts
 * @description DTO for listing and filtering church services.
 *
 * @module attendance/dto/list-services.dto
 * @since 1.0.0
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { SERVICE_CATEGORIES } from './create-service.dto';

/**
 * DTO for listing services with pagination, filters, and sorting.
 */
export class ListServicesDto {
  @ApiPropertyOptional({ description: 'Case-insensitive search', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({ description: 'Page number', default: 1, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number;

  @ApiPropertyOptional({ description: 'Items per page', default: 20, minimum: 1, maximum: 100 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit?: number;

  @ApiPropertyOptional({ description: 'Filter by branch ID' })
  @IsString()
  @IsOptional()
  branchId?: string;

  @ApiPropertyOptional({ description: 'Filter by category', enum: SERVICE_CATEGORIES })
  @IsOptional()
  @IsIn(SERVICE_CATEGORIES)
  category?: string;

  @ApiPropertyOptional({ description: 'Filter by active status' })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @ApiPropertyOptional({
    description: 'Filter by day of week (0=Sunday, 6=Saturday)',
    minimum: 0,
    maximum: 6,
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(6)
  @IsOptional()
  dayOfWeek?: number;

  @ApiPropertyOptional({ description: 'Sort field', enum: ['name', 'day_of_week', 'created_at'] })
  @IsString()
  @IsOptional()
  sortBy?: string;

  @ApiPropertyOptional({ description: 'Sort order', enum: ['asc', 'desc'], default: 'asc' })
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
