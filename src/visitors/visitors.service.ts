import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ImportVisitorDto } from './dto/import-visitor.dto';
import { RequestContextService } from '../common/services/request-context.service';
import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLoggingService } from '../common/services/audit-logging.service';
import { CreateVisitorDto } from './dto/create-visitor.dto';
import { UpdateVisitorDto } from './dto/update-visitor.dto';
import { ConvertVisitorDto } from './dto/convert-visitor.dto';
import { ListVisitorsDto } from './dto/list-visitors.dto';
import { VisitorResponseDto } from './dto/visitor-response.dto';
import { VisitorSummaryResponseDto } from './dto/visitor-summary-response.dto';
import { ViewerScope } from '../common/services/branch-scope.service';
import { Prisma } from '@prisma/client';

@Injectable()
export class VisitorsService {
  private readonly logger = new Logger(VisitorsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLoggingService,
    private readonly requestContext: RequestContextService,
  ) {}

  async create(
    dto: CreateVisitorDto,
    churchId: string,
    userId: string,
    viewer?: ViewerScope | null,
    transaction?: Prisma.TransactionClient,
  ): Promise<VisitorResponseDto> {
    const db = transaction ?? this.prisma;
    let assignedToId = dto.assignedToId;
    if (assignedToId) {
      assignedToId = await this.resolveAssigneeProfileId(assignedToId, churchId, db);
    }

    // Tag the visitor with a branch so branch-restricted viewers can scope
    // follow-up lists. HQ/unspecified creators may set an explicit branch or
    // leave it unset (null = church-wide); branch-restricted creators are
    // pinned to their own branch.
    const branchId = await this.resolveVisitorBranch(dto.branchId, churchId, viewer, db);

    const visitor = await db.visitor.create({
      data: {
        church_id: churchId,
        branch_id: branchId,
        first_name: dto.firstName,
        last_name: dto.lastName,
        gender: dto.gender,
        phone: dto.phone,
        whatsapp_number: dto.whatsappNumber,
        email: dto.email,
        first_visit_date: dto.firstVisitDate ? new Date(dto.firstVisitDate) : new Date(),
        follow_up_status: dto.followUpStatus ?? 'new',
        assigned_to_id: assignedToId,
        notes: dto.notes,
        custom_fields: (dto.customFields ?? {}) as Prisma.InputJsonValue,
      },
      include: {
        assigned_to: { select: { first_name: true, last_name: true } },
        branch: { select: { id: true, name: true } },
      },
    });

    if (!transaction)
      await this.audit.log({
        userId,
        churchId,
        entity: 'visitor',
        action: 'CREATE',
        entityId: visitor.id,
        newValues: { first_name: dto.firstName, last_name: dto.lastName },
      });

    this.logger.log(`Visitor created: ${visitor.id}`);

    return this.toResponseDto(visitor);
  }

