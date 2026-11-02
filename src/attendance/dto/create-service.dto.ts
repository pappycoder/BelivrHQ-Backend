/**
 * @file create-service.dto.ts
 * @description DTO for creating a new church service.
 *
 * @module attendance/dto/create-service.dto
 * @since 1.0.0
 */

import { SERVICE_TIME_PATTERN } from '../service-time';
import { SCHEDULE_RECURRENCES } from '../schedule-occurrence';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';

/** Check-in audience categories a service can target. */
export const SERVICE_CATEGORIES = ['adult', 'children', 'mixed'] as const;
export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number];

/** Recurrence modes for a service schedule (re-exported for Swagger docs). */
export { SCHEDULE_RECURRENCES };

/**
 * DTO for creating a new church service schedule.
 */
export class CreateServiceDto {
  @ApiProperty({ description: 'Service name', example: 'Sunday Service' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional({
    description: 'Branch ID (null for church-wide)',
    example: '33333333-0000-0000-0000-000000000000',
  })
  @IsString()
  @IsOptional()
  branchId?: string;

  @ApiPropertyOptional({
    description: 'Check-in category this service targets (defaults to adult)',
    enum: SERVICE_CATEGORIES,
    default: 'adult',
  })
  @IsOptional()
  @IsIn(SERVICE_CATEGORIES)
  category?: ServiceCategory;

  @ApiPropertyOptional({
    description: 'Day of week (0=Sunday, 6=Saturday)',
    example: 0,
    minimum: 0,
    maximum: 6,
  })
  @IsInt()
  @Min(0)
  @Max(6)
  @IsOptional()
  dayOfWeek?: number | null;

  @ApiPropertyOptional({
    description:
      'How the schedule repeats: weekly (default), one_time (starts_on only) or multi_day (starts_on…ends_on)',
    enum: SCHEDULE_RECURRENCES,
    default: 'weekly',
  })
  @IsOptional()
  @IsIn(SCHEDULE_RECURRENCES)
  recurrence?: string;

  @ApiPropertyOptional({
    description: 'First valid day (YYYY-MM-DD); required for one_time and multi_day',
    example: '2026-11-01',
  })
  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  startsOn?: string | null;

  @ApiPropertyOptional({
    description: 'Last valid day (YYYY-MM-DD); required for multi_day',
    example: '2026-11-07',
  })
  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  endsOn?: string | null;

  @ApiPropertyOptional({
    description: 'Local start time (24-hour HH:mm)',
    example: '09:00',
  })
  @IsOptional()
  @IsString()
  @Matches(SERVICE_TIME_PATTERN, { message: 'startTime must use 24-hour HH:mm format' })
  startTime?: string | null;

  @ApiPropertyOptional({ description: 'Local end time (24-hour HH:mm)', example: '11:00' })
  @IsOptional()
  @IsString()
  @Matches(SERVICE_TIME_PATTERN, { message: 'endTime must use 24-hour HH:mm format' })
  endTime?: string | null;

  @ApiPropertyOptional({ description: 'Is service active', default: true })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

/** Individual attendees are not themselves mixed; an unknown age group stays unspecified. */
export const ATTENDANCE_CATEGORIES = ['adult', 'children', 'unspecified'] as const;
export function defaultAttendanceCategory(serviceCategory?: string | null): string {
  return serviceCategory === 'mixed' ? 'unspecified' : (serviceCategory ?? 'adult');
}
