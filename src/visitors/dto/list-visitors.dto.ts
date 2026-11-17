import { QueryBoolean } from '../../common/decorators/query-boolean.decorator';
/**
 * @file list-visitors.dto.ts
 * @description DTO for listing and filtering visitors.
 *
 * @module visitors/dto/list-visitors.dto
 * @since 1.0.0
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { FOLLOW_UP_STATUSES } from './create-visitor.dto';

/**
 * DTO for listing visitors with pagination, filters, and sorting.
 */
export class ListVisitorsDto {
  @ApiPropertyOptional({ description: 'Page number', default: 1, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number;

  @ApiPropertyOptional({ description: 'Items per page', default: 20, minimum: 1, maximum: 200 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  @IsOptional()
  limit?: number;

  @ApiPropertyOptional({ description: 'Search first/last name, email, or phone' })
  @IsString()
  @IsOptional()
  search?: string;

  @ApiPropertyOptional({ description: 'Filter by follow-up status', enum: FOLLOW_UP_STATUSES })
  @IsOptional()
  @IsIn(FOLLOW_UP_STATUSES)
  followUpStatus?: string;

  @ApiPropertyOptional({ description: 'Filter by assigned profile ID' })
  @IsString()
  @IsOptional()
  assignedToId?: string;

  @ApiPropertyOptional({
    description: 'List archived visitors only (default: active only)',
    default: false,
  })
  @QueryBoolean()
  @IsBoolean()
  @IsOptional()
  archived?: boolean;

  @ApiPropertyOptional({
    description: 'Sort field',
    enum: ['firstName', 'lastName', 'createdAt', 'firstVisitDate', 'followUpStatus'],
  })
  @IsOptional()
  @IsIn(['firstName', 'lastName', 'createdAt', 'firstVisitDate', 'followUpStatus'])
  sortBy?: string;

  @ApiPropertyOptional({ description: 'Sort order', enum: ['asc', 'desc'], default: 'desc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc';
}
