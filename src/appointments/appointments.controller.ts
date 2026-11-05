/**
 * @file appointments.controller.ts
 * @description HTTP endpoints for the appointment/booking registry.
 *
 * Provides create, list, detail, update, archive, restore, and permanent
 * delete for appointments, plus the With/Who participant pickers. All
 * endpoints are auth-protected and permission-gated by `appointments:*`.
 *
 * @module appointments/appointments.controller
 * @since 1.0.0
 */

import {
  Controller,
  Get,
  Post,
  Delete,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import {
  ApiGetEndpoint,
  ApiUpdateEndpoint,
  ApiDeleteEndpoint,
  ApiCreateEndpoint,
} from '../common/decorators/api-standard-responses.decorator';
import { AppointmentsService } from './appointments.service';
import { CreateAppointmentDto } from './dto/create-appointment.dto';
import { UpdateAppointmentDto } from './dto/update-appointment.dto';
import { ListAppointmentsDto } from './dto/list-appointments.dto';
import { ListAppointmentContactsDto } from './dto/list-appointment-contacts.dto';
import { AppointmentListEnvelopeDto, AppointmentContactDto } from './dto/appointment-response.dto';

@ApiTags('Appointments')
@ApiBearerAuth('supabase-auth')
@UseGuards(JwtAuthGuard)
@Controller('appointments')
export class AppointmentsController {
  constructor(private readonly appointmentsService: AppointmentsService) {}

  private getProfile(req: Record<string, unknown>): {
    church_id: string;
    id: string;
    is_admin_hq?: boolean;
    branch_id?: string | null;
    permissions?: string[];
  } {
    return req['profile'] as {
      church_id: string;
      id: string;
      is_admin_hq?: boolean;
      branch_id?: string | null;
      permissions?: string[];
    };
  }

  private getUserId(req: Record<string, unknown>): string {
    const user = req['user'] as { sub?: string; id?: string } | undefined;
    return user?.sub || user?.id || '';
  }

  /**
   * List participant contacts for the appointment With/Who pickers.
   * Declared before the `:appointmentId` param route to avoid shadowing.
   */
  @Get('contacts')
  @RequirePermissions('appointments:read')
  @ApiGetEndpoint(
    'List appointment contacts',
    'Lists selectable participants: kind "with" returns pastor-role profiles, kind "who" returns all profiles plus optional existing visitors, in scope.',
  )
  async listContacts(
    @Query() query: ListAppointmentContactsDto,
    @Request() req: Record<string, unknown>,
  ): Promise<{ data: AppointmentContactDto[]; total: number }> {
    const profile = this.getProfile(req);
    return this.appointmentsService.listContacts(profile.church_id, profile.id, query);
  }

  /**
   * List appointments in the current user's scope.
   */
  @Get()
  @RequirePermissions('appointments:read')
  @ApiGetEndpoint(
    'List appointments',
    'Lists appointments the current user is party to, with filters and pagination.',
  )
  async list(
    @Query() query: ListAppointmentsDto,
    @Request() req: Record<string, unknown>,
  ): Promise<AppointmentListEnvelopeDto> {
    const profile = this.getProfile(req);
    return this.appointmentsService.list(profile.church_id, profile.id, query, profile);
  }

  /**
   * Create a new appointment.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('appointments:create')
  @ApiCreateEndpoint('Create appointment', 'Creates a new appointment in the booking registry.')
  async create(
    @Body() dto: CreateAppointmentDto,
    @Request() req: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const profile = this.getProfile(req);
    const userId = this.getUserId(req);
    const appointment = await this.appointmentsService.create(
      dto,
      profile.church_id,
      profile.id,
      userId,
    );
    return { appointment };
  }

  /**
   * Get a single appointment the current user is party to.
   */
  @Get(':appointmentId')
  @RequirePermissions('appointments:read')
  @ApiGetEndpoint('Get appointment', 'Returns a single appointment the current user is party to.')
  async getOne(
    @Param('appointmentId') appointmentId: string,
    @Request() req: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const profile = this.getProfile(req);
    const appointment = await this.appointmentsService.getOne(
      appointmentId,
      profile.church_id,
      profile.id,
    );
    return { appointment };
  }

  /**
   * Update an appointment.
   */
  @Patch(':appointmentId')
  @RequirePermissions('appointments:update')
  @ApiUpdateEndpoint('Update appointment', 'Updates fields of an appointment.')
  async update(
    @Param('appointmentId') appointmentId: string,
    @Body() dto: UpdateAppointmentDto,
    @Request() req: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const profile = this.getProfile(req);
    const userId = this.getUserId(req);
    const appointment = await this.appointmentsService.update(
      appointmentId,
      dto,
      profile.church_id,
      profile.id,
      userId,
    );
    return { appointment };
  }

  /**
   * Archive an appointment (soft-hide from active lists).
   */
  @Post(':appointmentId/archive')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('appointments:update')
  @ApiUpdateEndpoint('Archive appointment', 'Archives an appointment.')
  async archive(
    @Param('appointmentId') appointmentId: string,
    @Request() req: Record<string, unknown>,
  ): Promise<{ success: boolean }> {
    const profile = this.getProfile(req);
    const userId = this.getUserId(req);
    return this.appointmentsService.archive(appointmentId, profile.church_id, profile.id, userId);
  }

  /**
   * Restore an archived appointment back to the active list.
   */
  @Post(':appointmentId/restore')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('appointments:update')
  @ApiUpdateEndpoint('Restore appointment', 'Restores an archived appointment.')
  async restore(
    @Param('appointmentId') appointmentId: string,
    @Request() req: Record<string, unknown>,
  ): Promise<{ success: boolean }> {
    const profile = this.getProfile(req);
    const userId = this.getUserId(req);
    return this.appointmentsService.restore(appointmentId, profile.church_id, profile.id, userId);
  }

  /**
   * Permanently delete an archived appointment.
   */
  @Delete(':appointmentId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('appointments:delete')
  @ApiDeleteEndpoint(
    'Permanently delete',
    'Permanently deletes an archived appointment (cannot be undone).',
  )
  async deleteForever(
    @Param('appointmentId') appointmentId: string,
    @Request() req: Record<string, unknown>,
  ): Promise<{ success: boolean }> {
    const profile = this.getProfile(req);
    const userId = this.getUserId(req);
    return this.appointmentsService.deleteForever(
      appointmentId,
      profile.church_id,
      profile.id,
      userId,
    );
  }
}
