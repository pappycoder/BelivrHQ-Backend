/**
 * @file analytics-date-range.dto.ts
 * @description Shared query DTOs for analytics endpoints.
 *
 * Provides date-range and branch filters used by analytics reports.
 *
 * @module analytics/dto/analytics-date-range.dto
 * @since 1.0.0
 */

import { ApiPropertyOptional, PickType } from '@nestjs/swagger';
import { Matches, IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';

/**
 * Base query DTO for analytics date ranges and branch filtering.
 */
export class AnalyticsDateRangeDto {
  @ApiPropertyOptional({ description: 'Start date (ISO string)', example: '2026-07-01' })
  @IsString()
  @IsOptional()
  startDate?: string;

  @ApiPropertyOptional({ description: 'End date (ISO string)', example: '2026-07-31' })
  @IsString()
  @IsOptional()
  endDate?: string;

  @ApiPropertyOptional({ description: 'Filter by branch ID' })
  @IsUUID()
  @IsOptional()
  branchId?: string;
}

/** Optional branch selection; member demographics remain current snapshots. */
export class MemberAnalyticsQueryDto extends PickType(AnalyticsDateRangeDto, [
  'branchId',
] as const) {}

/** Query DTO for analytics trend endpoints that support grouping. */
export class AnalyticsTrendQueryDto extends AnalyticsDateRangeDto {
  @ApiPropertyOptional({
    description: 'Giving currency; filters values without conversion',
    example: 'NGN',
  })
  @IsOptional()
  @Matches(/^[A-Z]{3}$/)
  currency?: string;

  @ApiPropertyOptional({
    description: 'Group trend data by day, week, or month',
    enum: ['day', 'week', 'month'],
    default: 'day',
  })
  @IsEnum(['day', 'week', 'month'] as const)
  @IsOptional()
  groupBy?: 'day' | 'week' | 'month';
}
