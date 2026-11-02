import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, AttendanceSession } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RequestContextService } from '../common/services/request-context.service';
import { AuditLoggingService } from '../common/services/audit-logging.service';
import { BranchScopeService, ViewerScope } from '../common/services/branch-scope.service';
import {
  GeneralAttendanceCountsDto,
  GeneralAttendanceQueryDto,
  RecordAttendanceSessionDto,
  validateGeneralCounts,
} from './dto/general-attendance.dto';
import { summarizeGeneralAttendance } from './general-attendance-summary';
import {
  EventSchedule,
  ServiceSchedule,
  assertEventOccursOn,
  assertServiceOccursOn,
} from './schedule-occurrence';

export type AttendanceContext = 'service' | 'event' | 'department' | 'cell_group';
const contextField = {
  service: 'service_id',
  event: 'event_id',
  department: 'department_id',
  cell_group: 'cell_group_id',
} as const;
const includeContexts = {
  service: { select: { name: true } },
  event: { select: { title: true } },
  department: { select: { name: true } },
  cell_group: { select: { name: true } },
  branch: { select: { name: true } },
} as const;

/** Shared session totals and optional demographics for every attendance context. */
export class AttendanceSessionsService {
  constructor(
    protected readonly prisma: PrismaService,
    protected readonly requestContext: RequestContextService,
    protected readonly audit: AuditLoggingService,
    protected readonly branchScope: BranchScopeService,
  ) {}

