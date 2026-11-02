import {
  attendanceConflict,
  attendanceVisitorName,
  isAttendanceDuplicate,
  visitorAlreadyAttended,
} from './attendance-duplicates';
import { attendanceDay } from './attendance-day';
import {
  assertEventOccursOn,
  assertServiceOccursOn,
  assertServiceSchedule,
} from './schedule-occurrence';
import { serviceTimeForStorage, serviceTimeForResponse } from './service-time';
import { attendanceSessionId } from './attendance-session-links';
import { AttendanceSessionsService } from './attendance-sessions.service';
import { RequestContextService } from '../common/services/request-context.service';
/**
 * @file attendance.service.ts
 * @description Business logic for attendance and service management.
 *
 * Handles service CRUD, single/bulk check-in recording, attendance
 * summaries, trends, and visitor attendance. All queries are scoped
 * by church_id for multi-tenant data isolation.
 *
 * @module attendance/attendance.service
 * @since 1.0.0
 */

import {
  Injectable,
  ForbiddenException,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLoggingService } from '../common/services/audit-logging.service';
import { BranchScopeService, ViewerScope } from '../common/services/branch-scope.service';
import { CreateServiceDto, defaultAttendanceCategory } from './dto/create-service.dto';
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
import { Prisma } from '@prisma/client';
import {
  GeneralAttendanceCountsDto,
  GeneralAttendanceQueryDto,
  RecordGeneralAttendanceDto,
} from './dto/general-attendance.dto';

@Injectable()
export class AttendanceService extends AttendanceSessionsService {
  private readonly logger = new Logger(AttendanceService.name);

  constructor(
    prisma: PrismaService,
    requestContext: RequestContextService,
    audit: AuditLoggingService,
    branchScope: BranchScopeService,
  ) {
    super(prisma, requestContext, audit, branchScope);
  }

  // ─── Service CRUD ──────────────────────────────────────

  async createService(
    dto: CreateServiceDto,
    churchId: string,
    userId: string,
    viewer?: ViewerScope | null,
  ): Promise<ServiceResponseDto> {
    const scope = this.branchScope.resolve(viewer);
    const branchId = scope.churchOnly ? dto.branchId || null : scope.branchId || null;
    if (!scope.churchOnly) {
      if (!branchId || branchId === '00000000-0000-0000-0000-000000000000')
        throw new ForbiddenException('A branch assignment is required');
      if (dto.branchId && dto.branchId !== branchId)
        throw new ForbiddenException('You can only create services in your branch');
    }
    if (branchId) {
      const branch = await this.prisma.branch.findFirst({
        where: { id: branchId, church_id: churchId, archived_at: null },
        select: { id: true },
      });
      if (!branch) throw new BadRequestException('Select an active branch in this church');
    }
    const schedule = assertServiceSchedule({
      recurrence: dto.recurrence,
      startsOn: dto.startsOn,
      endsOn: dto.endsOn,
    });
    const service = await this.prisma.service.create({
      data: {
        church_id: churchId,
        branch_id: branchId,
        name: dto.name,
        category: dto.category ?? 'adult',
        day_of_week: dto.dayOfWeek ?? null,
        recurrence: schedule.recurrence,
        starts_on: schedule.startsOn,
        ends_on: schedule.endsOn,
        start_time: serviceTimeForStorage(dto.startTime),
        end_time: serviceTimeForStorage(dto.endTime),
        is_active: dto.isActive ?? true,
      },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'service',
      action: 'CREATE',
      entityId: service.id,
      newValues: {
        name: dto.name,
        dayOfWeek: dto.dayOfWeek,
        recurrence: schedule.recurrence,
        startsOn: dto.startsOn,
        endsOn: dto.endsOn,
        branchId,
      },
    });

    this.logger.log(`Service created: ${service.name} (${service.id})`);

    return this.mapToServiceResponse(service);
  }

  async getServiceById(
    id: string,
    churchId: string,
    viewer?: ViewerScope | null,
  ): Promise<ServiceResponseDto> {
    const service = await this.prisma.service.findUnique({
      where: { id },
      include: { _count: { select: { attendance: true } } },
    });

    if (
      !service ||
      service.church_id !== churchId ||
      !this.branchScope.isVisible(undefined, service.branch_id)
    ) {
      throw new NotFoundException('Service not found');
    }

    if (!this.branchScope.isVisible(viewer, service.branch_id)) {
      throw new NotFoundException('Service not found');
    }

    return this.mapToServiceResponse(service);
  }

