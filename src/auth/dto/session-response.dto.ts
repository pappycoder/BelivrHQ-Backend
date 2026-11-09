import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Response DTO for login — contains JWT tokens and user info.
 *
 * @module auth/dto/session-response.dto
 */
export class LoginResponseDto {
  @ApiPropertyOptional({
    description:
      'JWT access token. Absent when two-factor authentication is required: call /auth/login/2fa with the authenticator code and challengeToken to complete sign-in.',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
  })
  accessToken?: string;

  @ApiPropertyOptional({
    description:
      'Set to true when the account requires authenticator two-factor authentication and therefore has no accessToken yet.',
    example: true,
  })
  requiresTwoFactor?: boolean;

  @ApiPropertyOptional({
    description:
      'Masked address (e.g. j***@example.com) the code is sent to when requiresTwoFactor is true.',
    example: 'j***@example.com',
  })
  twoFactorEmail?: string;

  @ApiPropertyOptional()
  challengeToken?: string;

  @ApiPropertyOptional({ enum: ['authenticator', 'migration', 'supabase-migration'] })
  twoFactorMethod?: 'authenticator' | 'migration' | 'supabase-migration';

  @ApiPropertyOptional({ description: 'One-use recovery codes shown only at enrollment' })
  recoveryCodes?: string[];

  @ApiPropertyOptional()
  authenticatorSetup?: { factorId: string; qrCode: string; secret: string; uri: string };

  @ApiPropertyOptional({
    description: 'Refresh token (if Supabase returns one)',
    example: 'v1:abc123:def456...',
  })
  refreshToken?: string;

  @ApiPropertyOptional({
    description: 'Token expiry timestamp (Unix seconds)',
    example: 1700003600,
  })
  expiresAt?: number;

  @ApiProperty({
    description: 'Supabase Auth user ID',
    example: '11111111-1111-1111-1111-111111111111',
  })
  userId!: string;

  @ApiPropertyOptional({
    description: 'User email',
    example: 'pastor@demo.com',
  })
  email?: string;

  @ApiPropertyOptional({
    description: 'ChurchOS profile',
    example: {
      profileId: '22222222-2222-2222-2222-222222222222',
      churchId: '00000000-0000-0000-0000-000000000001',
      branchId: '33333333-3333-3333-3333-333333333333',
      role: ['church_admin'],
      firstName: 'Adebayo',
      lastName: 'Ogundimu',
    },
  })
  profile?: {
    profileId: string;
    churchId: string;
    branchId?: string;
    /** All roles held, ordered by rank descending (first = primary) */
    role: string[];
    firstName: string;
    lastName: string;
  };
}

/**
 * Response DTO for session refresh.
 *
 * @module auth/dto/session-response.dto
 */
export class RefreshResponseDto {
  @ApiProperty({
    description: 'New JWT access token',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
  })
  accessToken!: string;

  @ApiPropertyOptional({
    description: 'New refresh token',
    example: 'v1:xyz789:ghi012...',
  })
  refreshToken?: string;

  @ApiProperty({
    description: 'New token expiry timestamp (Unix seconds)',
    example: 1700007200,
  })
  expiresAt!: number;
}