  private date(value: string) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      value.startsWith('0000') ||
      Number.isNaN(Date.parse(value)) ||
      new Date(value).toISOString().slice(0, 10) !== value
    )
      throw new BadRequestException('Enter a valid attendance date');
    return new Date(value);
  }
  protected sessionWhere(
    type: AttendanceContext,
    contextId: string | undefined,
    churchId: string,
    query: GeneralAttendanceQueryDto,
    viewer?: ViewerScope | null,
  ): Prisma.AttendanceSessionWhereInput {
    viewer ??= this.requestContext.getStore()?.viewer;
    if (viewer && viewer.church_id !== churchId)
      throw new ForbiddenException('Invalid church context');
    const scope = this.branchScope.resolve(viewer);
    const start = query.startDate ? this.date(query.startDate) : undefined,
      end = query.endDate ? this.date(query.endDate) : undefined;
    if (start && end && start > end)
      throw new BadRequestException('Start date must be before end date');
    return {
      church_id: churchId,
      [contextField[type]]: contextId ?? { not: null },
      ...(scope.churchOnly
        ? query.branchId
          ? { branch_id: query.branchId }
          : {}
        : { branch_id: scope.branchId ?? '' }),
      ...(start || end ? { attendance_date: { gte: start, lte: end } } : {}),
    };
  }
  private counts(dto: GeneralAttendanceCountsDto) {
    try {
      validateGeneralCounts(dto);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
    return {
      total: dto.total,
      adult_count: dto.adultCount ?? null,
      children_count: dto.childrenCount ?? null,
      male_count: dto.maleCount ?? null,
      female_count: dto.femaleCount ?? null,
    };
  }
  private async target(
    type: AttendanceContext,
    id: string,
    churchId: string,
    viewer: ViewerScope | null | undefined,
    write: boolean,
  ) {
    viewer ??= this.requestContext.getStore()?.viewer;
    if (viewer && viewer.church_id !== churchId)
      throw new ForbiddenException('Invalid church context');
    const scope = this.branchScope.resolve(viewer);
    const where = {
      id,
      church_id: churchId,
      ...(!scope.churchOnly
        ? { OR: [{ branch_id: scope.branchId ?? '' }, { branch_id: null }] }
        : {}),
    };
    const row =
      type === 'service'
        ? await this.prisma.service.findFirst({ where })
        : type === 'event'
          ? await this.prisma.event.findFirst({ where })
          : type === 'department'
            ? await this.prisma.department.findFirst({ where })
            : await this.prisma.cellGroup.findFirst({ where });
    if (!row) throw new NotFoundException('Attendance context not found');
    const resource = type === 'department' ? 'departments' : 'cell_groups';
    if (type === 'department' || type === 'cell_group') {
      const own =
        viewer?.permissions?.includes(`${resource}:own:${write ? 'update' : 'read'}`) &&
        !viewer.permissions.includes(`${resource}:delete`);
      const owner =
        'head_member_id' in row ? row.head_member_id : 'leader_id' in row ? row.leader_id : null;
      if (type === 'cell_group' && own && !scope.churchOnly && row.archived_at)
        throw new NotFoundException('Attendance context not found');
      if (
        own &&
        (write || !scope.churchOnly) &&
        (!viewer?.member_id || owner !== viewer.member_id)
      ) {
        if (write)
          throw new ForbiddenException(
            `You can only manage your own ${type === 'department' ? 'department' : 'cell group'}`,
          );
        throw new NotFoundException('Attendance context not found');
      }
    }
    if (write && (row.archived_at || ('is_active' in row && !row.is_active)))
      throw new BadRequestException('Cannot record attendance for an inactive or archived context');
    return row;
  }
  async recordSession(
    type: AttendanceContext,
    contextId: string,
    dto: RecordAttendanceSessionDto,
    churchId: string,
    userId: string,
    viewer?: ViewerScope | null,
  ) {
    const counts = this.counts(dto),
      date = this.date(dto.attendanceDate);
    const parent = await this.target(type, contextId, churchId, viewer, true);
    if (type === 'service')
      assertServiceOccursOn(
        (parent as { name: string }).name,
        parent as ServiceSchedule,
        dto.attendanceDate,
      );
    if (type === 'event')
      assertEventOccursOn(
        (parent as { title: string }).title,
        parent as EventSchedule,
        dto.attendanceDate,
      );
    const scope = this.branchScope.resolve(viewer);
    const branchId = parent.branch_id ?? (scope.churchOnly ? dto.branchId : scope.branchId);
    if (!branchId || branchId === '00000000-0000-0000-0000-000000000000')
      throw new BadRequestException('Select a branch for attendance');
    if (dto.branchId && dto.branchId !== branchId)
      throw new ForbiddenException('Attendance must use the meeting branch');
    if (!scope.churchOnly && branchId !== scope.branchId)
      throw new ForbiddenException('Attendance must be recorded in your branch');
    if (
      !(await this.prisma.branch.findFirst({
        where: { id: branchId, church_id: churchId, archived_at: null },
      }))
    )
      throw new NotFoundException('Branch not found in this church');
    let record;
    try {
      record = await this.prisma.attendanceSession.create({
        data: {
          church_id: churchId,
          branch_id: branchId,
          [contextField[type]]: contextId,
          attendance_date: date,
          ...counts,
        },
        include: includeContexts,
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002')
        throw new ConflictException(
          'Attendance is already recorded for this meeting, branch and date. Edit the existing record.',
        );
      throw error;
    }
    await this.attachDetails(type, contextId, parent.branch_id, record);
    await this.audit.log({
      churchId,
      userId,
      action: 'CREATE',
      entity: 'attendance_session',
      entityId: record.id,
      newValues: { type, contextId, ...dto, branchId },
    });
    return this.mapSession(record);
  }
  async updateSession(
    type: AttendanceContext,
    contextId: string | undefined,
    id: string,
    dto: GeneralAttendanceCountsDto,
    churchId: string,
    userId: string,
    viewer?: ViewerScope | null,
  ) {
    const counts = this.counts(dto);
    const existing = await this.prisma.attendanceSession.findFirst({
      where: { id, ...this.sessionWhere(type, contextId, churchId, {}, viewer) },
    });
    if (!existing) throw new NotFoundException('Attendance session not found');
    await this.target(type, existing[contextField[type]]!, churchId, viewer, true);
    const record = await this.prisma.attendanceSession.update({
      where: { id: existing.id },
      data: counts,
      include: includeContexts,
    });
    await this.audit.log({
      churchId,
      userId,
      action: 'UPDATE',
      entity: 'attendance_session',
      entityId: id,
      newValues: counts,
    });
    return this.mapSession(record);
  }
  async listSessions(
    type: AttendanceContext,
    contextId: string | undefined,
    churchId: string,
    query: GeneralAttendanceQueryDto,
    viewer?: ViewerScope | null,
  ) {
    if (contextId) await this.target(type, contextId, churchId, viewer, false);
    const where = this.sessionWhere(type, contextId, churchId, query, viewer);
    const page = query.page ?? 1,
      limit = query.limit ?? 20,
      skip = (page - 1) * limit;
    if (
      !Number.isInteger(page) ||
      page < 1 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 200 ||
      !Number.isSafeInteger(skip) ||
      skip > 2147483647
    )
      throw new BadRequestException('Invalid pagination');
    const [rows, total] = await Promise.all([
      this.prisma.attendanceSession.findMany({
        where,
        include: includeContexts,
        orderBy: [{ attendance_date: 'desc' }, { id: 'asc' }],
        skip,
        take: limit,
      }),
      this.prisma.attendanceSession.count({ where }),
    ]);
    return {
      data: rows.map((row) => this.mapSession(row)),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }
  async sessionSummary(
    type: AttendanceContext,
    contextId: string | undefined,
    churchId: string,
    query: GeneralAttendanceQueryDto,
    viewer?: ViewerScope | null,
  ) {
    if (contextId) await this.target(type, contextId, churchId, viewer, false);
    return summarizeGeneralAttendance(
      this.prisma,
      this.sessionWhere(type, contextId, churchId, query, viewer),
    );
  }
  /** Optional named details are linked to their session; totals are never added to detail row counts. */
  private async attachDetails(
    type: AttendanceContext,
    contextId: string,
    parentBranch: string | null,
    record: AttendanceSession,
  ) {
    const start = record.attendance_date,
      end = new Date(start.getTime() + 86400000);
    const data = { session_id: record.id };
    if (type === 'department')
      await this.prisma.departmentAttendance.updateMany({
        where: { department_id: contextId, meeting_date: start, session_id: null },
        data,
      });
    else if (type === 'cell_group')
      await this.prisma.cellGroupAttendance.updateMany({
        where: {
          cell_group_id: contextId,
          meeting_date: { gte: start, lt: end },
          session_id: null,
        },
        data,
      });
    else
      await this.prisma.attendance.updateMany({
        where: {
          church_id: record.church_id,
          [contextField[type]]: contextId,
          checkin_at: { gte: start, lt: end },
          session_id: null,
          ...(!parentBranch
            ? {
                OR: [
                  { member: { branch_id: record.branch_id } },
                  { visitor: { branch_id: record.branch_id } },
                ],
              }
            : {}),
        },
        data,
      });
  }
  protected mapSession(
    record: AttendanceSession & {
      service?: { name: string } | null;
      event?: { title: string } | null;
      department?: { name: string } | null;
      cell_group?: { name: string } | null;
      branch?: { name: string };
    },
  ) {
    const type: AttendanceContext = record.service_id
      ? 'service'
      : record.event_id
        ? 'event'
        : record.department_id
          ? 'department'
          : 'cell_group';
    return {
      id: record.id,
      contextType: type,
      contextId: record[contextField[type]],
      contextName:
        record.service?.name ??
        record.event?.title ??
        record.department?.name ??
        record.cell_group?.name,
      serviceId: record.service_id,
      serviceName: record.service?.name,
      branchId: record.branch_id,
      branchName: record.branch?.name,
      attendanceDate: record.attendance_date.toISOString().slice(0, 10),
      total: record.total,
      adultCount: record.adult_count,
      childrenCount: record.children_count,
      maleCount: record.male_count,
      femaleCount: record.female_count,
    };
  }
}
