/**
 * @file auth-response.dto.ts
 * @description Response DTOs for auth endpoints.
 *
 * @module auth/dto/auth-response
 * @since 1.0.0
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RegisterResponseDto {
  @ApiPropertyOptional({
    description: 'Registration session, omitted when email confirmation is required',
  })
  accessToken?: string;

  @ApiPropertyOptional()
  refreshToken?: string;

  @ApiPropertyOptional()
  expiresAt?: number;

  @ApiPropertyOptional()
  requiresEmailConfirmation?: boolean;

  @ApiProperty({
    description: 'Supabase Auth user ID',
    example: '11111111-1111-1111-1111-111111111111',
  })
  userId!: string;

  @ApiProperty({ description: 'User email', example: 'pastor@demo.com' })
  email!: string;

  @ApiProperty({
    description: 'BelivrHQ profile ID',
    example: '22222222-2222-2222-2222-222222222222',
  })
  profileId!: string;

  @ApiProperty({ description: 'Church ID', example: '00000000-0000-0000-0000-000000000001' })
  churchId!: string;

  @ApiProperty({ description: 'Church name', example: 'Grace Community Church' })
  churchName!: string;

  @ApiProperty({
    description: 'User roles, ordered by rank descending (first = primary)',
    example: ['church_admin'],
    isArray: true,
  })
  role!: string[];
}

export class ProfileResponseDto {
  @ApiProperty({ description: 'Profile ID', example: '22222222-2222-2222-2222-222222222222' })
  profileId!: string;

  @ApiProperty({
    description: 'Supabase Auth user ID',
    example: '11111111-1111-1111-1111-111111111111',
  })
  userId!: string;

  @ApiProperty({ description: 'Church ID', example: '00000000-0000-0000-0000-000000000001' })
  churchId!: string;

  @ApiPropertyOptional({
    description: 'Branch ID',
    example: '33333333-3333-3333-3333-333333333333',
  })
  branchId?: string;

  @ApiProperty({
    description: 'User roles, ordered by rank descending (first = primary)',
    example: ['church_admin'],
    isArray: true,
  })
  role!: string[];

  @ApiProperty({ description: 'First name', example: 'Adebayo' })
  firstName!: string;

  @ApiProperty({ description: 'Last name', example: 'Ogundimu' })
  lastName!: string;

  @ApiPropertyOptional({ description: 'Phone number', example: '+234 803 456 7890' })
  phone?: string;

  @ApiProperty({ description: 'MFA enabled', example: false })
  mfaEnabled!: boolean;

  @ApiPropertyOptional({
    description: 'Church details',
    example: {
      churchId: '00000000-0000-0000-0000-000000000001',
      name: 'Grace Community Church',
      denomination: 'Pentecostal',
      logoUrl: 'https://example.com/logo.png',
    },
  })
  church?: {
    churchId: string;
    name: string;
    denomination?: string;
    logoUrl?: string;
  };

  @ApiPropertyOptional({
    description: 'Branch details',
    example: {
      branchId: '33333333-3333-3333-3333-333333333333',
      name: 'Headquarters',
      isHeadquarters: true,
    },
  })
  branch?: {
    branchId: string;
    name: string;
    isHeadquarters: boolean;
  };
}
