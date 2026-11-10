/**
 * @file DTO for profile responses.
 * @module profile/dto/profile-response.dto
 * @description Response DTO for profile endpoints including avatar and role info.
 * @since 1.0.0
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * A role assigned to a profile.
 */
export class ProfileRoleDto {
  @ApiProperty({ description: 'Role name', example: 'department_head' })
  name!: string;

  @ApiPropertyOptional({
    description: 'Human-friendly display label (custom roles)',
    example: 'Media Team',
  })
  label?: string;

  @ApiPropertyOptional({ description: 'Role description', example: 'Leads a ministry department' })
  description?: string;
}

/**
 * An effective permission granted to a user via one or more roles.
 */
export class PermissionDetailDto {
  @ApiProperty({ description: 'Permission name', example: 'members:update' })
  name!: string;

  @ApiProperty({ description: 'Resource the permission applies to', example: 'members' })
  resource!: string;

  @ApiProperty({ description: 'Action allowed on the resource', example: 'update' })
  action!: string;

  @ApiProperty({
    description: 'Roles that grant this permission',
    example: ['department_head', 'treasurer'],
    isArray: true,
  })
  grantedBy!: string[];
}

/**
 * Summary of the Member record linked to this profile, if any.
 */
export class MemberSummaryDto {
  @ApiProperty({ description: 'Member ID', example: '44444444-4444-4444-4444-444444444444' })
  memberId!: string;

  @ApiProperty({ description: 'First name', example: 'Adebayo' })
  firstName!: string;

  @ApiProperty({ description: 'Last name', example: 'Ogundimu' })
  lastName!: string;

  @ApiPropertyOptional({ description: 'Email address', example: 'adebayo@church.com' })
  email?: string;

  @ApiPropertyOptional({ description: 'Phone number', example: '+234 803 456 7890' })
  phone?: string;

  @ApiPropertyOptional({ description: 'Member photo URL' })
  photoUrl?: string;

  @ApiPropertyOptional({ description: 'Date of birth', example: '1985-04-12T00:00:00.000Z' })
  dateOfBirth?: string;

  @ApiPropertyOptional({ description: 'Gender', example: 'male' })
  gender?: string;

  @ApiPropertyOptional({ description: 'Home address', example: '12 Awolowo Road, Ikoyi' })
  address?: string;

  @ApiProperty({ description: 'Membership status', example: 'active' })
  status!: string;
}

/**
 * Response DTO for a single profile.
 * Used for GET /profiles/me, GET /profiles/:id, and list responses.
 */
export class ProfileResponseDto {
  @ApiPropertyOptional({
    description: 'Subscription feature availability (no billing details)',
    type: [String],
  })
  planFeatures?: string[];

  @ApiPropertyOptional({
    description: 'Expired paid subscription permits viewing/exports and billing only',
  })
  subscriptionReadOnly?: boolean;
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
    description: 'All roles assigned to the user, ordered by rank descending (first = primary)',
    example: ['church_admin', 'treasurer'],
    isArray: true,
  })
  role!: string[];

  @ApiPropertyOptional({
    description: 'Assigned roles with their descriptions',
    type: [ProfileRoleDto],
  })
  roles?: ProfileRoleDto[];

  @ApiPropertyOptional({
    description:
      'Effective permissions accumulated across all assigned roles (populated on detail responses)',
    type: [PermissionDetailDto],
  })
  effectivePermissions?: PermissionDetailDto[];

  @ApiPropertyOptional({
    description:
      'Flat list of permission names (resource:action) granted to this user across all roles',
    type: [String],
    example: ['members:read', 'branches:create'],
  })
  permissions?: string[];

  @ApiPropertyOptional({
    description: 'Last sign-in timestamp from the auth provider',
    example: '2026-08-20T09:12:00.000Z',
  })
  lastSignInAt?: string;

  @ApiPropertyOptional({
    description: 'Member record linked to this profile, if any',
    type: MemberSummaryDto,
  })
  member?: MemberSummaryDto;

  @ApiPropertyOptional({
    description:
      'Linked member id: present when the profile is linked to a member record (used by self-service ownership checks)',
    example: '44444444-4444-4444-4444-444444444444',
  })
  memberId?: string;

  @ApiProperty({ description: 'First name', example: 'Adebayo' })
  firstName!: string;

  @ApiProperty({ description: 'Last name', example: 'Ogundimu' })
  lastName!: string;

  @ApiPropertyOptional({ description: 'Email address', example: 'adebayo@church.com' })
  email?: string;

  @ApiPropertyOptional({ description: 'Phone number', example: '+234 803 456 7890' })
  phone?: string;

  @ApiPropertyOptional({
    description: 'Profile photo URL',
    example: 'https://xxx.supabase.co/storage/v1/object/public/media/profiles/abc/avatar.webp',
  })
  avatarUrl?: string;

  @ApiProperty({ description: 'MFA enabled', example: false })
  mfaEnabled!: boolean;

  @ApiProperty({ description: 'Email-OTP two-factor authentication enabled', example: false })
  twoFactorEnabled!: boolean;

  @ApiProperty({
    description:
      "Admin HQ flag: grants cross-branch read access within the user's permission scope. Defaults on for church_admin; managed manually otherwise.",
    example: false,
  })
  isAdminHq!: boolean;

  @ApiProperty({ description: 'Profile status', example: 'active' })
  status!: string;

  @ApiProperty({ description: 'Account creation date', example: '2026-07-15T10:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ description: 'Last update date', example: '2026-07-19T14:30:00.000Z' })
  updatedAt!: string;

  @ApiPropertyOptional({
    description: 'Archive timestamp: set when the profile is archived',
    example: '2026-08-28T10:30:00.000Z',
  })
  archivedAt?: string;

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