  async listServices(
    churchId: string,
    query: ListServicesDto,
    viewer?: ViewerScope | null,
  ): Promise<{ data: ServiceResponseDto[]; total: number }> {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    const where: Prisma.ServiceWhereInput = {
      church_id: churchId,
      archived_at: query.archived === true ? { not: null } : null,
    };

    // Scoped to the viewer's own branch unless they hold the admin-hq override.
    const scope = this.branchScope.resolve(viewer);
    if (!scope.churchOnly) {
      where.branch_id = scope.branchId ?? null;
    } else if (query.branchId && scope.churchOnly) {
      where.branch_id = query.branchId;
    }

    if (query.category) {
      where.category = query.category;
    }

    if (query.isActive !== undefined) {
      where.is_active = query.isActive;
    }

    if (query.dayOfWeek !== undefined) {
      where.day_of_week = query.dayOfWeek;
    }

    const orderBy: Prisma.ServiceOrderByWithRelationInput[] = [];
    if (query.sortBy) {
      orderBy.push({ [query.sortBy]: (query.sortOrder || 'asc') as Prisma.SortOrder });
    } else {
      orderBy.push({ day_of_week: 'asc' });
      orderBy.push({ name: 'asc' });
    }

    const services = await this.prisma.service.findMany({
      where,
      orderBy,
      skip,
      take: limit,
      include: { _count: { select: { attendance: true } } },
    });
    const total = await this.prisma.service.count({ where });

    return {
      data: services.map((s) => this.mapToServiceResponse(s)),
      total,
    };
  }

  async updateService(
    id: string,
    dto: UpdateServiceDto,
    churchId: string,
    userId: string,
  ): Promise<ServiceResponseDto> {
    const existing = await this.prisma.service.findUnique({ where: { id } });

    if (
      !existing ||
      existing.church_id !== churchId ||
      !this.branchScope.isVisible(undefined, existing.branch_id)
    ) {
      throw new NotFoundException('Service not found');
    }

    if (existing.archived_at) {
      throw new NotFoundException('Service is archived');
    }

    const updateData: Prisma.ServiceUpdateInput = {};

    if (dto.name !== undefined) updateData.name = dto.name;
    if (dto.category !== undefined) updateData.category = dto.category;
    if (dto.branchId !== undefined) {
      const branchId = this.requestContext.branchIdForWrite(churchId, dto.branchId);
      if (branchId) {
        const branch = await this.prisma.branch.findFirst({
          where: { id: branchId, church_id: churchId, archived_at: null },
          select: { id: true },
        });
        if (!branch) throw new BadRequestException('Select an active branch in this church');
      }
      updateData.branch = branchId ? { connect: { id: branchId } } : { disconnect: true };
    }
    if (dto.dayOfWeek !== undefined) updateData.day_of_week = dto.dayOfWeek;
    if (dto.startTime !== undefined) updateData.start_time = serviceTimeForStorage(dto.startTime);
    if (dto.endTime !== undefined) updateData.end_time = serviceTimeForStorage(dto.endTime);
    if (dto.isActive !== undefined) updateData.is_active = dto.isActive;

    const scheduleTouched =
      dto.recurrence !== undefined || dto.startsOn !== undefined || dto.endsOn !== undefined;
    if (scheduleTouched) {
      const schedule = assertServiceSchedule({
        recurrence: dto.recurrence ?? existing.recurrence,
        startsOn: dto.startsOn !== undefined ? dto.startsOn : existing.starts_on,
        endsOn: dto.endsOn !== undefined ? dto.endsOn : existing.ends_on,
      });
      updateData.recurrence = schedule.recurrence;
      updateData.starts_on = schedule.startsOn;
      updateData.ends_on = schedule.endsOn;
    }

    if (Object.keys(updateData).length === 0) {
      return this.mapToServiceResponse(existing);
    }

    const service = await this.prisma.service.update({
      where: { id },
      data: updateData,
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'service',
      action: 'UPDATE',
      entityId: id,
      oldValues: {
        name: existing.name,
        isActive: existing.is_active,
        branchId: existing.branch_id,
      },
      newValues: updateData,
    });

    this.logger.log(`Service updated: ${id}`);

    return this.mapToServiceResponse(service);
  }

  async deleteService(id: string, churchId: string, userId: string): Promise<{ success: boolean }> {
    const existing = await this.prisma.service.findUnique({ where: { id } });

    if (
      !existing ||
      existing.church_id !== churchId ||
      !this.branchScope.isVisible(undefined, existing.branch_id)
    ) {
      throw new NotFoundException('Service not found');
    }

    const attendanceCount = await this.prisma.attendance.count({
      where: { service_id: id },
    });

    const transactionCount = await this.prisma.transaction.count({
      where: { service_id: id },
    });

    const generalAttendanceCount = await this.prisma.attendanceSession.count({
      where: { service_id: id, church_id: churchId },
    });
    if (generalAttendanceCount > 0) {
      throw new ConflictException(
        'Cannot delete a service with general attendance history. Archive it instead.',
      );
    }
    if (attendanceCount > 0 || transactionCount > 0) {
      throw new ConflictException(
        `Cannot delete this service: ${attendanceCount} attendance record(s) and ${transactionCount} giving transaction(s) reference it. Remove those records first.`,
      );
    }

    await this.prisma.service.delete({ where: { id } });

    await this.audit.log({
      userId,
      churchId,
      entity: 'service',
      action: 'DELETE',
      entityId: id,
      oldValues: { name: existing.name, isActive: existing.is_active },
    });

    this.logger.log(`Service deleted: ${existing.name} (${id})`);

    return { success: true };
  }

