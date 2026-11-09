/**
 * @file create-appointment.dto.ts
 * @description DTO for creating an appointment (With/Who model).
 *
 * @module appointments/dto/create-appointment.dto
 * @since 1.0.0
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { APPOINTMENT_STATUS } from './appointment-response.dto';

/**
 * The Who party can be a staff profile or an existing visitor.
 */
export type AppointmentWhoKind = 'profile' | 'visitor';

/**
 * DTO for creating a new appointment in the booking registry.
 *
 * Every appointment has a fixed With party (a pastor: branch_pastor /
 * senior_pastor / church_admin) and a Who party (a staff profile or an
 * existing visitor). The booker (secretary or pastor) is implicit — there is
 * no stored creator column.
 */
export class CreateAppointmentDto {
  @ApiProperty({ description: 'Appointment title', example: 'Budget planning' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @ApiProperty({
    description: 'Scheduled date/time (ISO 8601)',
    example: '2026-09-05T10:00:00.000Z',
  })
  @IsISO8601()
  scheduledAt!: string;

  @ApiProperty({
    description:
      'The With party: the pastor Profile ID (branch_pastor | senior_pastor | church_admin).',
    example: '11111111-1111-1111-1111-111111111111',
  })
  @IsUUID('4')
  withId!: string;

  @ApiProperty({
    description: 'The Who party: a staff Profile ID. Mutually exclusive with the visitor form.',
    example: '22222222-2222-2222-2222-222222222222',
  })
  @IsUUID('4')
  @ValidateIf((o) => o.whoKind !== 'visitor')
  whoId?: string;

  @ApiPropertyOptional({
    description:
      'The Who party kind. Omit (or "profile") to book a profile via `whoId`; ' +
      '"visitor" to book an existing visitor via `visitorId`.',
    enum: ['profile', 'visitor'],
    default: 'profile',
    example: 'profile',
  })
  @IsIn(['profile', 'visitor'])
  @IsOptional()
  whoKind?: AppointmentWhoKind;

  @ApiPropertyOptional({
    description:
      'The Who party: an existing visitor Profile-equivalent ID, required when `whoKind` is "visitor".',
    example: '8c8c8c8c-8c8c-8c8c-8c8c-8c8c8c8c8c8c',
  })
  @IsUUID('4')
  @ValidateIf((o) => o.whoKind === 'visitor')
  visitorId?: string;

  @ApiPropertyOptional({ description: 'Location', example: 'Main Campus: Office 2' })
  @IsString()
  @MaxLength(200)
  @IsOptional()
  location?: string;

  @ApiPropertyOptional({ description: 'Purpose / notes', example: 'Review Q3 outreach plans' })
  @IsString()
  @MaxLength(2000)
  @IsOptional()
  notes?: string;

  @ApiPropertyOptional({
    description: 'Status',
    enum: APPOINTMENT_STATUS,
    default: 'pending',
    example: 'pending',
  })
  @IsIn(APPOINTMENT_STATUS)
  @IsOptional()
  status?: string;
}