  async bulkImport(
    records: ImportVisitorDto[],
    churchId: string,
    userId: string,
    dryRun = false,
    viewer?: ViewerScope | null,
  ) {
    if (!Array.isArray(records) || records.length < 1 || records.length > 100)
      throw new BadRequestException('Import between 1 and 100 visitors per batch');
    if (typeof dryRun !== 'boolean') throw new BadRequestException('dryRun must be a boolean');
    viewer ??= this.requestContext.getStore()?.viewer;
    const errors: Array<{ row: number; message: string }> = [];
    const phones = new Set<string>();
    const emails = new Set<string>();
    let created = 0;
    for (const [index, record] of records.entries()) {
      try {
        const dto = plainToInstance(ImportVisitorDto, record);
        const issues = await validate(dto, {
          whitelist: true,
          forbidNonWhitelisted: true,
          forbidUnknownValues: true,
        });
        if (issues.length)
          throw new BadRequestException(
            issues.flatMap((issue) => Object.values(issue.constraints ?? {})).join('; ') ||
              'Invalid visitor data',
          );
        dto.firstName = dto.firstName.trim();
        if (!dto.firstName) throw new BadRequestException('First name is required');
        if (dto.email) dto.email = dto.email.trim().toLowerCase();
        if (
          dto.firstVisitDate &&
          (!/^\d{4}-\d{2}-\d{2}$/.test(dto.firstVisitDate) ||
            Number.isNaN(new Date(dto.firstVisitDate).getTime()) ||
            new Date(dto.firstVisitDate).toISOString().slice(0, 10) !== dto.firstVisitDate)
        )
          throw new BadRequestException('Invalid first visit date');
        if (viewer && !viewer.is_admin_hq && dto.branchId && dto.branchId !== viewer.branch_id)
          throw new ForbiddenException('You can only import visitors into your branch');
        await this.resolveVisitorBranch(dto.branchId, churchId, viewer);
        const phone = dto.phone?.replace(/\D/g, '');
        const email = dto.email?.toLowerCase();
        if ((phone && phones.has(phone)) || (email && emails.has(email)))
          throw new ConflictException('Duplicate phone or email in this batch');
        const contacts: Prisma.VisitorWhereInput[] = [];
        if (email) contacts.push({ email: { equals: email, mode: 'insensitive' } });
        if (phone) contacts.push({ phone: { in: [...new Set([dto.phone!, phone, `+${phone}`])] } });
        if (
          contacts.length &&
          (await this.prisma.visitor.findFirst({
            where: { church_id: churchId, deleted_at: null, OR: contacts },
          }))
        )
          throw new ConflictException('A visitor with this phone or email already exists');
        if (!dryRun) await this.create(dto, churchId, userId, viewer);
        if (phone) phones.add(phone);
        if (email) emails.add(email);
        created++;
      } catch (cause) {
        errors.push({
          row: index + 1,
          message: cause instanceof Error ? cause.message : 'Invalid visitor data',
        });
      }
    }
    return { created, errors, dryRun };
  }

  async findAll(
    churchId: string,
    query: ListVisitorsDto,
    viewer?: ViewerScope | null,
  ): Promise<{ data: VisitorResponseDto[]; total: number }> {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    viewer ??= this.requestContext.getStore()?.viewer;
    this.requestContext.branchWhere(churchId);
    const conditions: Prisma.VisitorWhereInput[] = [];

    if (query.followUpStatus) {
      conditions.push({ follow_up_status: query.followUpStatus });
    }

    if (query.assignedToId) {
      conditions.push({ assigned_to_id: query.assignedToId });
    }

    if (query.search?.trim()) {
      const term = query.search.trim();
      conditions.push({
        OR: [
          { first_name: { contains: term, mode: 'insensitive' } },
          { last_name: { contains: term, mode: 'insensitive' } },
          { email: { contains: term, mode: 'insensitive' } },
          { phone: { contains: term } },
        ],
      });
    }

    // Branch-scoped viewers (non-HQ) see visitors from their own branch only,
    // PLUS untagged legacy visitors (branch_id IS NULL) so previously recorded
    // rows don't vanish from branch lists.
    if (viewer && !viewer.is_admin_hq) {
      conditions.push(
        viewer.branch_id
          ? { OR: [{ branch_id: viewer.branch_id }, { branch_id: null }] }
          : { branch_id: '00000000-0000-0000-0000-000000000000' },
      );
    }

    const where: Prisma.VisitorWhereInput = {
      church_id: churchId,
      deleted_at: null,
      archived_at: query.archived === true ? { not: null } : null,
      ...(conditions.length ? { AND: conditions } : {}),
    };

    const orderBy: Prisma.VisitorOrderByWithRelationInput[] = [];
    if (query.sortBy) {
      const fieldMap: Record<string, Prisma.VisitorScalarFieldEnum> = {
        firstName: 'first_name',
        lastName: 'last_name',
        createdAt: 'created_at',
        firstVisitDate: 'first_visit_date',
        followUpStatus: 'follow_up_status',
      };
      orderBy.push({ [fieldMap[query.sortBy]]: (query.sortOrder || 'desc') as Prisma.SortOrder });
    } else {
      orderBy.push({ created_at: 'desc' });
    }

    const [visitors, total] = await Promise.all([
      this.prisma.visitor.findMany({
        where,
        include: {
          assigned_to: { select: { first_name: true, last_name: true } },
          branch: { select: { id: true, name: true } },
        },
        orderBy,
        skip,
        take: limit,
      }),
      this.prisma.visitor.count({ where }),
    ]);

    return {
      data: visitors.map((v) => this.toResponseDto(v)),
      total,
    };
  }