  /**
   * Archives a service by setting archived_at. Archived services drop out of
   * the active service list (listServices filters archived_at: null) but their
   * details stay reachable by ID and they can be restored.
   *
   * @param id - Service UUID
   * @param churchId - Church UUID for tenant scoping
   * @param userId - Acting user ID for audit logging
   * @returns Updated ServiceResponseDto
   * @throws NotFoundException if the service is missing or not in this church
   * @throws ConflictException if the service is already archived
   */
  async archiveService(id: string, churchId: string, userId: string): Promise<ServiceResponseDto> {
    const existing = await this.prisma.service.findUnique({ where: { id } });

    if (
      !existing ||
      existing.church_id !== churchId ||
      !this.branchScope.isVisible(undefined, existing.branch_id)
    ) {
      throw new NotFoundException('Service not found');
    }

    if (existing.archived_at) {
      throw new ConflictException('Service is already archived');
    }

    const service = await this.prisma.service.update({
      where: { id },
      data: { archived_at: new Date() },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'service',
      action: 'ARCHIVE',
      entityId: id,
      oldValues: { archived_at: existing.archived_at },
      newValues: { archived_at: service.archived_at },
    });

    this.logger.log(`Service archived: ${id}`);
    return this.mapToServiceResponse(service);
  }

  /**
   * Restores an archived service by clearing archived_at.
   *
   * @param id - Service UUID
   * @param churchId - Church UUID for tenant scoping
   * @param userId - Acting user ID for audit logging
   * @returns Updated ServiceResponseDto
   * @throws NotFoundException if the service is missing or not in this church
   * @throws ConflictException if the service is not currently archived
   */
  async restoreService(id: string, churchId: string, userId: string): Promise<ServiceResponseDto> {
    const existing = await this.prisma.service.findUnique({ where: { id } });

    if (
      !existing ||
      existing.church_id !== churchId ||
      !this.branchScope.isVisible(undefined, existing.branch_id)
    ) {
      throw new NotFoundException('Service not found');
    }

    if (!existing.archived_at) {
      throw new ConflictException('Service is not archived');
    }

    const service = await this.prisma.service.update({
      where: { id },
      data: { archived_at: null },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'service',
      action: 'RESTORE',
      entityId: id,
      oldValues: { archived_at: existing.archived_at },
      newValues: { archived_at: null },
    });

    this.logger.log(`Service restored: ${id}`);
    return this.mapToServiceResponse(service);
  }

  // ─── Attendance Recording ───────────────────────────────

