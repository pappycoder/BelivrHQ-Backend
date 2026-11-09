/**
 * @file members.controller.ts
 * @description HTTP endpoints for church member management.
 *
 * Provides CRUD operations, search, listing, bulk import, QR codes,
 * giving/attendance history, and admin notes for church members.
 * All endpoints require JWT authentication and are scoped by church_id.
 *
 * @module members/members.controller
 * @since 1.0.0
 */

import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  Res,
  Header,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery, ApiOkResponse } from '@nestjs/swagger';
import { Response } from 'express';
import { MembersService } from './members.service';
import { CreateMemberDto } from './dto/create-member.dto';
import { UpdateMemberDto } from './dto/update-member.dto';
import { ListMembersDto } from './dto/list-members.dto';
import { MemberResponseDto } from './dto/member-response.dto';
import { MemberDashboardQueryDto, MemberDashboardResponseDto } from './dto/member-dashboard.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { CurrentUser, SupabaseUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedRequest } from '../common/decorators/current-user.decorator';
import {
  ApiCreateEndpoint,
  ApiListEndpoint,
  ApiGetEndpoint,
  ApiUpdateEndpoint,
  ApiDeleteEndpoint,
} from '../common/decorators/api-standard-responses.decorator';
import { ApiPaginatedResponse } from '../common/decorators/api-paginated.decorator';

@ApiTags('Members')
@ApiBearerAuth('supabase-auth')
@UseGuards(JwtAuthGuard)
@Controller('members')
export class MembersController {
  constructor(private readonly membersService: MembersService) {}

