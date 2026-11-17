import { QueryBoolean } from '../../common/decorators/query-boolean.decorator';
/**
 * @file list-members.dto.ts
 * @description DTO for listing members with pagination, search, and filters.
 *
 * Query parameters for the GET /members endpoint. All fields are optional
 * with sensible defaults applied in the service layer.
 *
 * @module members/dto/list-members
 * @since 1.0.0
 */

import { IsEnum, IsOptional, IsString, IsInt, Min, Max, IsBoolean } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class ListMembersDto {
  @ApiPropertyOptional({
    description: 'Page number (default: 1)',
    example: 1,
    minimum: 1,
  })
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
  @Max(100)
  @IsOptional()
  limit?: number;

  @ApiPropertyOptional({
    description: 'Search term for full-text search (matches name, email, phone)',
    example: 'Chioma',
  })
  @IsString()
  @IsOptional()
  search?: string;

  @ApiPropertyOptional({
    description: 'Filter by member status',
    enum: ['active', 'inactive', 'suspended', 'transferred'],
    example: 'active',
  })
  @IsEnum(['active', 'inactive', 'suspended', 'transferred'] as const)
  @IsOptional()
  status?: 'active' | 'inactive' | 'suspended' | 'transferred';

  @ApiPropertyOptional({
    description: 'Filter by branch ID',
    example: '33333333-3333-3333-3333-333333333333',
  })
  @IsString()
  @IsOptional()
  branchId?: string;

  @ApiPropertyOptional({
    description: 'Field to sort by',
    enum: ['first_name', 'last_name', 'created_at', 'member_since', 'status'],
    example: 'created_at',
  })
  @IsEnum(['first_name', 'last_name', 'created_at', 'member_since', 'status'] as const)
  @IsOptional()
  sortBy?: 'first_name' | 'last_name' | 'created_at' | 'member_since' | 'status';

  @ApiPropertyOptional({
    description: 'Sort order',
    enum: ['asc', 'desc'],
    example: 'desc',
  })
  @IsEnum(['asc', 'desc'] as const)
  @IsOptional()
  sortOrder?: 'asc' | 'desc';

  @ApiPropertyOptional({
    description: 'List archived records only (default: active only)',
    default: false,
  })
  @QueryBoolean()
  @IsOptional()
  @IsBoolean()
  archived?: boolean;
}
