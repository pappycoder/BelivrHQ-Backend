import { QueryBoolean } from '../../common/decorators/query-boolean.decorator';
/**
 * @file DTO for listing giving categories.
 * @module giving/dto/list-categories.dto
 * @since 1.0.0
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { Transform, Type } from 'class-transformer';

export class ListCategoriesDto {
  @ApiPropertyOptional({
    description: 'Deprecated: categories are shared across the church; this value is ignored',
    deprecated: true,
  })
  @IsUUID()
  @IsOptional()
  branchId?: string;

  @ApiPropertyOptional({ description: 'Page number (applies when limit is provided)', default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number;

  @ApiPropertyOptional({ description: 'Items per page (omit to return all categories)' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit?: number;

  @ApiPropertyOptional({ description: 'Filter by active status', example: true })
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @ApiPropertyOptional({
    description: 'List archived records only (default: active only)',
    default: false,
  })
  @QueryBoolean()
  @IsOptional()
  @IsBoolean()
  archived?: boolean;
}
