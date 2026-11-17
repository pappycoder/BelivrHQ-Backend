import { QueryBoolean } from '../../common/decorators/query-boolean.decorator';
/**
 * @file DTO for listing profiles with filters.
 * @module profile/dto/list-profiles.dto
 * @description Query parameter DTO for paginated profile listing with role and branch filters.
 * @since 1.0.0
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min, IsBoolean } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * DTO for profile listing query parameters.
 * Supports pagination, search, and filters by role and branch.
 */
export class ListProfilesDto {
  @ApiPropertyOptional({ description: 'Page number', default: 1, example: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number;

  @ApiPropertyOptional({ description: 'Items per page', default: 20, example: 20 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit?: number;

  @ApiPropertyOptional({
    description: 'Search by first name, last name, or phone',
    example: 'Adebayo',
  })
  @IsString()
  @IsOptional()
  search?: string;

  @ApiPropertyOptional({
    description: 'Filter by role',
    example: 'church_admin',
    enum: [
      'super_admin',
      'senior_pastor',
      'church_admin',
      'branch_pastor',
      'department_head',
      'secretary',
      'treasurer',
      'usher',
      'cell_leader',
    ],
  })
  @IsString()
  @IsOptional()
  role?: string;

  @ApiPropertyOptional({
    description: 'Filter by branch ID',
    example: '33333333-3333-3333-3333-333333333333',
  })
  @IsString()
  @IsOptional()
  branchId?: string;

  @ApiPropertyOptional({
    description: 'Filter by account status',
    example: 'active',
    enum: ['active', 'inactive'],
  })
  @IsEnum(['active', 'inactive'] as const)
  @IsOptional()
  status?: 'active' | 'inactive';

  @ApiPropertyOptional({
    description: 'Sort field',
    default: 'created_at',
    enum: ['first_name', 'last_name', 'role', 'created_at'],
  })
  @IsEnum(['first_name', 'last_name', 'role', 'created_at'] as const)
  @IsOptional()
  sortBy?: 'first_name' | 'last_name' | 'role' | 'created_at';

  @ApiPropertyOptional({
    description: 'Sort order',
    default: 'desc',
    enum: ['asc', 'desc'],
  })
  @IsEnum(['asc', 'desc'] as const)
  @IsOptional()
  sortOrder?: 'asc' | 'desc';

  @ApiPropertyOptional({
    description: 'List archived profiles only (default: active only)',
    default: false,
  })
  @QueryBoolean()
  @IsOptional()
  @IsBoolean()
  archived?: boolean;
}