  async recordAttendance(
    dto: RecordAttendanceDto,
    churchId: string,
    userId: string,
  ): Promise<AttendanceResponseDto> {
    if (Number(!!dto.serviceId) + Number(!!dto.eventId) !== 1)
      throw new BadRequestException('Select exactly one service or event');
    if (!dto.memberId && !dto.visitorName && !dto.visitorId) {
      throw new BadRequestException('Either memberId, visitorId, or visitorName must be provided');
    }

    if (!dto.serviceId && !dto.eventId) {
      throw new BadRequestException('Either serviceId or eventId must be provided');
    }

    const { checkedInAt, attendanceDate } = attendanceDay(dto.attendanceDate);
    const dateKey = attendanceDate.toISOString().slice(0, 10);
    let serviceCategory: string | null = null;
    let parentBranch: string | null | undefined;

    if (dto.eventId) {
      const event = await this.prisma.event.findFirst({
        where: { id: dto.eventId, church_id: churchId },
        select: {
          id: true,
          title: true,
          branch_id: true,
          recurrence: true,
          start_date: true,
          end_date: true,
        },
      });
      parentBranch = event?.branch_id;
      if (!event) {
        throw new NotFoundException('Event not found');
      }
      assertEventOccursOn(event.title, event, dateKey);
    } else {
      const service = await this.prisma.service.findUnique({
        where: { id: dto.serviceId },
      });
      if (
        !service ||
        service.church_id !== churchId ||
        !this.branchScope.isVisible(undefined, service.branch_id)
      ) {
        throw new NotFoundException('Service not found');
      }
      assertServiceOccursOn(service.name, service, dateKey);
      serviceCategory = service.category;
      parentBranch = service.branch_id;
    }

    if (dto.memberId) {
      const member = await this.prisma.member.findUnique({
        where: { id: dto.memberId },
      });

      if (!member || member.church_id !== churchId) {
        throw new NotFoundException('Member not found');
      }
    }

    let linkedVisitorName: string | null = null;
    if (dto.visitorId) {
      const visitor = await this.prisma.visitor.findUnique({
        where: { id: dto.visitorId },
        select: { id: true, church_id: true, first_name: true, last_name: true },
      });

      if (!visitor || visitor.church_id !== churchId) {
        throw new NotFoundException('Visitor not found');
      }

      linkedVisitorName = [visitor.first_name, visitor.last_name].filter(Boolean).join(' ');
    }

    if (dto.memberId) {
      if (dto.eventId) {
        const existing = await this.prisma.attendance.findUnique({
          where: {
            event_id_member_id: {
              event_id: dto.eventId,
              member_id: dto.memberId,
            },
          },
        });
        if (existing) {
          throw new ConflictException('Member already checked in for this event');
        }
      } else {
        const existing = await this.prisma.attendance.findUnique({
          where: {
            service_id_member_id_attendance_date: {
              attendance_date: attendanceDate,
              service_id: dto.serviceId!,
              member_id: dto.memberId,
            },
          },
        });
        if (existing) {
          throw new ConflictException('Member already checked in for this service');
        }
      }
    }

    if (
      !dto.memberId &&
      (await visitorAlreadyAttended(this.prisma, churchId, dto, dto, attendanceDate))
    )
      throw new ConflictException('Visitor already checked in for this event or service date');

    const category = dto.category ?? defaultAttendanceCategory(serviceCategory);

    const sessionId = await attendanceSessionId(
      this.prisma,
      dto.eventId ? 'event' : 'service',
      dto.eventId ?? dto.serviceId!,
      churchId,
      checkedInAt,
      parentBranch,
      this.requestContext.getStore()?.viewer,
    );
    const attendance = await this.prisma.attendance
      .create({
        data: {
          checkin_at: checkedInAt,
          attendance_date: attendanceDate,
          ...(sessionId ? { session_id: sessionId } : {}),
          church_id: churchId,
          service_id: dto.serviceId || null,
          event_id: dto.eventId || null,
          member_id: dto.memberId || null,
          visitor_id: dto.visitorId || null,
          visitor_name: attendanceVisitorName(dto.visitorName) || linkedVisitorName,
          category,
          source: dto.source || 'manual',
        },
        include: {
          service: { select: { name: true } },
          event: { select: { title: true } },
          member: { select: { first_name: true, last_name: true } },
        },
      })
      .catch(attendanceConflict);

    await this.audit.log({
      userId,
      churchId,
      entity: 'attendance',
      action: 'CREATE',
      entityId: attendance.id,
      newValues: {
        serviceId: dto.serviceId,
        eventId: dto.eventId,
        memberId: dto.memberId,
        visitorName: dto.visitorName,
        source: dto.source,
      },
    });

    this.logger.log(`Attendance recorded: ${attendance.id}`);

    return this.mapToAttendanceResponse(attendance);
  }

