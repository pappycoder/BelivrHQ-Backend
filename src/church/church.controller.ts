/**
 * @file Church management controller with REST API endpoints.
 * @module ChurchController
 * @description Handles HTTP requests for church details, configuration, and staff management.
 * All endpoints require JWT authentication and appropriate roles via RBAC.
 * @since 1.0.0
 */

import { ApiBotProtection } from '../bot-protection/api-bot-protection.decorator';
import {
  Controller,
  Get,
  Patch,
  Post,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import {
  CurrentUser,
  SupabaseUser,
  AuthenticatedRequest,
} from '../common/decorators/current-user.decorator';
import {
  ApiGetEndpoint,
  ApiUpdateEndpoint,
  ApiCreateEndpoint,
  ApiDeleteEndpoint,
} from '../common/decorators/api-standard-responses.decorator';
import { ChurchService } from './church.service';
import { UpdateChurchDto } from './dto/update-church.dto';
import { UpdateChurchEmailDto } from './dto/update-church-email.dto';
import { ChurchResponseDto } from './dto/church-response.dto';
import { UpdateChurchConfigDto } from './dto/update-church-config.dto';
import { ChurchConfigResponseDto } from './dto/church-config-response.dto';
import { InviteStaffDto } from './dto/invite-staff.dto';
import { StaffResponseDto } from './dto/staff-response.dto';
import { UpdateStaffRoleDto } from './dto/update-staff-role.dto';

/**
 * Controller for church management operations.
 * Provides endpoints for church details, configuration, and staff CRUD.
 * All endpoints require JWT authentication and role-based access control.
 */
@ApiTags('Church')
@ApiBearerAuth('supabase-auth')
@UseGuards(JwtAuthGuard)
@Controller('church')
export class ChurchController {
  /**
   * Creates an instance of ChurchController.
   * @param churchService - Service for church operations
   */
  constructor(private readonly churchService: ChurchService) {}

  @Get()
  @RequirePermissions('church:read')
  @ApiGetEndpoint(
    'Get church details',
    'Retrieves the current church details including branch and member counts.',
  )
  /**
   * Retrieves the current church details.
   * @param req - Authenticated request with user profile
   * @returns ChurchResponseDto with church details
   */
  async getChurch(@Request() req: AuthenticatedRequest): Promise<ChurchResponseDto> {
    const churchId = req.profile?.church_id || '';
    return this.churchService.getChurch(churchId);
  }

  @Patch()
  @RequirePermissions('church_settings:update')
  @ApiUpdateEndpoint(
    'Update church details',
    'Updates church details. Only church_admin and super_admin can update.',
  )
  /**
   * Updates church details.
   * @param dto - Update data (all fields optional)
   * @param user - Current authenticated user
   * @param req - Authenticated request with user profile
   * @returns Updated ChurchResponseDto
   */
  async updateChurch(
    @Body() dto: UpdateChurchDto,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<ChurchResponseDto> {
    const churchId = req.profile?.church_id || '';
    return this.churchService.updateChurch(churchId, dto, user.id);
  }

  @Patch('email')
  @RequirePermissions('church_settings:update')
  @ApiUpdateEndpoint(
    'Update the unified church email',
    'Changes the email everywhere it lives for the acting admin: sign-in credential (Supabase Auth), profile contact record, and the church public contact email.',
  )
  /**
   * Updates the unified church email.
   * @param dto - The new email address
   * @param user - Current authenticated user
   * @param req - Authenticated request with user profile
   * @returns Updated ChurchResponseDto
   */
  async updateChurchEmail(
    @Body() dto: UpdateChurchEmailDto,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<ChurchResponseDto> {
    const churchId = req.profile?.church_id || '';
    return this.churchService.updateChurchEmail(churchId, user.id, dto);
  }

  @Post('archive')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('church_settings:update')
  @ApiUpdateEndpoint(
    'Archive church',
    "Sets archived_at on the church. Every request from this church's profiles is then rejected (except restore).",
  )
  /**
   * Archives the current church.
   * @param user - Current authenticated user
   * @param req - Authenticated request with user profile
   * @returns Updated ChurchResponseDto
   */
  async archiveChurch(
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<ChurchResponseDto> {
    const churchId = req.profile?.church_id || '';
    return this.churchService.archiveChurch(churchId, user.id);
  }

  @Post('restore')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('church_settings:update')
  @ApiUpdateEndpoint(
    'Restore archived church',
    'Clears archived_at. The one request the middleware lets through for profiles of an archived church.',
  )
  /**
   * Restores an archived church.
   * @param user - Current authenticated user
   * @param req - Authenticated request with user profile
   * @returns Updated ChurchResponseDto
   */
  async restoreChurch(
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<ChurchResponseDto> {
    const churchId = req.profile?.church_id || '';
    return this.churchService.restoreChurch(churchId, user.id);
  }

  @Get('config')
  @RequirePermissions('church_settings:read')
  @ApiGetEndpoint(
    'Get church configuration',
    'Retrieves all configuration key-value pairs for the church.',
  )
  /**
   * Retrieves all church configuration key-value pairs.
   * @param req - Authenticated request with user profile
   * @returns ChurchConfigResponseDto with all config values
   */
  async getConfig(@Request() req: AuthenticatedRequest): Promise<ChurchConfigResponseDto> {
    const churchId = req.profile?.church_id || '';
    return this.churchService.getChurchConfig(churchId);
  }

  @Patch('config')
  @RequirePermissions('church_settings:update')
  @ApiUpdateEndpoint(
    'Update church configuration',
    'Upserts configuration key-value pairs for the church.',
  )
  /**
   * Upserts church configuration key-value pairs.
   * @param dto - Config key-value pairs to upsert
   * @param user - Current authenticated user
   * @param req - Authenticated request with user profile
   * @returns Updated ChurchConfigResponseDto
   */
  async updateConfig(
    @Body() dto: UpdateChurchConfigDto,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<ChurchConfigResponseDto> {
    const churchId = req.profile?.church_id || '';
    return this.churchService.updateChurchConfig(churchId, dto, user.id);
  }

  @Post('invite')
  @ApiBotProtection(InviteStaffDto)
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('church_settings:update')
  @ApiCreateEndpoint(
    'Invite staff member',
    'Sends a Supabase Auth invitation email and creates a Profile record for the new staff member.',
  )
  /**
   * Invites a staff member via Supabase Auth invitation.
   * @param dto - Staff invitation details
   * @param user - Current authenticated user
   * @param req - Authenticated request with user profile
   * @returns StaffResponseDto with created profile
   */
  async inviteStaff(
    @Body() dto: InviteStaffDto,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<StaffResponseDto> {
    const churchId = req.profile?.church_id || '';
    return this.churchService.inviteStaff(churchId, dto, user.id);
  }

  @Get('staff')
  @RequirePermissions('profiles:read')
  @ApiGetEndpoint(
    'List staff members',
    'Returns a paginated list of all staff profiles for the church.',
  )
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page' })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description: 'Search term for name/email',
  })
  @ApiQuery({ name: 'role', required: false, type: String, description: 'Filter by role' })
  /**
   * Lists staff members with pagination and filtering.
   * @param page - Page number (optional)
   * @param limit - Items per page (optional)
   * @param search - Search term for name/email (optional)
   * @param role - Filter by role (optional)
   * @param req - Authenticated request with user profile
   * @returns Array of StaffResponseDto and total count
   */
  async listStaff(
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('search') search?: string,
    @Query('role') role?: string,
    @Request() req?: AuthenticatedRequest,
  ): Promise<{ data: StaffResponseDto[]; total: number }> {
    const churchId = req?.profile?.church_id || '';
    return this.churchService.listStaff(churchId, { page, limit, search, role });
  }

  @Patch('staff/:profileId/role')
  @RequirePermissions('roles:update', 'church_settings:update')
  @ApiUpdateEndpoint('Update staff role', 'Changes the role of a staff member within the church.')
  /**
   * Updates a staff member's role.
   * @param profileId - Profile UUID
   * @param dto - New role data
   * @param user - Current authenticated user
   * @param req - Authenticated request with user profile
   * @returns Updated StaffResponseDto
   */
  async updateStaffRole(
    @Param('profileId') profileId: string,
    @Body() dto: UpdateStaffRoleDto,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<StaffResponseDto> {
    const churchId = req.profile?.church_id || '';
    return this.churchService.updateStaffRole(churchId, profileId, dto, user.id);
  }

  @Delete('staff/:profileId')
  @RequirePermissions('church_settings:update')
  @ApiDeleteEndpoint(
    'Remove staff member',
    'Soft-deletes a staff member by setting their role to "removed".',
  )
  /**
   * Soft-deletes a staff member by setting role to "removed".
   * @param profileId - Profile UUID
   * @param user - Current authenticated user
   * @param req - Authenticated request with user profile
   * @returns Object with success status
   */
  async removeStaff(
    @Param('profileId') profileId: string,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<{ success: boolean }> {
    const churchId = req.profile?.church_id || '';
    return this.churchService.removeStaff(churchId, profileId, user.id);
  }
}
