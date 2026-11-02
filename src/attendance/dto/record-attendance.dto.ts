/**
 * @file record-attendance.dto.ts
 * @description DTOs for recording attendance check-ins.
 *
 * @module attendance/dto/record-attendance.dto
 * @since 1.0.0
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';
import { ATTENDANCE_CATEGORIES } from './create-service.dto';
import { AttendanceDateDto } from '../../common/dto/attendance-date.dto';

const CHECKIN_SOURCES = ['manual', 'qr', 'whatsapp'] as const;

/**
 * DTO for recording a single attendance check-in.
 * Either memberId or visitorName/visitorId must be provided.
 * Exactly one of serviceId or eventId must be provided (enforced at service level).
 */
export class RecordAttendanceDto extends AttendanceDateDto {
  @ApiPropertyOptional({ description: 'Service ID (for service check-in)' })
  @IsUUID()
  @IsOptional()
  serviceId?: string;

  @ApiPropertyOptional({ description: 'Event ID (for event check-in)' })
  @IsUUID()
  @IsOptional()
  eventId?: string;

  @ApiPropertyOptional({ description: 'Member ID (for member check-in)' })
  @IsUUID()
  @IsOptional()
  memberId?: string;

  @ApiPropertyOptional({ description: 'Visitor ID (links the check-in to a visitor record)' })
  @IsUUID()
  @IsOptional()
  visitorId?: string;

  @ApiPropertyOptional({ description: 'Visitor name (for walk-in check-ins)' })
  @IsString()
  @IsOptional()
  visitorName?: string;

  @ApiPropertyOptional({
    description:
      'Check-in category (defaults to the service category, or unspecified for a mixed service)',
    enum: ATTENDANCE_CATEGORIES,
  })
  @IsOptional()
  @IsIn(ATTENDANCE_CATEGORIES)
  category?: string;

  @ApiPropertyOptional({
    description: 'Check-in source',
    enum: CHECKIN_SOURCES,
    default: 'manual',
  })
  @IsString()
  @IsOptional()
  source?: string;
}

/**
 * DTO for recording a walk-in visitor attendance check-in.
 * Requires serviceId or eventId and visitorName (or visitorId).
 */
export class RecordVisitorAttendanceDto extends AttendanceDateDto {
  @ApiPropertyOptional({ description: 'Service ID (for service check-in)' })
  @IsUUID()
  @IsOptional()
  serviceId?: string;

  @ApiPropertyOptional({ description: 'Event ID (for event check-in)' })
  @IsUUID()
  @IsOptional()
  eventId?: string;

  @ApiProperty({ description: 'Visitor name', example: 'John Doe' })
  @IsString()
  @IsNotEmpty()
  visitorName!: string;

  @ApiPropertyOptional({ description: 'Visitor ID (links the check-in to a visitor record)' })
  @IsUUID()
  @IsOptional()
  visitorId?: string;

  @ApiPropertyOptional({
    description:
      'Check-in category (defaults to the service category, or unspecified for a mixed service)',
    enum: ATTENDANCE_CATEGORIES,
  })
  @IsOptional()
  @IsIn(ATTENDANCE_CATEGORIES)
  category?: string;

  @ApiPropertyOptional({
    description: 'Check-in source',
    enum: CHECKIN_SOURCES,
    default: 'manual',
  })
  @IsString()
  @IsOptional()
  source?: string;
}