  async recordBulkAttendance(
    dto: RecordBulkAttendanceDto,
    churchId: string,
    userId: string,
  ): Promise<{
    recorded: number;
    skipped: number;
    errors: Array<{ index: number; message: string }>;
  }> {
    if (Number(!!dto.serviceId) + Number(!!dto.eventId) !== 1)
      throw new BadRequestException('Select exactly one service or event');
    const { checkedInAt, attendanceDate } = attendanceDay(dto.attendanceDate);
    const dateKey = attendanceDate.toISOString().slice(0, 10);
    let serviceCategory: string | null = null;
    let parentBranch: string | null | undefined;

    if (dto.eventId) {
      const event = await this.prisma.event.findFirst({
        where: { id: dto.eventId, church_id: churchId },
        select: {
          id: true,
          title: true,
          branch_id: true,
          recurrence: true,
          start_date: true,
          end_date: true,
        },
      });
      parentBranch = event?.branch_id;
      if (!event) {
        throw new NotFoundException('Event not found');
      }
      assertEventOccursOn(event.title, event, dateKey);
    } else {
      const service = await this.prisma.service.findUnique({
        where: { id: dto.serviceId },
      });
      if (
        !service ||
        service.church_id !== churchId ||
        !this.branchScope.isVisible(undefined, service.branch_id)
      ) {
        throw new NotFoundException('Service not found');
      }
      assertServiceOccursOn(service.name, service, dateKey);
      serviceCategory = service.category;
      parentBranch = service.branch_id;
    }

    const sessionId = await attendanceSessionId(
      this.prisma,
      dto.eventId ? 'event' : 'service',
      dto.eventId ?? dto.serviceId!,
      churchId,
      checkedInAt,
      parentBranch,
      this.requestContext.getStore()?.viewer,
    );
    let recorded = 0;
    let skipped = 0;
    const errors: Array<{ index: number; message: string }> = [];

    for (let i = 0; i < dto.records.length; i++) {
      const record = dto.records[i];

      if (!record.memberId && !record.visitorName && !record.visitorId) {
        errors.push({
          index: i,
          message: 'Either memberId, visitorId, or visitorName must be provided',
        });
        continue;
      }

      try {
        let linkedVisitorName: string | null = null;
        if (record.visitorId) {
          const visitor = await this.prisma.visitor.findFirst({
            where: { id: record.visitorId, church_id: churchId },
            select: { first_name: true, last_name: true },
          });

          if (!visitor) {
            errors.push({ index: i, message: 'Visitor not found in this church' });
            continue;
          }

          linkedVisitorName = [visitor.first_name, visitor.last_name].filter(Boolean).join(' ');
        }

        if (record.memberId) {
          const member = await this.prisma.member.findFirst({
            where: { id: record.memberId, church_id: churchId },
            select: { id: true },
          });

          if (!member) {
            errors.push({ index: i, message: 'Member not found in this church' });
            continue;
          }

          if (dto.eventId) {
            const existing = await this.prisma.attendance.findUnique({
              where: {
                event_id_member_id: {
                  event_id: dto.eventId,
                  member_id: record.memberId,
                },
              },
            });
            if (existing) {
              skipped++;
              continue;
            }
          } else {
            const existing = await this.prisma.attendance.findUnique({
              where: {
                service_id_member_id_attendance_date: {
                  attendance_date: attendanceDate,
                  service_id: dto.serviceId!,
                  member_id: record.memberId,
                },
              },
            });
            if (existing) {
              skipped++;
              continue;
            }
          }
        }

        if (
          !record.memberId &&
          (await visitorAlreadyAttended(this.prisma, churchId, dto, record, attendanceDate))
        ) {
          skipped++;
          continue;
        }

        await this.prisma.attendance.create({
          data: {
            checkin_at: checkedInAt,
            attendance_date: attendanceDate,
            ...(sessionId ? { session_id: sessionId } : {}),
            church_id: churchId,
            service_id: dto.serviceId || null,
            event_id: dto.eventId || null,
            member_id: record.memberId || null,
            visitor_id: record.visitorId || null,
            visitor_name: attendanceVisitorName(record.visitorName) || linkedVisitorName,
            category: dto.category ?? defaultAttendanceCategory(serviceCategory),
            source: dto.source || 'manual',
          },
        });

        recorded++;
      } catch (error) {
        if (isAttendanceDuplicate(error)) {
          skipped++;
          continue;
        }
        errors.push({
          index: i,
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    if (recorded > 0) {
      await this.audit.log({
        userId,
        churchId,
        entity: 'attendance',
        action: 'CREATE',
        entityId: 'bulk',
        newValues: {
          serviceId: dto.serviceId,
          eventId: dto.eventId,
          recorded,
          skipped,
          errorCount: errors.length,
          attendanceDate: attendanceDate.toISOString().slice(0, 10),
        },
      });
    }

    this.logger.log(
      `Bulk attendance: ${recorded} recorded, ${skipped} skipped, ${errors.length} errors`,
    );

    return { recorded, skipped, errors };
  }

  async recordVisitorAttendance(
    dto: RecordVisitorAttendanceDto,
    churchId: string,
    userId: string,
  ): Promise<AttendanceResponseDto> {
    if (Number(!!dto.serviceId) + Number(!!dto.eventId) !== 1)
      throw new BadRequestException('Select exactly one service or event');
    if (!dto.visitorName || dto.visitorName.trim().length === 0) {
      throw new BadRequestException('Visitor name is required');
    }

    const { checkedInAt, attendanceDate } = attendanceDay(dto.attendanceDate);
    const dateKey = attendanceDate.toISOString().slice(0, 10);
    let serviceCategory: string | null = null;
    let parentBranch: string | null | undefined;

    if (dto.eventId) {
      const event = await this.prisma.event.findFirst({
        where: { id: dto.eventId, church_id: churchId },
        select: {
          id: true,
          title: true,
          branch_id: true,
          recurrence: true,
          start_date: true,
          end_date: true,
        },
      });
      parentBranch = event?.branch_id;
      if (!event) {
        throw new NotFoundException('Event not found');
      }
      assertEventOccursOn(event.title, event, dateKey);
    } else {
      const service = await this.prisma.service.findUnique({
        where: { id: dto.serviceId },
      });
      if (
        !service ||
        service.church_id !== churchId ||
        !this.branchScope.isVisible(undefined, service.branch_id)
      ) {
        throw new NotFoundException('Service not found');
      }
      assertServiceOccursOn(service.name, service, dateKey);
      serviceCategory = service.category;
      parentBranch = service.branch_id;
    }

    if (dto.visitorId) {
      const visitor = await this.prisma.visitor.findFirst({
        where: { id: dto.visitorId, church_id: churchId },
        select: { id: true },
      });

      if (!visitor) {
        throw new NotFoundException('Visitor not found');
      }
    }

    if (await visitorAlreadyAttended(this.prisma, churchId, dto, dto, attendanceDate))
      throw new ConflictException('Visitor already checked in for this event or service date');

    const sessionId = await attendanceSessionId(
      this.prisma,
      dto.eventId ? 'event' : 'service',
      dto.eventId ?? dto.serviceId!,
      churchId,
      checkedInAt,
      parentBranch,
      this.requestContext.getStore()?.viewer,
    );
    const attendance = await this.prisma.attendance
      .create({
        data: {
          checkin_at: checkedInAt,
          attendance_date: attendanceDate,
          ...(sessionId ? { session_id: sessionId } : {}),
          church_id: churchId,
          service_id: dto.serviceId || null,
          event_id: dto.eventId || null,
          visitor_id: dto.visitorId || null,
          visitor_name: attendanceVisitorName(dto.visitorName),
          category: dto.category ?? defaultAttendanceCategory(serviceCategory),
          source: dto.source || 'manual',
        },
        include: {
          service: { select: { name: true } },
          event: { select: { title: true } },
        },
      })
      .catch(attendanceConflict);

    await this.audit.log({
      userId,
      churchId,
      entity: 'attendance',
      action: 'CREATE',
      entityId: attendance.id,
      newValues: { visitorName: dto.visitorName, source: dto.source },
    });

    this.logger.log(`Visitor attendance recorded: ${dto.visitorName} (${attendance.id})`);

    return this.mapToAttendanceResponse(attendance);
  }

  async deleteAttendance(
    attendanceId: string,
    churchId: string,
    userId: string,
  ): Promise<{ success: boolean }> {
    const existing = await this.prisma.attendance.findUnique({
      where: { id: attendanceId },
    });

    if (!existing || existing.church_id !== churchId) {
      throw new NotFoundException('Attendance record not found');
    }

    await this.prisma.attendance.delete({ where: { id: attendanceId } });

    await this.audit.log({
      userId,
      churchId,
      entity: 'attendance',
      action: 'DELETE',
      entityId: attendanceId,
      oldValues: {
        serviceId: existing.service_id,
        memberId: existing.member_id,
        visitorName: existing.visitor_name,
      },
    });

    this.logger.log(`Attendance deleted: ${attendanceId}`);

    return { success: true };
  }

  // ─── Queries & Analytics ────────────────────────────────

  async listAttendance(
    churchId: string,
    query: ListAttendanceDto,
    viewer?: ViewerScope | null,
  ): Promise<{ data: AttendanceResponseDto[]; total: number }> {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    const where: Prisma.AttendanceWhereInput = { church_id: churchId };
    if (viewer?.permissions && !viewer.permissions.includes('events:checkin:read')) {
      where.event_id = null;
    }

    // Attendance rows have no branch column — their branch comes from the linked
    // service/event. Restrict non-HQ viewers to records whose service OR event
    // belongs to their branch.
    const scope = this.branchScope.resolve(viewer);
    if (!scope.churchOnly) {
      where.AND = [
        {
          OR: [
            { service: { branch_id: scope.branchId ?? null } },
            { event: { branch_id: scope.branchId ?? null } },
          ],
        },
      ];
    } else if (scope.churchOnly && query.branchId) {
      where.AND = [
        {
          OR: [
            { service: { branch_id: query.branchId } },
            { event: { branch_id: query.branchId } },
          ],
        },
      ];
    }

    if (query.serviceId) where.service_id = query.serviceId;
    if (query.eventId) {
      if (viewer?.permissions && !viewer.permissions.includes('events:checkin:read'))
        throw new ForbiddenException('Event check-in access is required');
      where.event_id = query.eventId;
    }
    if (query.memberId) where.member_id = query.memberId;
    if (query.visitorId) where.visitor_id = query.visitorId;
    if (query.category) where.category = query.category;
    if (query.source) where.source = query.source;

    if (query.startDate || query.endDate) {
      where.checkin_at = {};
      if (query.startDate) where.checkin_at.gte = new Date(query.startDate);
      if (query.endDate) where.checkin_at.lte = new Date(query.endDate);
    }

    const sortField = query.sortBy === 'createdAt' ? 'created_at' : 'checkin_at';
    const order = (query.sortOrder || 'desc') as Prisma.SortOrder;

    const [records, total] = await Promise.all([
      this.prisma.attendance.findMany({
        where,
        orderBy: { [sortField]: order },
        skip,
        take: limit,
        include: {
          service: { select: { name: true } },
          event: { select: { title: true } },
          member: { select: { first_name: true, last_name: true } },
          visitor: { select: { first_name: true, last_name: true } },
        },
      }),
      this.prisma.attendance.count({ where }),
    ]);

    return {
      data: records.map((r) => this.mapToAttendanceResponse(r)),
      total,
    };
  }

  async getAttendanceByService(
    serviceId: string,
    churchId: string,
  ): Promise<{ data: AttendanceResponseDto[]; total: number }> {
    const service = await this.prisma.service.findUnique({
      where: { id: serviceId },
    });

    if (
      !service ||
      service.church_id !== churchId ||
      !this.branchScope.isVisible(undefined, service.branch_id)
    ) {
      throw new NotFoundException('Service not found');
    }

    const [records, total] = await Promise.all([
      this.prisma.attendance.findMany({
        where: { service_id: serviceId, church_id: churchId },
        orderBy: { checkin_at: 'desc' },
        include: {
          service: { select: { name: true } },
          member: { select: { first_name: true, last_name: true } },
          visitor: { select: { first_name: true, last_name: true } },
        },
      }),
      this.prisma.attendance.count({
        where: { service_id: serviceId, church_id: churchId },
      }),
    ]);

    return {
      data: records.map((r) => this.mapToAttendanceResponse(r)),
      total,
    };
  }

  async recordGeneralAttendance(
    dto: RecordGeneralAttendanceDto,
    churchId: string,
    userId: string,
    viewer?: ViewerScope | null,
  ) {
    return this.recordSession('service', dto.serviceId, dto, churchId, userId, viewer);
  }
  async updateGeneralAttendance(
    id: string,
    dto: GeneralAttendanceCountsDto,
    churchId: string,
    userId: string,
    viewer?: ViewerScope | null,
  ) {
    return this.updateSession('service', undefined, id, dto, churchId, userId, viewer);
  }
  async listGeneralAttendance(
    churchId: string,
    query: GeneralAttendanceQueryDto,
    viewer?: ViewerScope | null,
  ) {
    return this.listSessions('service', query.serviceId, churchId, query, viewer);
  }
  async getGeneralAttendanceSummary(
    churchId: string,
    query: GeneralAttendanceQueryDto = {},
    viewer?: ViewerScope | null,
  ) {
    return this.sessionSummary('service', query.serviceId, churchId, query, viewer);
  }

  async getAttendanceSummary(
    churchId: string,
    startDate?: string,
    endDate?: string,
    branchId?: string,
    viewer?: ViewerScope | null,
  ): Promise<AttendanceSummaryDto> {
    const where: Prisma.AttendanceWhereInput = { church_id: churchId };
    if (viewer?.permissions && !viewer.permissions.includes('events:checkin:read'))
      where.event_id = null;
    const scope = this.branchScope.resolve(viewer);
    const effectiveBranchId = scope.churchOnly ? branchId : scope.branchId;

    if (startDate || endDate) {
      where.checkin_at = {};
      if (startDate) where.checkin_at.gte = new Date(startDate);
      if (endDate) where.checkin_at.lte = new Date(endDate);
    }

    if (!scope.churchOnly || effectiveBranchId) {
      where.OR = [
        { service: { branch_id: effectiveBranchId ?? null } },
        { event: { branch_id: effectiveBranchId ?? null } },
      ];
    }

    const [totalCheckIns, memberCheckIns, visitorCheckIns, bySourceRaw, byCategoryRaw, genderRows] =
      await Promise.all([
        this.prisma.attendance.count({ where }),
        this.prisma.attendance.count({ where: { ...where, member_id: { not: null } } }),
        this.prisma.attendance.count({ where: { ...where, member_id: null } }),
        this.prisma.attendance.groupBy({
          by: ['source'],
          where,
          _count: { id: true },
        }),
        this.prisma.attendance.groupBy({
          by: ['category'],
          where,
          _count: { id: true },
        }),
        // Gender is derived from the linked member/visitor records — never stored
        // on the check-in itself. Legacy rows without links count as unknown.
        this.prisma.attendance.findMany({
          where,
          select: {
            member: { select: { gender: true } },
            visitor: { select: { gender: true } },
          },
        }),
      ]);

    const bySource: Record<string, number> = {};
    for (const item of bySourceRaw) {
      bySource[item.source] = item._count.id;
    }

    const byCategory: Record<string, number> = {};
    for (const item of byCategoryRaw) {
      byCategory[item.category] = item._count.id;
    }

    const byGender: Record<string, number> = { male: 0, female: 0, unknown: 0 };
    for (const row of genderRows) {
      const gender = (row.member?.gender || row.visitor?.gender || '').toLowerCase();
      if (gender === 'male') byGender.male++;
      else if (gender === 'female') byGender.female++;
      else byGender.unknown++;
    }

    const generalAttendance = await this.getGeneralAttendanceSummary(
      churchId,
      { startDate: startDate?.slice(0, 10), endDate: endDate?.slice(0, 10), branchId },
      viewer,
    );
    return {
      totalCheckIns,
      memberCheckIns,
      visitorCheckIns,
      bySource,
      byCategory,
      byGender,
      ...(generalAttendance.reportCount ? { generalAttendance } : {}),
    };
  }

  async getAttendanceTrends(
    churchId: string,
    days = 30,
    branchId?: string,
    startDate?: string,
    endDate?: string,
    viewer?: ViewerScope | null,
  ): Promise<AttendanceTrendDto[]> {
    // Explicit range wins over the rolling N-day window.
    const checkinAt: Prisma.DateTimeFilter = {};
    if (startDate || endDate) {
      if (startDate) checkinAt.gte = new Date(startDate);
      if (endDate) checkinAt.lte = new Date(endDate);
    } else {
      const windowStart = new Date();
      windowStart.setDate(windowStart.getDate() - days);
      checkinAt.gte = windowStart;
    }

    const where: Prisma.AttendanceWhereInput = {
      church_id: churchId,
      checkin_at: checkinAt,
    };
    if (viewer?.permissions && !viewer.permissions.includes('events:checkin:read'))
      where.event_id = null;
    const scope = this.branchScope.resolve(viewer);
    const effectiveBranchId = scope.churchOnly ? branchId : scope.branchId;

    if (!scope.churchOnly || effectiveBranchId) {
      where.OR = [
        { service: { branch_id: effectiveBranchId ?? null } },
        { event: { branch_id: effectiveBranchId ?? null } },
      ];
    }

    const records = await this.prisma.attendance.findMany({
      where,
      orderBy: { checkin_at: 'asc' },
      select: {
        checkin_at: true,
        member_id: true,
      },
    });

    // Group by date
    const grouped: Record<string, { total: number; members: number; visitors: number }> = {};

    for (const record of records) {
      const dateKey = record.checkin_at.toISOString().split('T')[0];
      if (!grouped[dateKey]) {
        grouped[dateKey] = { total: 0, members: 0, visitors: 0 };
      }
      grouped[dateKey].total++;
      if (record.member_id) {
        grouped[dateKey].members++;
      } else {
        grouped[dateKey].visitors++;
      }
    }

    return Object.entries(grouped).map(([date, data]) => ({
      date,
      ...data,
    }));
  }

  // ─── Helpers ────────────────────────────────────────────

  private mapToServiceResponse(service: {
    id: string;
    church_id: string;
    branch_id: string | null;
    name: string;
    category: string;
    day_of_week: number | null;
    recurrence?: string | null;
    starts_on?: Date | null;
    ends_on?: Date | null;
    start_time: Date | null;
    end_time: Date | null;
    is_active: boolean;
    archived_at: Date | null;
    created_at: Date;
    updated_at: Date;
    _count?: { attendance: number } | null;
  }): ServiceResponseDto {
    return {
      serviceId: service.id,
      churchId: service.church_id,
      branchId: service.branch_id || undefined,
      name: service.name,
      category: service.category || 'adult',
      dayOfWeek: service.day_of_week ?? undefined,
      recurrence: service.recurrence || 'weekly',
      startsOn: service.starts_on?.toISOString().slice(0, 10),
      endsOn: service.ends_on?.toISOString().slice(0, 10),
      startTime: serviceTimeForResponse(service.start_time),
      endTime: serviceTimeForResponse(service.end_time),
      isActive: service.is_active,
      attendanceCount: service._count?.attendance ?? 0,
      archivedAt: service.archived_at?.toISOString(),
      createdAt: service.created_at.toISOString(),
      updatedAt: service.updated_at.toISOString(),
    };
  }

  private mapToAttendanceResponse(record: {
    id: string;
    church_id: string;
    service_id: string | null;
    event_id: string | null;
    member_id: string | null;
    visitor_id: string | null;
    visitor_name: string | null;
    category: string;
    checkin_at: Date;
    source: string;
    created_at: Date;
    service?: { name: string } | null;
    event?: { title: string } | null;
    member?: { first_name: string; last_name: string } | null;
    visitor?: { first_name: string; last_name: string | null } | null;
  }): AttendanceResponseDto {
    const linkedVisitorName = record.visitor
      ? [record.visitor.first_name, record.visitor.last_name].filter(Boolean).join(' ')
      : undefined;

    return {
      attendanceId: record.id,
      churchId: record.church_id,
      serviceId: record.service_id || undefined,
      eventId: record.event_id || undefined,
      memberId: record.member_id || undefined,
      visitorId: record.visitor_id || undefined,
      visitorName: record.visitor_name || linkedVisitorName,
      category: record.category || 'adult',
      checkInAt: record.checkin_at.toISOString(),
      source: record.source,
      createdAt: record.created_at.toISOString(),
      memberName: record.member
        ? `${record.member.first_name} ${record.member.last_name}`
        : undefined,
      serviceName: record.service?.name || undefined,
      eventName: record.event?.title || undefined,
    };
  }
}
