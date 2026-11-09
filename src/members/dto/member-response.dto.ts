/**
 * @file member-response.dto.ts
 * @description DTOs for member API responses.
 *
 * Defines the response shapes for single member and member list endpoints.
 *
 * @module members/dto/member-response
 * @since 1.0.0
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class MemberResponseDto {
  @ApiProperty({
    description: 'Member ID (UUID)',
    example: '44444444-4444-4444-4444-444444444444',
  })
  memberId!: string;

  @ApiProperty({
    description: 'Church ID',
    example: '11111111-1111-1111-1111-111111111111',
  })
  churchId!: string;

  @ApiPropertyOptional({
    description: 'Branch ID',
    example: '33333333-3333-3333-3333-333333333333',
  })
  branchId?: string;

  @ApiProperty({
    description: 'First name',
    example: 'Chioma',
  })
  firstName!: string;

  @ApiProperty({
    description: 'Last name',
    example: 'Eze',
  })
  lastName!: string;

  @ApiPropertyOptional({
    description: 'Email address',
    example: 'chioma.eze@example.com',
  })
  email?: string;

  @ApiPropertyOptional({
    description: 'Phone number',
    example: '+234 803 456 7890',
  })
  phone?: string;

  @ApiPropertyOptional({
    description: 'WhatsApp number',
    example: '+234 803 456 7890',
  })
  whatsappNumber?: string;

  @ApiPropertyOptional({
    description: 'Date of birth',
    example: '1990-05-15T00:00:00.000Z',
  })
  dateOfBirth?: string;

  @ApiPropertyOptional({
    description: 'Gender',
    example: 'female',
  })
  gender?: string;

  @ApiPropertyOptional({
    description: 'Street address',
    example: '12 Admiralty Way, Lekki Phase 1',
  })
  address?: string;

  @ApiPropertyOptional({
    description: 'City',
    example: 'Lagos',
  })
  city?: string;

  @ApiPropertyOptional({
    description: 'State',
    example: 'Lagos',
  })
  state?: string;

  @ApiProperty({
    description: 'Member status',
    enum: ['active', 'inactive', 'suspended', 'transferred'],
    example: 'active',
  })
  status!: string;

  @ApiProperty({
    description: 'Date member joined the church',
    example: '2024-01-15T00:00:00.000Z',
  })
  memberSince!: string;

  @ApiPropertyOptional({
    description: 'Profile photo URL',
    example: 'https://storage.supabase.co/v1/object/public/photos/member-123.jpg',
  })
  photoUrl?: string;

  @ApiPropertyOptional({
    description: 'Custom fields (JSON)',
    example: { occupation: 'Engineer' },
  })
  customFields?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Admin notes',
    example: 'New member: referred by Pastor Daniel',
  })
  notes?: string;

  @ApiProperty({
    description: 'Created timestamp',
    example: '2024-01-15T10:30:00.000Z',
  })
  createdAt!: string;

  @ApiProperty({
    description: 'Last updated timestamp',
    example: '2024-06-20T14:15:00.000Z',
  })
  updatedAt!: string;

  @ApiPropertyOptional({
    description: 'Set when the record is archived',
    example: '2026-08-28T10:30:00.000Z',
  })
  archivedAt?: string;
}
