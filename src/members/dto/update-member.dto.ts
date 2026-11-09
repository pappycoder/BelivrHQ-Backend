/**
 * @file update-member.dto.ts
 * @description DTO for updating an existing church member.
 *
 * All fields are optional — only provided fields will be updated.
 * Extends CreateMemberDto but makes every field optional.
 *
 * @module members/dto/update-member
 * @since 1.0.0
 */

import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateMemberDto {
  @ApiPropertyOptional({
    description: 'Member first name',
    example: 'Chioma',
  })
  @IsString()
  @IsOptional()
  firstName?: string;

  @ApiPropertyOptional({
    description: 'Member last name',
    example: 'Eze',
  })
  @IsString()
  @IsOptional()
  lastName?: string;

  @ApiPropertyOptional({
    description: 'Member email address',
    example: 'chioma.eze@example.com',
  })
  @IsString()
  @IsOptional()
  email?: string;

  @ApiPropertyOptional({
    description: 'Phone number (Nigerian format)',
    example: '+234 803 456 7890',
  })
  @IsString()
  @IsOptional()
  phone?: string;

  @ApiPropertyOptional({
    description: 'WhatsApp number (Nigerian format)',
    example: '+234 803 456 7890',
  })
  @IsString()
  @IsOptional()
  whatsappNumber?: string;

  @ApiPropertyOptional({
    description: 'Date of birth (ISO 8601)',
    example: '1990-05-15',
  })
  @IsString()
  @IsOptional()
  dateOfBirth?: string;

  @ApiPropertyOptional({
    description: 'Gender',
    example: 'female',
    enum: ['male', 'female', 'other'],
  })
  @IsString()
  @IsOptional()
  gender?: string;

  @ApiPropertyOptional({
    description: 'Street address',
    example: '12 Admiralty Way, Lekki Phase 1',
  })
  @IsString()
  @IsOptional()
  address?: string;

  @ApiPropertyOptional({
    description: 'City',
    example: 'Lagos',
  })
  @IsString()
  @IsOptional()
  city?: string;

  @ApiPropertyOptional({
    description: 'State',
    example: 'Lagos',
  })
  @IsString()
  @IsOptional()
  state?: string;

  @ApiPropertyOptional({
    description: 'Member status',
    enum: ['active', 'inactive', 'suspended', 'transferred'],
    example: 'active',
  })
  @IsEnum(['active', 'inactive', 'suspended', 'transferred'] as const)
  @IsOptional()
  status?: 'active' | 'inactive' | 'suspended' | 'transferred';

  @ApiPropertyOptional({
    description: 'Branch ID to assign member to',
    example: '33333333-3333-3333-3333-333333333333',
  })
  @IsUUID()
  @IsOptional()
  branchId?: string;

  @ApiPropertyOptional({
    description: 'Profile photo URL',
    example: 'https://storage.supabase.co/v1/object/public/photos/member-123.jpg',
  })
  @IsString()
  @IsOptional()
  photoUrl?: string;

  @ApiPropertyOptional({
    description: 'Additional custom fields as JSON',
    example: { occupation: 'Engineer', baptism_date: '2024-01-15' },
  })
  @IsOptional()
  customFields?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Admin notes about the member',
    example: 'New member: referred by Pastor Daniel',
  })
  @IsString()
  @IsOptional()
  notes?: string;
}