  /**
   * Returns visitor follow-up stats for the dashboard stat cards: total
   * active visitors, new visitors this month, visitors in an active follow-up
   * funnel, and converted visitors. Mirrors `findAll` scoping — soft-deleted
   * (converted) and archived visitors are excluded, and branch-restricted
   * viewers only see their own branch plus untagged legacy visitors.
   */
  async getVisitorsSummary(
    churchId: string,
    viewer?: ViewerScope | null,
  ): Promise<VisitorSummaryResponseDto> {
    viewer ??= this.requestContext.getStore()?.viewer;
    this.requestContext.branchWhere(churchId);
    const conditions: Prisma.VisitorWhereInput[] = [];

    if (viewer && !viewer.is_admin_hq) {
      conditions.push(
        viewer.branch_id
          ? { OR: [{ branch_id: viewer.branch_id }, { branch_id: null }] }
          : { branch_id: '00000000-0000-0000-0000-000000000000' },
      );
    }

    const baseWhere: Prisma.VisitorWhereInput = {
      church_id: churchId,
      deleted_at: null,
      archived_at: null,
      ...(conditions.length ? { AND: conditions } : {}),
    };

    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    const total = await this.prisma.visitor.count({ where: baseWhere });
    const newThisMonth = await this.prisma.visitor.count({
      where: { ...baseWhere, first_visit_date: { gte: monthStart } },
    });
    const inFollowUp = await this.prisma.visitor.count({
      where: {
        ...baseWhere,
        follow_up_status: { in: ['new', 'contacted', 'follow_up_scheduled', 'interested'] },
        converted_member_id: null,
      },
    });
    const converted = await this.prisma.visitor.count({
      where: {
        ...baseWhere,
        OR: [{ converted_member_id: { not: null } }, { follow_up_status: 'converted' }],
      },
    });

    return { total, newThisMonth, inFollowUp, converted };
  }

  async findOne(id: string, churchId: string): Promise<VisitorResponseDto> {
    const visitor = await this.prisma.visitor.findUnique({
      where: { id },
      include: {
        assigned_to: { select: { first_name: true, last_name: true } },
        branch: { select: { id: true, name: true } },
      },
    });

    if (
      !visitor ||
      visitor.church_id !== churchId ||
      !this.isVisible(churchId, visitor.branch_id)
    ) {
      throw new NotFoundException('Visitor not found');
    }

    return this.toResponseDto(visitor);
  }

