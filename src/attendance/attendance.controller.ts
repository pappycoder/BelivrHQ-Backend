/**
 * @file attendance.controller.ts
 * @description HTTP endpoints for attendance and service management.
 *
 * Provides service CRUD, single/bulk check-in, attendance summary,
 * trends, and visitor attendance recording. All endpoints require
 * JWT authentication and are scoped by church_id.
 *
 * @module attendance/attendance.controller
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
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import {
  GeneralAttendanceCountsDto,
  GeneralAttendanceQueryDto,
  RecordGeneralAttendanceDto,
} from './dto/general-attendance.dto';
import { AttendanceService } from './attendance.service';
import { CreateServiceDto } from './dto/create-service.dto';
import { UpdateServiceDto } from './dto/update-service.dto';
import { ListServicesDto } from './dto/list-services.dto';
import { ListAttendanceDto } from './dto/list-attendance.dto';
import { RecordAttendanceDto, RecordVisitorAttendanceDto } from './dto/record-attendance.dto';
import { RecordBulkAttendanceDto } from './dto/record-bulk-attendance.dto';
import { ServiceResponseDto } from './dto/service-response.dto';
import {
  AttendanceResponseDto,
  AttendanceSummaryDto,
  AttendanceTrendDto,
} from './dto/attendance-response.dto';
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

@ApiTags('Attendance')
@ApiBearerAuth('supabase-auth')
@UseGuards(JwtAuthGuard)
@Controller()
export class AttendanceController {
  constructor(private readonly attendanceService: AttendanceService) {}

  // ─── Service Endpoints ──────────────────────────────────

  @Post('services')
  @RequirePermissions('attendance:services:create')
  @HttpCode(HttpStatus.CREATED)
  @ApiCreateEndpoint('Create a service', 'Creates a new church service schedule.')
  async createService(
    @Body() dto: CreateServiceDto,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<ServiceResponseDto> {
    const churchId = req.profile?.church_id || '';
    return this.attendanceService.createService(dto, churchId, user.id, req.profile);
  }

  @Get('services')
  @RequirePermissions('attendance:services:read')
  @ApiPaginatedResponse(ServiceResponseDto)
  @ApiListEndpoint('List services', 'Retrieves a paginated list of church services.')
  async listServices(@Query() query: ListServicesDto, @Request() req: AuthenticatedRequest) {
    const churchId = req.profile?.church_id || '';
    const result = await this.attendanceService.listServices(churchId, query, req.profile);
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

  @Get('services/:serviceId')
  @RequirePermissions('attendance:services:read')
  @ApiGetEndpoint('Get service by ID', 'Retrieves a single service by its UUID.')
  async getServiceById(
    @Param('serviceId') serviceId: string,
    @Request() req: AuthenticatedRequest,
  ): Promise<ServiceResponseDto> {
    const churchId = req.profile?.church_id || '';
    return this.attendanceService.getServiceById(serviceId, churchId, req.profile);
  }

  @Patch('services/:serviceId')
  @RequirePermissions('attendance:services:update')
  @ApiUpdateEndpoint('Update a service', 'Updates a service with partial data.')
  async updateService(
    @Param('serviceId') serviceId: string,
    @Body() dto: UpdateServiceDto,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<ServiceResponseDto> {
    const churchId = req.profile?.church_id || '';
    return this.attendanceService.updateService(serviceId, dto, churchId, user.id);
  }

  @Delete('services/:serviceId')
  @RequirePermissions('attendance:services:delete')
  @HttpCode(HttpStatus.OK)
  @ApiDeleteEndpoint(
    'Delete a service',
    'Deletes a service. Blocked while attendance records reference it.',
  )
  async deleteService(
    @Param('serviceId') serviceId: string,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<{ success: boolean }> {
    const churchId = req.profile?.church_id || '';
    return this.attendanceService.deleteService(serviceId, churchId, user.id);
  }

  /**
   * Archive a service.
   */
  @Post('services/:serviceId/archive')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('attendance:services:update')
  @ApiUpdateEndpoint('Archive a service', 'Archives a service.')
  async archiveService(
    @Param('serviceId') serviceId: string,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<ServiceResponseDto> {
    const churchId = req.profile?.church_id || '';
    return this.attendanceService.archiveService(serviceId, churchId, user.id);
  }

  /**
   * Restore an archived service.
   */
  @Post('services/:serviceId/restore')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('attendance:services:update')
  @ApiUpdateEndpoint('Restore a service', 'Restores an archived service.')
  async restoreService(
    @Param('serviceId') serviceId: string,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<ServiceResponseDto> {
    const churchId = req.profile?.church_id || '';
    return this.attendanceService.restoreService(serviceId, churchId, user.id);
  }

  // ─── Attendance Endpoints ───────────────────────────────

  @Get('attendance')
  @RequirePermissions('attendance:records:read')
  @ApiPaginatedResponse(AttendanceResponseDto)
  @ApiOperation({
    summary: 'List attendance records',
    description:
      'Paginated check-in records with service/member/visitor filters, date range, and sorting.',
  })
  async listAttendance(@Query() query: ListAttendanceDto, @Request() req: AuthenticatedRequest) {
    const churchId = req.profile?.church_id || '';
    const result = await this.attendanceService.listAttendance(churchId, query, req.profile);
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

  @Post('attendance')
  @RequirePermissions('attendance:checkin:create')
  @HttpCode(HttpStatus.CREATED)
  @ApiCreateEndpoint('Record attendance', 'Records a single check-in for a service.')
  async recordAttendance(
    @Body() dto: RecordAttendanceDto,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<AttendanceResponseDto> {
    const churchId = req.profile?.church_id || '';
    return this.attendanceService.recordAttendance(dto, churchId, user.id);
  }

  @Post('attendance/bulk')
  @RequirePermissions('attendance:checkin:create')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Record bulk attendance',
    description: 'Records multiple check-ins for a single service. Duplicates are skipped.',
  })
  async recordBulkAttendance(
    @Body() dto: RecordBulkAttendanceDto,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<{
    recorded: number;
    skipped: number;
    errors: Array<{ index: number; message: string }>;
  }> {
    const churchId = req.profile?.church_id || '';
    return this.attendanceService.recordBulkAttendance(dto, churchId, user.id);
  }

  @Post('attendance/visitor')
  @RequirePermissions('attendance:checkin:create')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Record visitor attendance',
    description: 'Records attendance for a walk-in visitor by name.',
  })
  async recordVisitorAttendance(
    @Body() dto: RecordVisitorAttendanceDto,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<AttendanceResponseDto> {
    const churchId = req.profile?.church_id || '';
    return this.attendanceService.recordVisitorAttendance(dto, churchId, user.id);
  }

  @Post('attendance/general')
  @RequirePermissions('attendance:checkin:create')
  async recordGeneralAttendance(
    @Body() dto: RecordGeneralAttendanceDto,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.attendanceService.recordGeneralAttendance(
      dto,
      req.profile!.church_id,
      user.id,
      req.profile,
    );
  }

  @Get('attendance/general')
  @RequirePermissions('attendance:records:read')
  async listGeneralAttendance(
    @Query() query: GeneralAttendanceQueryDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.attendanceService.listGeneralAttendance(req.profile!.church_id, query, req.profile);
  }

  @Get('attendance/general/summary')
  @RequirePermissions('attendance:reports:read')
  async generalAttendanceSummary(
    @Query() query: GeneralAttendanceQueryDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.attendanceService.getGeneralAttendanceSummary(
      req.profile!.church_id,
      query,
      req.profile,
    );
  }

  @Patch('attendance/general/:id')
  @RequirePermissions('attendance:records:update')
  async updateGeneralAttendance(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: GeneralAttendanceCountsDto,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.attendanceService.updateGeneralAttendance(
      id,
      dto,
      req.profile!.church_id,
      user.id,
      req.profile,
    );
  }

  @Delete('attendance/:attendanceId')
  @RequirePermissions('attendance:records:delete')
  @HttpCode(HttpStatus.OK)
  @ApiDeleteEndpoint(
    'Delete an attendance record',
    'Removes a single check-in record (e.g. a mis-check-in).',
  )
  async deleteAttendance(
    @Param('attendanceId') attendanceId: string,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<{ success: boolean }> {
    const churchId = req.profile?.church_id || '';
    return this.attendanceService.deleteAttendance(attendanceId, churchId, user.id);
  }

  @Get('attendance/summary')
  @RequirePermissions('attendance:dashboard:read')
  @ApiOperation({
    summary: 'Get attendance summary',
    description: 'Returns total check-ins, member/visitor breakdown, and source breakdown.',
  })
  @ApiQuery({
    name: 'startDate',
    required: false,
    type: String,
    description: 'Start date (ISO 8601)',
  })
  @ApiQuery({ name: 'endDate', required: false, type: String, description: 'End date (ISO 8601)' })
  @ApiQuery({ name: 'branchId', required: false, type: String, description: 'Filter by branch ID' })
  async getAttendanceSummary(
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('branchId') branchId: string,
    @Request() req: AuthenticatedRequest,
  ): Promise<AttendanceSummaryDto> {
    const churchId = req.profile?.church_id || '';
    return this.attendanceService.getAttendanceSummary(
      churchId,
      startDate,
      endDate,
      branchId,
      req.profile,
    );
  }

  @Get('attendance/trends')
  @RequirePermissions('attendance:reports:read')
  @ApiOperation({
    summary: 'Get attendance trends',
    description: 'Returns daily attendance counts for the last N days.',
  })
  @ApiQuery({
    name: 'days',
    required: false,
    type: Number,
    description: 'Number of days (default 30)',
  })
  @ApiQuery({ name: 'branchId', required: false, type: String, description: 'Filter by branch ID' })
  @ApiQuery({
    name: 'startDate',
    required: false,
    type: String,
    description: 'Start date (ISO 8601): overrides the rolling days window when provided',
  })
  @ApiQuery({
    name: 'endDate',
    required: false,
    type: String,
    description: 'End date (ISO 8601): overrides the rolling days window when provided',
  })
  async getAttendanceTrends(
    @Query('days') days: number,
    @Query('branchId') branchId: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Request() req: AuthenticatedRequest,
  ): Promise<AttendanceTrendDto[]> {
    const churchId = req.profile?.church_id || '';
    return this.attendanceService.getAttendanceTrends(
      churchId,
      days || 30,
      branchId,
      startDate,
      endDate,
      req.profile,
    );
  }

  @Get('attendance/by-service/:serviceId')
  @RequirePermissions('attendance:services:read')
  @ApiGetEndpoint(
    'Get attendance by service',
    'Retrieves all attendance records for a specific service.',
  )
  async getAttendanceByService(
    @Param('serviceId') serviceId: string,
    @Request() req: AuthenticatedRequest,
  ): Promise<{ data: AttendanceResponseDto[]; total: number }> {
    const churchId = req.profile?.church_id || '';
    return this.attendanceService.getAttendanceByService(serviceId, churchId);
  }
}
