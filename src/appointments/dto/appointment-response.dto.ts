/**
 * @file appointment-response.dto.ts
 * @description Response DTOs for the appointments module.
 *
 * @module appointments/dto/appointment-response.dto
 * @since 1.0.0
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * The possible states of an appointment. Mirrors the raw `status` column.
 */
export const APPOINTMENT_STATUS = ['pending', 'confirmed', 'completed', 'cancelled'] as const;

/**
 * A single appointment as surfaced in a list or detail read.
 */
export class AppointmentDto {
  @ApiProperty({
    description: 'Appointment ID (UUID)',
    example: '99999999-9999-9999-9999-999999999999',
  })
  id!: string;

  @ApiProperty({ description: 'Appointment title', example: 'Budget planning' })
  title!: string;

  @ApiProperty({
    description: 'Scheduled date/time',
    example: '2026-09-05T10:00:00.000Z',
  })
  scheduledAt!: string;

  @ApiProperty({
    description: 'With party: pastor Profile ID',
    example: '11111111-1111-1111-1111-111111111111',
  })
  pastorId!: string;

  @ApiPropertyOptional({
    description: 'With party: pastor full name',
    example: 'Pastor John Adebayo',
  })
  pastorName?: string;

  @ApiPropertyOptional({
    description: 'With party: pastor primary role',
    example: 'branch_pastor',
  })
  pastorRole?: string;

  @ApiPropertyOptional({
    description: 'With party: pastor avatar URL',
    example: 'https://storage.example.com/avatars/pastor.jpg',
  })
  pastorAvatarUrl?: string;

  @ApiProperty({
    description: 'Who party: person Profile ID',
    example: '22222222-2222-2222-2222-222222222222',
  })
  personId!: string;

  @ApiPropertyOptional({
    description: 'Who party: person full name',
    example: 'Sister Bola Okonkwo',
  })
  personName?: string;

  @ApiPropertyOptional({
    description: 'Who party: person avatar URL',
    example: 'https://storage.example.com/avatars/person.jpg',
  })
  personAvatarUrl?: string;

  @ApiPropertyOptional({
    description: 'Who party kind',
    enum: ['profile', 'visitor'],
    example: 'profile',
  })
  whoKind?: 'profile' | 'visitor';

  @ApiPropertyOptional({
    description: 'Who party: visitor ID (when whoKind is visitor)',
    example: '8c8c8c8c-8c8c-8c8c-8c8c-8c8c8c8c8c8c',
  })
  visitorId?: string;

  @ApiPropertyOptional({
    description: 'Who party: visitor full name (when whoKind is visitor)',
    example: 'Visitor Tunde Bello',
  })
  visitorName?: string;

  @ApiPropertyOptional({ description: 'Location', example: 'Main Campus: Office 2' })
  location?: string;

  @ApiPropertyOptional({ description: 'Purpose / notes', example: 'Review Q3 outreach plans' })
  notes?: string;

  @ApiProperty({
    description: 'Status',
    enum: APPOINTMENT_STATUS,
    example: 'pending',
  })
  status!: string;

  @ApiProperty({ description: 'Creation timestamp', example: '2026-08-30T08:00:00.000Z' })
  createdAt!: string;

  @ApiPropertyOptional({
    description: 'Archive timestamp (null if active)',
    example: '2026-08-31T09:00:00.000Z',
  })
  archivedAt?: string;
}

/**
 * A selectable appointment participant (With/pastor picker or Who/person picker).
 */
export class AppointmentContactDto {
  @ApiProperty({
    description: 'Profile ID (UUID)',
    example: '11111111-1111-1111-1111-111111111111',
  })
  id!: string;

  @ApiProperty({ description: 'Full name', example: 'Pastor John Adebayo' })
  name!: string;

  @ApiProperty({ description: 'Primary role', example: 'branch_pastor' })
  role!: string;

  @ApiProperty({
    description:
      'Which picker this contact is for: "with" = the pastor partner, "who" = the person',
    enum: ['with', 'who'],
    example: 'with',
  })
  kind!: 'with' | 'who';

  @ApiProperty({
    description: 'Whether this contact is a pastor (fills the With/pastor side)',
    example: true,
  })
  isPastor!: boolean;

  @ApiPropertyOptional({
    description: 'Branch ID',
    example: '33333333-3333-3333-3333-333333333333',
  })
  branchId?: string;

  @ApiPropertyOptional({ description: 'Branch name', example: 'Main Campus' })
  branchName?: string;

  @ApiPropertyOptional({
    description: 'Avatar URL',
    example: 'https://supabase.co/storage/v1/object/public/media/avatar.webp',
  })
  avatarUrl?: string;
}

/**
 * Paginated appointment list.
 */
export class AppointmentListEnvelopeDto {
  @ApiProperty({ type: [AppointmentDto] })
  data!: AppointmentDto[];

  @ApiProperty({ description: 'Total appointments in the current view', example: 25 })
  total!: number;

  @ApiProperty({
    description: 'Status breakdown across all appointments in the church filter',
    example: { pending: 3, confirmed: 4, completed: 5, cancelled: 2 },
  })
  summary!: Record<string, number>;
}