  async update(
    id: string,
    dto: UpdateVisitorDto,
    churchId: string,
    userId: string,
  ): Promise<VisitorResponseDto> {
    const existing = await this.prisma.visitor.findUnique({ where: { id } });

    if (
      !existing ||
      existing.church_id !== churchId ||
      !this.isVisible(churchId, existing.branch_id)
    ) {
      throw new NotFoundException('Visitor not found');
    }

    if (existing.archived_at) {
      throw new NotFoundException('Visitor not found');
    }

    const updateData: Prisma.VisitorUpdateInput = {};
    if (dto.branchId !== undefined) {
      this.requestContext.branchIdForWrite(churchId, dto.branchId);
      const branchId = await this.resolveVisitorBranch(dto.branchId, churchId);
      updateData.branch = branchId ? { connect: { id: branchId } } : { disconnect: true };
    }
    if (dto.firstName !== undefined) updateData.first_name = dto.firstName;
    if (dto.lastName !== undefined) updateData.last_name = dto.lastName;
    if (dto.gender !== undefined) updateData.gender = dto.gender;
    if (dto.phone !== undefined) updateData.phone = dto.phone;
    if (dto.whatsappNumber !== undefined) updateData.whatsapp_number = dto.whatsappNumber;
    if (dto.email !== undefined) updateData.email = dto.email;
    if (dto.firstVisitDate !== undefined)
      updateData.first_visit_date = new Date(dto.firstVisitDate);
    if (dto.followUpStatus !== undefined) updateData.follow_up_status = dto.followUpStatus;
    if (dto.notes !== undefined) updateData.notes = dto.notes;
    if (dto.customFields !== undefined)
      updateData.custom_fields = dto.customFields as Prisma.InputJsonValue;
    if (dto.assignedToId !== undefined) {
      let resolvedId = dto.assignedToId;
      if (resolvedId) {
        resolvedId = await this.resolveAssigneeProfileId(resolvedId, churchId);
      }
      updateData.assigned_to = resolvedId ? { connect: { id: resolvedId } } : { disconnect: true };
    }

    const visitor = await this.prisma.visitor.update({
      where: { id },
      data: updateData,
      include: {
        assigned_to: { select: { first_name: true, last_name: true } },
        branch: { select: { id: true, name: true } },
      },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'visitor',
      action: 'UPDATE',
      entityId: id,
      oldValues: { follow_up_status: existing.follow_up_status, branchId: existing.branch_id },
      newValues: updateData as Record<string, unknown>,
    });

    this.logger.log(`Visitor updated: ${id}`);

    return this.toResponseDto(visitor);
  }

  async remove(id: string, churchId: string, userId: string): Promise<void> {
    const existing = await this.prisma.visitor.findUnique({ where: { id } });

    if (
      !existing ||
      existing.church_id !== churchId ||
      !this.isVisible(churchId, existing.branch_id)
    ) {
      throw new NotFoundException('Visitor not found');
    }

    // Hard delete stays available on archived rows — this is the "purge" path
    // invoked from the archived view.

    await this.prisma.visitor.delete({ where: { id } });

    await this.audit.log({
      userId,
      churchId,
      entity: 'visitor',
      action: 'DELETE',
      entityId: id,
      oldValues: { first_name: existing.first_name },
    });

    this.logger.log(`Visitor deleted: ${id}`);
  }

  /**
   * Archives a visitor by setting archived_at. Archived visitors drop out of
   * list/search/board pulls (active lists filter archived_at: null) but their
   * details stay reachable, and they can be restored or permanently deleted.
   *
   * @param id - Visitor UUID
   * @param churchId - Church UUID for tenant scoping
   * @param userId - Acting user ID for audit logging
   * @returns Updated VisitorResponseDto
   * @throws NotFoundException if the visitor is missing or not in this church
   * @throws ConflictException if the visitor is already archived
   */
  async archive(id: string, churchId: string, userId: string): Promise<VisitorResponseDto> {
    const existing = await this.prisma.visitor.findUnique({ where: { id } });

    if (
      !existing ||
      existing.church_id !== churchId ||
      !this.isVisible(churchId, existing.branch_id)
    ) {
      throw new NotFoundException('Visitor not found');
    }

    if (existing.archived_at) {
      throw new ConflictException('Visitor is already archived');
    }

    const visitor = await this.prisma.visitor.update({
      where: { id },
      data: { archived_at: new Date() },
      include: {
        assigned_to: { select: { first_name: true, last_name: true } },
        branch: { select: { id: true, name: true } },
      },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'visitor',
      action: 'ARCHIVE',
      entityId: id,
      oldValues: { archived_at: existing.archived_at },
      newValues: { archived_at: visitor.archived_at },
    });

    this.logger.log(`Visitor archived: ${id}`);

    return this.toResponseDto(visitor);
  }

