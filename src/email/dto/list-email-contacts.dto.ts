import { QueryBoolean } from '../../common/decorators/query-boolean.decorator';
/**
 * @file list-email-contacts.dto.ts
 * @description DTO for listing email recipient contacts with filters.
 *
 * @module email/dto/list-email-contacts.dto
 * @since 1.0.0
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * DTO for listing selectable recipient contacts.
 * Recipients are profiles with an eligible staff role in the same church,
 * optionally filtered by branch, role, or a search term (name / email).
 */
export class ListEmailContactsDto {
  @ApiPropertyOptional({ description: 'Page number', default: 1, example: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number;

  @ApiPropertyOptional({ description: 'Items per page', default: 50, example: 50 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  @IsOptional()
  limit?: number;

  @ApiPropertyOptional({
    description: 'Search by first name, last name, or email',
    example: 'Pastor',
  })
  @IsString()
  @IsOptional()
  search?: string;

  @ApiPropertyOptional({
    description: 'Filter by branch ID',
    example: '11111111-1111-1111-1111-111111111111',
  })
  @IsString()
  @IsOptional()
  branchId?: string;

  @ApiPropertyOptional({
    description: 'Filter by exact role',
    example: 'branch_pastor',
  })
  @IsString()
  @IsOptional()
  role?: string;

  @ApiPropertyOptional({
    description: 'Include the requesting user in results (defaults to false)',
    example: false,
  })
  @QueryBoolean()
  @IsBoolean()
  @IsOptional()
  includeSelf?: boolean;
}
