/**
 * @file DTOs for permission management endpoints.
 * @module auth/dto/permissions.dto
 * @since 1.0.0
 */

import { ApiProperty } from '@nestjs/swagger';
import {
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  ArrayMaxSize,
  ArrayMinSize,
  Length,
} from 'class-validator';

/**
 * DTO for setting permissions for a role.
 */
export class SetRolePermissionsDto {
  @ApiProperty({
    description: 'Array of permission IDs to assign to this role',
    example: ['perm-id-1', 'perm-id-2'],
    type: [String],
  })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  @IsNotEmpty()
  permissionIds!: string[];
}

/**
 * DTO for creating a church-owned custom role.
 */
export class CreateRoleDto {
  @ApiProperty({
    description:
      'Friendly role label: slugified into a snake_case role name (e.g. "Media Team" → "media_team")',
    example: 'Media Team',
    minLength: 3,
    maxLength: 50,
  })
  @IsString()
  @IsNotEmpty()
  @Length(3, 50)
  label!: string;

  @ApiProperty({
    description: 'What this role is for',
    example: 'Runs the media team during services',
    required: false,
    maxLength: 200,
  })
  @IsString()
  @IsOptional()
  @Length(0, 200)
  description?: string;

  @ApiProperty({
    description: 'Initial permission IDs to grant (optional: can be configured afterwards)',
    example: ['perm-id-1'],
    required: false,
    type: [String],
  })
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(200)
  @IsOptional()
  permissionIds?: string[];
}

/**
 * Response DTO for a single permission.
 */
export class PermissionResponseDto {
  @ApiProperty({ description: 'Permission ID' })
  id!: string;

  @ApiProperty({ description: 'Permission name (resource:action)', example: 'members:read' })
  name!: string;

  @ApiProperty({ description: 'Resource name', example: 'members' })
  resource!: string;

  @ApiProperty({ description: 'Action name', example: 'read' })
  action!: string;
}

/**
 * Response DTO for a role with its permissions.
 */
export class RolePermissionsResponseDto {
  @ApiProperty({ description: 'Role name', example: 'secretary' })
  roleName!: string;

  @ApiProperty({
    description: 'Human-friendly display name (custom roles); null falls back to the dictionary',
    example: 'Media Team',
    nullable: true,
  })
  label!: string | null;

  @ApiProperty({ description: 'Role description', example: 'Church secretary', nullable: true })
  description!: string | null;

  @ApiProperty({
    description: 'Effective permissions for this role',
    type: [PermissionResponseDto],
  })
  permissions!: PermissionResponseDto[];

  @ApiProperty({ description: 'Whether this role has church-specific overrides', example: false })
  isCustomized!: boolean;

  @ApiProperty({
    description: 'Whether the role is owned by this church rather than a global template',
    example: false,
  })
  isChurchOwned!: boolean;
}

/**
 * Response DTO for the roles summary (all roles for a church).
 */
export class RolesSummaryResponseDto {
  @ApiProperty({
    description: 'All roles with their permissions',
    type: [RolePermissionsResponseDto],
  })
  roles!: RolePermissionsResponseDto[];
}