  /**
   * Restores an archived visitor by clearing archived_at.
   *
   * @param id - Visitor UUID
   * @param churchId - Church UUID for tenant scoping
   * @param userId - Acting user ID for audit logging
   * @returns Updated VisitorResponseDto
   * @throws NotFoundException if the visitor is missing or not in this church
   * @throws ConflictException if the visitor is not currently archived
   */
  async restore(id: string, churchId: string, userId: string): Promise<VisitorResponseDto> {
    const existing = await this.prisma.visitor.findUnique({ where: { id } });

    if (
      !existing ||
      existing.church_id !== churchId ||
      !this.isVisible(churchId, existing.branch_id)
    ) {
      throw new NotFoundException('Visitor not found');
    }

    if (!existing.archived_at) {
      throw new ConflictException('Visitor is not archived');
    }

    const visitor = await this.prisma.visitor.update({
      where: { id },
      data: { archived_at: null },
      include: {
        assigned_to: { select: { first_name: true, last_name: true } },
        branch: { select: { id: true, name: true } },
      },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'visitor',
      action: 'RESTORE',
      entityId: id,
      oldValues: { archived_at: existing.archived_at },
      newValues: { archived_at: null },
    });

    this.logger.log(`Visitor restored: ${id}`);

    return this.toResponseDto(visitor);
  }

  async convertToMember(
    id: string,
    dto: ConvertVisitorDto,
    churchId: string,
    userId: string,
  ): Promise<{ visitor: VisitorResponseDto; memberId: string }> {
    const visitor = await this.prisma.visitor.findUnique({ where: { id } });

    if (
      !visitor ||
      visitor.church_id !== churchId ||
      !this.isVisible(churchId, visitor.branch_id)
    ) {
      throw new NotFoundException('Visitor not found');
    }

    if (visitor.archived_at) {
      throw new NotFoundException('Visitor not found');
    }

    if (visitor.follow_up_status === 'converted') {
      throw new BadRequestException('Visitor has already been converted');
    }

    // Carry the visitor's own details into the member record so nothing is lost.
    const visitorCustomFields =
      visitor.custom_fields && typeof visitor.custom_fields === 'object'
        ? (visitor.custom_fields as Record<string, unknown>)
        : {};

    const member = await this.prisma.member.create({
      data: {
        church_id: churchId,
        branch_id: this.requestContext.branchIdForWrite(churchId, dto.branchId),
        first_name: dto.firstName,
        last_name: dto.lastName,
        gender: visitor.gender,
        email: dto.email || visitor.email,
        phone: dto.phone || visitor.phone,
        whatsapp_number: visitor.whatsapp_number,
        status: 'active',
        custom_fields: visitorCustomFields as Prisma.InputJsonValue,
      },
    });

    const updatedVisitor = await this.prisma.visitor.update({
      where: { id },
      data: {
        follow_up_status: 'converted',
        converted_member_id: member.id,
        converted_at: new Date(),
        // A converted visitor becomes a member and is soft-deleted so it never
        // surfaces again in visitor pulls (list/search/follow-up board).
        deleted_at: new Date(),
      },
      include: {
        assigned_to: { select: { first_name: true, last_name: true } },
        branch: { select: { id: true, name: true } },
      },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'visitor',
      action: 'UPDATE',
      entityId: id,
      oldValues: { follow_up_status: visitor.follow_up_status },
      newValues: { follow_up_status: 'converted', converted_member_id: member.id },
    });

    this.logger.log(`Visitor ${id} converted to member ${member.id}`);

    return {
      visitor: this.toResponseDto(updatedVisitor),
      memberId: member.id,
    };
  }

