/**
 * @file DTO for admin updates to another user's profile.
 * @module profile/dto/admin-update-user.dto
 * @description Data transfer object for admin edits of user basic details,
 * branch assignment, and account status.
 * @since 1.0.0
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, Length } from 'class-validator';

/**
 * DTO used by admins to edit another user's profile details.
 * All fields are optional — only provided fields are updated.
 */
export class AdminUpdateUserDto {
  @ApiPropertyOptional({ description: 'First name', example: 'Adebayo' })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  firstName?: string;

  @ApiPropertyOptional({ description: 'Last name', example: 'Ogundimu' })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  lastName?: string;

  @ApiPropertyOptional({ description: 'Email address', example: 'adebayo@church.com' })
  @IsOptional()
  @IsString()
  @Length(5, 255)
  email?: string;

  @ApiPropertyOptional({ description: 'Phone number', example: '+234 803 456 7890' })
  @IsOptional()
  @IsString()
  @Length(7, 20)
  phone?: string;

  @ApiPropertyOptional({
    description: 'Branch ID to assign. Send an empty string to unassign the branch.',
    example: '33333333-3333-3333-3333-333333333333',
  })
  @IsOptional()
  @IsString()
  branchId?: string;

  @ApiPropertyOptional({
    description: 'Account status',
    enum: ['active', 'inactive'],
    example: 'active',
  })
  @IsOptional()
  @IsIn(['active', 'inactive'])
  status?: string;

  @ApiPropertyOptional({
    description:
      "Admin HQ flag: grants cross-branch access within the user's permission scope. Managed manually; defaults on for church_admin.",
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  isAdminHq?: boolean;
}
