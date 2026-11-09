/**
 * @file create-member.dto.ts
 * @description DTO for creating a new church member.
 *
 * Validates all required and optional fields for member creation.
 * First name and last name are required; all other fields are optional.
 *
 * @module members/dto/create-member
 * @since 1.0.0
 */

import { IsEmail, IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateMemberDto {
  @ApiProperty({
    description: 'Member first name',
    example: 'Chioma',
  })
  @IsString()
  @IsNotEmpty()
  firstName!: string;

  @ApiProperty({
    description: 'Member last name',
    example: 'Eze',
  })
  @IsString()
  @IsNotEmpty()
  lastName!: string;

  @ApiPropertyOptional({
    description: 'Member email address',
    example: 'chioma.eze@example.com',
  })
  @IsEmail()
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
    description: 'Branch ID to assign member to',
    example: 'cf82908b-e0fe-456e-9464-8179eb8feda0',
  })
  @IsUUID()
  @IsOptional()
  branchId?: string;

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