  private isVisible(churchId: string, branchId?: string | null): boolean {
    const ownBranch = this.requestContext.branchWhere(churchId).branch_id;
    if (!ownBranch) return true;
    if (ownBranch === '00000000-0000-0000-0000-000000000000') return false;
    return branchId == null || branchId === ownBranch;
  }

  private async resolveVisitorBranch(
    dtoBranchId: string | undefined,
    churchId: string,
    viewer?: ViewerScope | null,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<string | null> {
    viewer ??= this.requestContext.getStore()?.viewer;
    this.requestContext.branchWhere(churchId);
    let branchId: string | null;
    let explicit = false;
    if (viewer && !viewer.is_admin_hq) {
      // Branch-restricted creators are pinned to their own branch.
      if (!viewer.branch_id) throw new ForbiddenException('A branch assignment is required');
      branchId = viewer.branch_id;
    } else {
      // HQ / unspecified creators may set an explicit branch or leave it null.
      branchId = dtoBranchId ?? null;
      explicit = !!branchId;
    }

    // Validate only explicit branches (the viewer's own branch comes from the
    // trusted profile context).
    if (explicit) {
      const branch = await db.branch.findFirst({
        where: { id: branchId as string, church_id: churchId, archived_at: null },
        select: { id: true },
      });
      if (!branch) {
        throw new BadRequestException('Branch not found');
      }
    }

    return branchId;
  }

  private async resolveAssigneeProfileId(
    assigneeId: string,
    churchId: string,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<string> {
    const profile = await db.profile.findUnique({
      where: { id: assigneeId },
      select: { id: true, church_id: true },
    });

    if (profile && profile.church_id === churchId) {
      return profile.id;
    }

    const memberProfile = await db.profile.findUnique({
      where: { member_id: assigneeId },
      select: { id: true, church_id: true },
    });

    if (!memberProfile || memberProfile.church_id !== churchId) {
      throw new BadRequestException('Assigned team member not found');
    }

    return memberProfile.id;
  }

  private toResponseDto(visitor: {
    id: string;
    church_id: string;
    branch_id: string | null;
    branch?: { id: string; name: string } | null;
    first_name: string;
    last_name: string | null;
    gender: string | null;
    phone: string | null;
    whatsapp_number: string | null;
    email: string | null;
    first_visit_date: Date;
    follow_up_status: string;
    assigned_to_id: string | null;
    assigned_to?: { first_name: string; last_name: string } | null;
    notes: string | null;
    custom_fields: Prisma.JsonValue;
    converted_member_id: string | null;
    converted_at: Date | null;
    archived_at: Date | null;
    created_at: Date;
    updated_at: Date;
  }): VisitorResponseDto {
    return {
      id: visitor.id,
      churchId: visitor.church_id,
      branchId: visitor.branch_id || undefined,
      branchName: visitor.branch?.name || undefined,
      firstName: visitor.first_name,
      lastName: visitor.last_name || undefined,
      gender: visitor.gender || undefined,
      phone: visitor.phone || undefined,
      whatsappNumber: visitor.whatsapp_number || undefined,
      email: visitor.email || undefined,
      firstVisitDate: visitor.first_visit_date.toISOString(),
      followUpStatus: visitor.follow_up_status,
      assignedToId: visitor.assigned_to_id || undefined,
      assignedToName: visitor.assigned_to
        ? `${visitor.assigned_to.first_name} ${visitor.assigned_to.last_name}`
        : undefined,
      notes: visitor.notes || undefined,
      customFields:
        visitor.custom_fields && typeof visitor.custom_fields === 'object'
          ? (visitor.custom_fields as Record<string, unknown>)
          : undefined,
      convertedMemberId: visitor.converted_member_id || undefined,
      convertedAt: visitor.converted_at?.toISOString(),
      archivedAt: visitor.archived_at?.toISOString(),
      createdAt: visitor.created_at.toISOString(),
      updatedAt: visitor.updated_at.toISOString(),
    };
  }
}
