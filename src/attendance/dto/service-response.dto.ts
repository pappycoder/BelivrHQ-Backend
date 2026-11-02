/**
 * @file service-response.dto.ts
 * @description Response DTO for church service data.
 *
 * @module attendance/dto/service-response.dto
 * @since 1.0.0
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Response DTO representing a church service schedule.
 */
export class ServiceResponseDto {
  @ApiProperty({ description: 'Service ID' })
  serviceId!: string;

  @ApiProperty({ description: 'Church ID' })
  churchId!: string;

  @ApiPropertyOptional({ description: 'Branch ID' })
  branchId?: string;

  @ApiProperty({ description: 'Service name' })
  name!: string;

  @ApiProperty({
    description: 'Check-in category this service targets',
    enum: ['adult', 'children', 'mixed'],
  })
  category!: string;

  @ApiPropertyOptional({ description: 'Day of week (0=Sunday, 6=Saturday)' })
  dayOfWeek?: number;

  @ApiProperty({
    description: 'How the schedule repeats',
    enum: ['weekly', 'one_time', 'multi_day'],
  })
  recurrence!: string;

  @ApiPropertyOptional({ description: 'First valid day (YYYY-MM-DD)' })
  startsOn?: string;

  @ApiPropertyOptional({ description: 'Last valid day (YYYY-MM-DD)' })
  endsOn?: string;

  @ApiPropertyOptional({ description: 'Local start time (24-hour HH:mm)', example: '09:00' })
  startTime?: string;

  @ApiPropertyOptional({ description: 'Local end time (24-hour HH:mm)', example: '11:00' })
  endTime?: string;

  @ApiProperty({ description: 'Is service active' })
  isActive!: boolean;

  @ApiProperty({ description: 'Created at' })
  createdAt!: string;

  @ApiProperty({ description: 'Updated at' })
  updatedAt!: string;

  @ApiPropertyOptional({ description: 'Attendance count for today' })
  attendanceCount?: number;

  @ApiPropertyOptional({ description: 'Set when the record is archived' })
  archivedAt?: string;
}
