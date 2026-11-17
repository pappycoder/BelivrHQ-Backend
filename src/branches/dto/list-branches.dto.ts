import { QueryBoolean } from '../../common/decorators/query-boolean.decorator';
/**
 * @file DTO for listing branches with pagination and filtering.
 * @module ListBranchesDto
 * @description Data transfer object for paginated branch queries with search and sort options.
 * Supports searching by name, city, or address, and sorting by name, city, or created_at.
 * @since 1.0.0
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * DTO for listing branches with pagination, search, and sorting.
 */
export class ListBranchesDto {
  @ApiPropertyOptional({ description: 'Page number (default: 1)', example: 1, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number;

  @ApiPropertyOptional({
    description: 'Items per page (default: 20, max: 100)',
    example: 20,
    minimum: 1,
    maximum: 100,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  @IsOptional()
  limit?: number;

  @ApiPropertyOptional({
    description: 'Search term (matches name, city, address)',
    example: 'Lagos',
  })
  @IsString()
  @IsOptional()
  search?: string;

  @ApiPropertyOptional({ description: 'Field to sort by', enum: ['name', 'city', 'created_at'] })
  @IsEnum(['name', 'city', 'created_at'] as const)
  @IsOptional()
  sortBy?: 'name' | 'city' | 'created_at';

  @ApiPropertyOptional({ description: 'Sort order', enum: ['asc', 'desc'] })
  @IsEnum(['asc', 'desc'] as const)
  @IsOptional()
  sortOrder?: 'asc' | 'desc';

  @ApiPropertyOptional({
    description: 'List archived branches only (default: active only)',
    default: false,
  })
  @QueryBoolean()
  @IsBoolean()
  @IsOptional()
  archived?: boolean;
}