  /**
   * Create a new church member.
   */
  @Post()
  @RequirePermissions('members:new:create')
  @ApiCreateEndpoint(
    'Create a new member',
    'Creates a new church member with the provided details.',
  )
  async create(
    @Body() dto: CreateMemberDto,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<MemberResponseDto> {
    const churchId = req.profile?.church_id || '';
    return this.membersService.createMember(dto, churchId, user.id);
  }

  /**
   * List members with pagination, search, and filters.
   */
  @Get()
  @ApiPaginatedResponse(MemberResponseDto)
  @ApiListEndpoint(
    'List members',
    'Retrieves a paginated list of church members with optional filters.',
  )
  async findAll(@Query() query: ListMembersDto, @Request() req: AuthenticatedRequest) {
    const churchId = req.profile?.church_id || '';
    const result = await this.membersService.listMembers(
      churchId,
      query,
      req.profile?.permissions || [],
      req.profile,
    );
    return {
      data: result.data,
      meta: {
        total: result.total,
        page: query.page || 1,
        limit: query.limit || 20,
        totalPages: Math.ceil(result.total / (query.limit || 20)),
      },
    };
  }

  /**
   * Aggregate dashboard counts without returning member records.
   */
  @Get('dashboard')
  @RequirePermissions('members:all:read')
  @ApiOperation({ summary: 'Read scoped member dashboard aggregates' })
  @ApiOkResponse({ type: MemberDashboardResponseDto })
  async getDashboard(
    @Query() query: MemberDashboardQueryDto,
    @Request() req: AuthenticatedRequest,
  ): Promise<MemberDashboardResponseDto> {
    return this.membersService.getDashboard(req.profile?.church_id || '', query, req.profile);
  }

  /** Search members by name, email, or phone. */
  @Get('search')
  @ApiListEndpoint(
    'Search members',
    'Performs full-text search across member names, emails, and phones.',
  )
  @ApiQuery({ name: 'q', required: true, type: String, description: 'Search term' })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Max results (default 20)',
  })
  async search(
    @Query('q') searchTerm: string,
    @Query('limit') limit: number,
    @Request() req: AuthenticatedRequest,
    @Query('branchId') branchId?: string,
  ): Promise<{ data: MemberResponseDto[] }> {
    const churchId = req.profile?.church_id || '';
    const data = await this.membersService.searchMembers(
      churchId,
      searchTerm,
      limit || 20,
      req.profile?.permissions || [],
      req.profile,
      branchId,
    );
    return { data };
  }

  /**
   * Export members as CSV file.
   */
  @Get('export/csv')
  @Header('Content-Type', 'text/csv')
  @Header('Content-Disposition', 'attachment; filename="members.csv"')
  @ApiOperation({
    summary: 'Export members as CSV',
    description: 'Exports all members as a CSV file download.',
  })
  @ApiQuery({ name: 'status', required: false, type: String, description: 'Filter by status' })
  @ApiQuery({ name: 'branchId', required: false, type: String, description: 'Filter by branch ID' })
  async exportCsv(
    @Query('status') status: string,
    @Query('branchId') branchId: string,
    @Request() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const churchId = req.profile?.church_id || '';
    const csv = await this.membersService.exportMembersCsv(
      churchId,
      status,
      branchId,
      req.profile?.permissions || [],
      req.profile,
    );
    res.send(csv);
  }

  /**
   * Export members as XLSX file.
   */
  @Get('export/xlsx')
  @Header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  @Header('Content-Disposition', 'attachment; filename="members.xlsx"')
  @ApiOperation({
    summary: 'Export members as XLSX',
    description: 'Exports all members as an Excel XLSX file download.',
  })
  @ApiQuery({ name: 'status', required: false, type: String, description: 'Filter by status' })
  @ApiQuery({ name: 'branchId', required: false, type: String, description: 'Filter by branch ID' })
  async exportXlsx(
    @Query('status') status: string,
    @Query('branchId') branchId: string,
    @Request() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const churchId = req.profile?.church_id || '';
    const buffer = await this.membersService.exportMembersXlsx(
      churchId,
      status,
      branchId,
      req.profile?.permissions || [],
      req.profile,
    );
    res.send(buffer);
  }

  /**
   * Get a single member by ID.
   */
  @Get(':memberId')
  @ApiGetEndpoint('Get member by ID', 'Retrieves a single member by their UUID.')
  async findOne(
    @Param('memberId') memberId: string,
    @Request() req: AuthenticatedRequest,
  ): Promise<MemberResponseDto> {
    const churchId = req.profile?.church_id || '';
    return this.membersService.getMemberById(
      memberId,
      churchId,
      req.profile?.permissions || [],
      req.profile,
    );
  }

  /**
   * Update a member's details (partial update).
   */
  @Patch(':memberId')
  @RequirePermissions('members:all:update')
  @ApiUpdateEndpoint(
    'Update member details',
    'Updates a member with partial data. Only provided fields are updated.',
  )
  async update(
    @Param('memberId') memberId: string,
    @Body() dto: UpdateMemberDto,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<MemberResponseDto> {
    const churchId = req.profile?.church_id || '';
    return this.membersService.updateMember(memberId, dto, churchId, user.id);
  }

  /**
   * Soft-delete a member (set status to inactive).
   */
  @Delete(':memberId')
  @RequirePermissions('members:all:delete')
  @ApiDeleteEndpoint(
    'Delete a member',
    'Soft-deletes a member by setting their status to inactive.',
  )
  async remove(
    @Param('memberId') memberId: string,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<{ success: boolean }> {
    const churchId = req.profile?.church_id || '';
    await this.membersService.softDeleteMember(memberId, churchId, user.id);
    return { success: true };
  }

  /**
   * Restore a soft-deleted member (set status back to active).
   */
  @Post(':memberId/restore')
  @RequirePermissions('members:all:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Restore a member',
    description: 'Restores a soft-deleted member by setting their status back to active.',
  })
  async restore(
    @Param('memberId') memberId: string,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<MemberResponseDto> {
    const churchId = req.profile?.church_id || '';
    return this.membersService.restoreMember(memberId, churchId, user.id);
  }

  /**
   * Archive a member.
   */
  @Post(':memberId/archive')
  @RequirePermissions('members:all:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Archive a member',
    description: 'Sets archived_at: hides the member from active lists until restored.',
  })
  async archive(
    @Param('memberId') memberId: string,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<MemberResponseDto> {
    const churchId = req.profile?.church_id || '';
    return this.membersService.archiveMember(memberId, churchId, user.id);
  }

  /**
   * Restore an archived member.
   */
  @Post(':memberId/restore-archive')
  @RequirePermissions('members:all:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Restore an archived member',
    description: 'Clears archived_at: brings the member back into active lists.',
  })
  async restoreArchive(
    @Param('memberId') memberId: string,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<MemberResponseDto> {
    const churchId = req.profile?.church_id || '';
    return this.membersService.restoreArchivedMember(memberId, churchId, user.id);
  }

  /**
   * Bulk import members from CSV/JSON data.
   */
  @Post('bulk-import')
  @RequirePermissions('members:import:create')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Bulk import members',
    description: 'Import multiple members from CSV/JSON data with validation and error reporting.',
  })
  async bulkImport(
    @Body() body: { members: CreateMemberDto[]; dryRun?: boolean },
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<{
    created: number;
    errors: Array<{ row: number; message: string }>;
    dryRun: boolean;
  }> {
    const churchId = req.profile?.church_id || '';
    return this.membersService.bulkImportMembers(
      body.members,
      churchId,
      user.id,
      body.dryRun || false,
    );
  }

  /**
   * Generate QR code data for a member.
   */
  @Get(':memberId/qr-code')
  @ApiGetEndpoint('Generate QR code', 'Generates QR code data for member check-in scanning.')
  async generateQRCode(
    @Param('memberId') memberId: string,
    @Request() req: AuthenticatedRequest,
  ): Promise<{ qrData: string; memberId: string }> {
    const churchId = req.profile?.church_id || '';
    return this.membersService.generateMemberQRCode(memberId, churchId);
  }

  /**
   * Get giving history for a member.
   */
  @Get(':memberId/giving')
  @RequirePermissions('giving:records:read')
  @ApiGetEndpoint('Get giving history', 'Retrieves the giving transaction history for a member.')
  async getGivingHistory(
    @Param('memberId') memberId: string,
    @Request() req: AuthenticatedRequest,
  ): Promise<{
    data: Array<{
      id: string;
      amount: number;
      currency: string;
      categoryId: string;
      status: string;
      createdAt: string;
    }>;
  }> {
    const churchId = req.profile?.church_id || '';
    const data = await this.membersService.getMemberGivingHistory(memberId, churchId);
    return { data };
  }

  /**
   * Get attendance history for a member.
   */
  @Get(':memberId/attendance')
  @ApiGetEndpoint('Get attendance history', 'Retrieves the attendance history for a member.')
  async getAttendanceHistory(
    @Param('memberId') memberId: string,
    @Request() req: AuthenticatedRequest,
  ): Promise<{
    data: Array<{
      id: string;
      checkInAt: string;
      serviceName: string;
      source: string;
      createdAt: string;
    }>;
  }> {
    const churchId = req.profile?.church_id || '';
    const data = await this.membersService.getMemberAttendanceHistory(
      memberId,
      churchId,
      req.profile,
    );
    return { data };
  }

  /**
   * Add an admin note to a member.
   */
  @Post(':memberId/notes')
  @RequirePermissions('members:all:update')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Add admin note',
    description: 'Adds a timestamped admin note to a member record.',
  })
  async addNote(
    @Param('memberId') memberId: string,
    @Body() body: { note: string },
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<{ success: boolean }> {
    const churchId = req.profile?.church_id || '';
    return this.membersService.addMemberNote(memberId, body.note, churchId, user.id);
  }
}
