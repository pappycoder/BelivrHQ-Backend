import { subscriptionError } from '../billing/plan-errors';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RequestContextService } from '../common/services/request-context.service';
import { addDesignedSheet, initializeWorkbook } from '../common/excel/excel-design';
/**
 * @file members.service.ts
 * @description Business logic for church member management.
 *
 * Handles CRUD operations, search, pagination, and audit logging
 * for the Members module. All queries are scoped by church_id for
 * multi-tenant data isolation.
 *
 * @module members/members.service
 * @since 1.0.0
 */

import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLoggingService } from '../common/services/audit-logging.service';
import { NotificationsService } from '../notifications/notifications.service';
import { BranchScopeService, ViewerScope } from '../common/services/branch-scope.service';
import { CreateMemberDto } from './dto/create-member.dto';
import { UpdateMemberDto } from './dto/update-member.dto';
import { ListMembersDto } from './dto/list-members.dto';
import { MemberResponseDto } from './dto/member-response.dto';
import { MemberDashboardQueryDto, MemberDashboardResponseDto } from './dto/member-dashboard.dto';
import { Prisma } from '@prisma/client';

@Injectable()
export class MembersService {
  private readonly logger = new Logger(MembersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly requestContext: RequestContextService,
    private readonly audit: AuditLoggingService,
    private readonly notifications: NotificationsService,
    private readonly branchScope: BranchScopeService,
  ) {}

  /**
   * Creates a new church member.
   *
   * @param dto - Member creation data
   * @param churchId - Church ID for tenant scoping
   * @param userId - ID of the user creating the member (for audit)
   * @returns Created member
   * @throws ConflictException if phone number already exists in the church
   */
  async createMember(
    dto: CreateMemberDto,
    churchId: string,
    userId: string,
    transaction?: Prisma.TransactionClient,
  ): Promise<MemberResponseDto> {
    const db = transaction ?? this.prisma;
    // Check for duplicate phone number within the same church
    if (dto.phone) {
      const existing = await db.member.findFirst({
        where: {
          church_id: churchId,
          phone: dto.phone,
        },
      });

      if (existing) {
        throw new ConflictException(
          'A member with this phone number already exists in your church',
        );
      }
    }

    const normalizedFirstName = dto.firstName?.trim();
    const normalizedLastName = dto.lastName?.trim();
    const normalizedEmail = dto.email?.trim() || null;
    const normalizedPhone = dto.phone?.trim() || null;
    const normalizedWhatsAppNumber = dto.whatsappNumber?.trim() || null;
    const normalizedAddress = dto.address?.trim() || null;
    const normalizedCity = dto.city?.trim() || null;
    const normalizedState = dto.state?.trim() || null;
    const normalizedNotes = dto.notes?.trim() || null;

    const member = await db.member.create({
      data: {
        church_id: churchId,
        branch_id: this.requestContext.branchIdForWrite(churchId, dto.branchId) ?? null,
        first_name: normalizedFirstName,
        last_name: normalizedLastName,
        email: normalizedEmail,
        phone: normalizedPhone,
        whatsapp_number: normalizedWhatsAppNumber,
        date_of_birth: dto.dateOfBirth ? new Date(dto.dateOfBirth) : null,
        gender: dto.gender?.trim() || null,
        address: normalizedAddress,
        city: normalizedCity,
        state: normalizedState,
        custom_fields: (dto.customFields as Prisma.InputJsonValue) || Prisma.JsonNull,
        notes: normalizedNotes,
      },
    });

    const response = this.mapToResponseDto(member);
    if (!transaction) await this.afterMemberCreated(dto, churchId, userId, response);
    return response;
  }

  async afterMemberCreated(
    dto: CreateMemberDto,
    churchId: string,
    userId: string,
    member: MemberResponseDto,
  ) {
    // Audit-log the creation
    await this.audit.log({
      userId,
      churchId,
      entity: 'member',
      action: 'CREATE',
      entityId: member.memberId,
      newValues: {
        firstName: dto.firstName,
        lastName: dto.lastName,
        email: dto.email,
        phone: dto.phone,
      },
    });

    this.logger.log(`Member created: ${member.firstName} ${member.lastName} (${member.memberId})`);

    const adminProfiles = await this.prisma.profile.findMany({
      where: { church_id: churchId, role: { hasSome: ['church_admin', 'secretary'] } },
    });
    for (const admin of adminProfiles) {
      await this.notifications
        .createNotification(
          churchId,
          admin.id,
          'member',
          'New Member',
          `${member.firstName} ${member.lastName} has been added to the church.`,
          { memberId: member.memberId },
        )
        .catch((err) => this.logger.warn(`Notification failed: ${(err as Error).message}`));
    }
  }

  /**
   * Retrieves a single member by ID, scoped to the church.
   *
   * @param id - Member UUID
   * @param churchId - Church ID for tenant scoping
   * @returns Member details
   * @throws NotFoundException if member not found or belongs to another church
   */
  async getMemberById(
    id: string,
    churchId: string,
    viewerPermissions: string[] = [],
    viewer?: ViewerScope | null,
  ): Promise<MemberResponseDto> {
    const member = await this.prisma.member.findUnique({
      where: { id },
    });

    if (
      !member ||
      member.church_id !== churchId ||
      !this.branchScope.isVisible(undefined, member.branch_id)
    ) {
      throw new NotFoundException('Member not found');
    }

    if (!this.branchScope.isVisible(viewer, member.branch_id)) {
      throw new NotFoundException('Member not found');
    }

    return this.mapToResponseDto(member, viewerPermissions);
  }

  /** Current non-archived member aggregates within the viewer scope. */
  async getDashboard(
    churchId: string,
    query: MemberDashboardQueryDto,
    viewer?: ViewerScope | null,
  ): Promise<MemberDashboardResponseDto> {
    const scope = this.branchScope.resolve(viewer);
    const branchId = scope.churchOnly ? query.branchId : scope.branchId;
    const rows = await this.prisma.member.findMany({
      where: {
        church_id: churchId,
        archived_at: null,
        ...(branchId ? { branch_id: branchId } : {}),
      },
      select: { status: true, date_of_birth: true, member_since: true },
    });
    const byStatus: Record<string, number> = {};
    const byAgeGroup: Record<string, number> = {
      under_18: 0,
      age_18_30: 0,
      age_31_45: 0,
      age_46_60: 0,
      age_60_plus: 0,
      unspecified: 0,
    };
    const monthly = new Map<string, number>();
    const today = new Date();
    for (const row of rows) {
      byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
      let bin = 'unspecified';
      if (row.date_of_birth) {
        const birth = row.date_of_birth;
        let age = today.getUTCFullYear() - birth.getUTCFullYear();
        if (
          today.getUTCMonth() < birth.getUTCMonth() ||
          (today.getUTCMonth() === birth.getUTCMonth() && today.getUTCDate() < birth.getUTCDate())
        )
          age--;
        if (age >= 0)
          bin =
            age < 18
              ? 'under_18'
              : age <= 30
                ? 'age_18_30'
                : age <= 45
                  ? 'age_31_45'
                  : age <= 60
                    ? 'age_46_60'
                    : 'age_60_plus';
      }
      byAgeGroup[bin]++;
      const month = row.member_since.toISOString().slice(0, 7);
      monthly.set(month, (monthly.get(month) ?? 0) + 1);
    }
    let cumulative = 0;
    const growth = [...monthly.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, count]) => {
        cumulative += count;
        return { date: `${month}-01`, total: cumulative, members: count, visitors: 0 };
      });
    return { total: rows.length, byStatus, byAgeGroup, growth };
  }

  /**
   * Lists members with pagination, search, and filters.
   *
   * @param churchId - Church ID for tenant scoping
   * @param query - List query parameters
   * @returns Paginated list of members
   */
  async listMembers(
    churchId: string,
    query: ListMembersDto,
    viewerPermissions: string[] = [],
    viewer?: ViewerScope | null,
  ): Promise<{ data: MemberResponseDto[]; total: number }> {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    const where: Prisma.MemberWhereInput = {
      church_id: churchId,
      archived_at: query.archived === true ? { not: null } : null,
    };

    // Branch-scope for non-HQ viewers: without the admin-hq override, a viewer
    // only sees members from their OWN branch. The controller passes the request
    // profile as `viewer`; `admin-hq` holders and viewers with no branch see all.
    const scope = this.branchScope.resolve(viewer);
    if (!scope.churchOnly && scope.branchId) {
      where.branch_id = scope.branchId;
    }

    // Apply status filter
    if (query.status) {
      where.status = query.status;
    }

    // Apply branch filter (only widen from the viewer's own scope — never narrow
    // past what the viewer is entitled to see).
    if (query.branchId && scope.churchOnly) {
      where.branch_id = query.branchId;
    }

    // Apply search filter (name, email, phone)
    if (query.search) {
      const searchTerm = query.search.trim();
      where.OR = [
        { first_name: { contains: searchTerm, mode: 'insensitive' } },
        { last_name: { contains: searchTerm, mode: 'insensitive' } },
        { email: { contains: searchTerm, mode: 'insensitive' } },
        { phone: { contains: searchTerm, mode: 'insensitive' } },
      ];
    }

    // Determine sort order
    const orderBy: Prisma.MemberOrderByWithRelationInput[] = [];
    if (query.sortBy) {
      orderBy.push({ [query.sortBy]: (query.sortOrder || 'asc') as Prisma.SortOrder });
    } else {
      orderBy.push({ created_at: 'desc' });
    }

    const [members, total] = await Promise.all([
      this.prisma.member.findMany({
        where,
        orderBy,
        skip,
        take: limit,
      }),
      this.prisma.member.count({ where }),
    ]);

    return {
      data: members.map((m) => this.mapToResponseDto(m, viewerPermissions)),
      total,
    };
  }

  /**
   * Updates a member's details (partial update).
   *
   * @param id - Member UUID
   * @param dto - Update data (only provided fields)
   * @param churchId - Church ID for tenant scoping
   * @param userId - ID of the user updating the member (for audit)
   * @returns Updated member
   * @throws NotFoundException if member not found
   * @throws ConflictException if phone number already exists
   */
  async updateMember(
    id: string,
    dto: UpdateMemberDto,
    churchId: string,
    userId: string,
  ): Promise<MemberResponseDto> {
    // Verify member exists and belongs to this church
    const existing = await this.prisma.member.findUnique({
      where: { id },
    });

    if (
      !existing ||
      existing.church_id !== churchId ||
      !this.branchScope.isVisible(undefined, existing.branch_id)
    ) {
      throw new NotFoundException('Member not found');
    }

    if (existing.archived_at) {
      throw new NotFoundException('Member not found');
    }

    // Check for duplicate phone number if phone is being updated
    if (dto.phone && dto.phone !== existing.phone) {
      const duplicatePhone = await this.prisma.member.findFirst({
        where: {
          church_id: churchId,
          phone: dto.phone,
          id: { not: id },
        },
      });

      if (duplicatePhone) {
        throw new ConflictException(
          'A member with this phone number already exists in your church',
        );
      }
    }

    // Build update data (only include provided fields)
    const updateData: Prisma.MemberUpdateInput = {};

    if (dto.firstName !== undefined) updateData.first_name = dto.firstName;
    if (dto.lastName !== undefined) updateData.last_name = dto.lastName;
    if (dto.email !== undefined) updateData.email = dto.email || null;
    if (dto.phone !== undefined) updateData.phone = dto.phone || null;
    if (dto.whatsappNumber !== undefined) updateData.whatsapp_number = dto.whatsappNumber || null;
    if (dto.dateOfBirth !== undefined)
      updateData.date_of_birth = dto.dateOfBirth ? new Date(dto.dateOfBirth) : null;
    if (dto.gender !== undefined) updateData.gender = dto.gender || null;
    if (dto.address !== undefined) updateData.address = dto.address || null;
    if (dto.city !== undefined) updateData.city = dto.city || null;
    if (dto.state !== undefined) updateData.state = dto.state || null;
    if (dto.status !== undefined) updateData.status = dto.status;
    if (dto.branchId !== undefined) this.requestContext.branchIdForWrite(churchId, dto.branchId);
    if (dto.branchId !== undefined) updateData.branch = { connect: { id: dto.branchId } };
    if (dto.photoUrl !== undefined) updateData.photo_url = dto.photoUrl || null;
    if (dto.customFields !== undefined)
      updateData.custom_fields = (dto.customFields as Prisma.InputJsonValue) || Prisma.JsonNull;
    if (dto.notes !== undefined) updateData.notes = dto.notes || null;

    // Skip if nothing to update
    if (Object.keys(updateData).length === 0) {
      return this.mapToResponseDto(existing);
    }

    const member = await this.prisma.member.update({
      where: { id },
      data: updateData,
    });

    // Audit-log the update
    await this.audit.log({
      userId,
      churchId,
      entity: 'member',
      action: 'UPDATE',
      entityId: id,
      oldValues: {
        firstName: existing.first_name,
        lastName: existing.last_name,
        email: existing.email,
        phone: existing.phone,
        status: existing.status,
      },
      newValues: updateData,
    });

    this.logger.log(`Member updated: ${id}`);

    return this.mapToResponseDto(member);
  }

  /**
   * Soft-deletes a member by setting their status to inactive.
   *
   * @param id - Member UUID
   * @param churchId - Church ID for tenant scoping
   * @param userId - ID of the user performing the deletion (for audit)
   * @throws NotFoundException if member not found
   */
  async softDeleteMember(id: string, churchId: string, userId: string): Promise<void> {
    const existing = await this.prisma.member.findUnique({
      where: { id },
    });

    if (
      !existing ||
      existing.church_id !== churchId ||
      !this.branchScope.isVisible(undefined, existing.branch_id)
    ) {
      throw new NotFoundException('Member not found');
    }

    await this.prisma.member.update({
      where: { id },
      data: { status: 'inactive' },
    });

    // Audit-log the soft delete
    await this.audit.log({
      userId,
      churchId,
      entity: 'member',
      action: 'DELETE',
      entityId: id,
      oldValues: { status: existing.status },
      newValues: { status: 'inactive' },
    });

    this.logger.log(`Member soft-deleted: ${id}`);
  }

  /**
   * Restores a soft-deleted member by setting their status back to active.
   *
   * @param id - Member UUID
   * @param churchId - Church ID for tenant scoping
   * @param userId - ID of the user performing the restore (for audit)
   * @throws NotFoundException if member not found
   */
  async restoreMember(id: string, churchId: string, userId: string): Promise<MemberResponseDto> {
    const existing = await this.prisma.member.findUnique({
      where: { id },
    });

    if (
      !existing ||
      existing.church_id !== churchId ||
      !this.branchScope.isVisible(undefined, existing.branch_id)
    ) {
      throw new NotFoundException('Member not found');
    }

    if (existing.status !== 'inactive') {
      return this.mapToResponseDto(existing);
    }

    const member = await this.prisma.member.update({
      where: { id },
      data: { status: 'active' },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'member',
      action: 'UPDATE',
      entityId: id,
      oldValues: { status: 'inactive' },
      newValues: { status: 'active' },
    });

    this.logger.log(`Member restored: ${id}`);

    return this.mapToResponseDto(member);
  }

  /**
   * Archives a member by setting archived_at. Archived members drop out of
   * active member lists (active lists filter archived_at: null) but their
   * details stay reachable, and they can be restored or permanently deleted.
   *
   * @param id - Member UUID
   * @param churchId - Church ID for tenant scoping
   * @param userId - Acting user ID for audit logging
   * @returns Updated member response
   * @throws NotFoundException if the member is missing or not in this church
   * @throws ConflictException if the member is already archived
   */
  async archiveMember(id: string, churchId: string, userId: string): Promise<MemberResponseDto> {
    const existing = await this.prisma.member.findUnique({
      where: { id },
    });

    if (
      !existing ||
      existing.church_id !== churchId ||
      !this.branchScope.isVisible(undefined, existing.branch_id)
    ) {
      throw new NotFoundException('Member not found');
    }

    if (existing.archived_at) {
      throw new ConflictException('Member is already archived');
    }

    const member = await this.prisma.member.update({
      where: { id },
      data: { archived_at: new Date() },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'member',
      action: 'ARCHIVE',
      entityId: id,
      oldValues: { archived_at: existing.archived_at },
      newValues: { archived_at: member.archived_at },
    });

    this.logger.log(`Member archived: ${id}`);

    return this.mapToResponseDto(member);
  }

  /**
   * Restores an archived member by clearing archived_at.
   *
   * @param id - Member UUID
   * @param churchId - Church ID for tenant scoping
   * @param userId - Acting user ID for audit logging
   * @returns Updated member response
   * @throws NotFoundException if the member is missing or not in this church
   * @throws ConflictException if the member is not currently archived
   */
  async restoreArchivedMember(
    id: string,
    churchId: string,
    userId: string,
  ): Promise<MemberResponseDto> {
    const existing = await this.prisma.member.findUnique({
      where: { id },
    });

    if (
      !existing ||
      existing.church_id !== churchId ||
      !this.branchScope.isVisible(undefined, existing.branch_id)
    ) {
      throw new NotFoundException('Member not found');
    }

    if (!existing.archived_at) {
      throw new ConflictException('Member is not archived');
    }

    const member = await this.prisma.member.update({
      where: { id },
      data: { archived_at: null },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'member',
      action: 'RESTORE',
      entityId: id,
      oldValues: { archived_at: existing.archived_at },
      newValues: { archived_at: null },
    });

    this.logger.log(`Member restored from archive: ${id}`);

    return this.mapToResponseDto(member);
  }

  /**
   * Performs full-text search on members using PostgreSQL.
   *
   * Falls back to ILIKE search for simplicity and portability.
   * Matches against first_name, last_name, email, and phone.
   *
   * @param churchId - Church ID for tenant scoping
   * @param searchTerm - Search term
   * @param limit - Max results (default 20)
   * @returns Matching members
   */
  async searchMembers(
    churchId: string,
    searchTerm: string,
    limit = 20,
    viewerPermissions: string[] = [],
    viewer?: ViewerScope | null,
    requestedBranchId?: string,
  ): Promise<MemberResponseDto[]> {
    const term = searchTerm.trim();

    if (!term) {
      return [];
    }

    const scope = this.branchScope.resolve(viewer);

    const members = await this.prisma.member.findMany({
      where: {
        church_id: churchId,
        ...(scope.churchOnly
          ? requestedBranchId
            ? { branch_id: requestedBranchId }
            : {}
          : scope.branchId
            ? { branch_id: scope.branchId }
            : {}),
        OR: [
          { first_name: { contains: term, mode: 'insensitive' } },
          { last_name: { contains: term, mode: 'insensitive' } },
          { email: { contains: term, mode: 'insensitive' } },
          { phone: { contains: term, mode: 'insensitive' } },
        ],
      },
      take: limit,
      orderBy: { created_at: 'desc' },
    });

    return members.map((m) => this.mapToResponseDto(m, viewerPermissions));
  }

  /**
   * Bulk imports members from a CSV/JSON array.
   *
   * Validates each record, skips duplicates, and reports errors.
   *
   * @param records - Array of member data objects
   * @param churchId - Church ID for tenant scoping
   * @param userId - ID of the user performing the import (for audit)
   * @returns Import results with created count, errors, and dry-run flag
   */
  async bulkImportMembers(
    records: CreateMemberDto[],
    churchId: string,
    userId: string,
    dryRun = false,
  ): Promise<{
    created: number;
    errors: Array<{ row: number; message: string }>;
    dryRun: boolean;
  }> {
    if (!Array.isArray(records) || records.length < 1 || records.length > 100)
      throw new BadRequestException('Import between 1 and 100 members per batch');
    if (typeof dryRun !== 'boolean') throw new BadRequestException('dryRun must be a boolean');
    const branches = await this.prisma.branch.findMany({
      where: { church_id: churchId },
      select: { id: true },
    });
    const validBranches = new Set(branches.map((branch) => branch.id));
    const errors: Array<{ row: number; message: string }> = [];
    let created = 0;

    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      const rowNum = i + 1;

      try {
        const validation = await validate(plainToInstance(CreateMemberDto, record), {
          whitelist: true,
          forbidNonWhitelisted: true,
          forbidUnknownValues: true,
        });
        if (validation.length) {
          errors.push({
            row: rowNum,
            message:
              validation.flatMap((issue) => Object.values(issue.constraints ?? {})).join('; ') ||
              'Invalid member data',
          });
          continue;
        }
        const branchId = this.requestContext.branchIdForWrite(churchId, record.branchId);
        if (branchId && !validBranches.has(branchId)) {
          errors.push({ row: rowNum, message: 'Branch does not belong to this church' });
          continue;
        }
        if (record.dateOfBirth && Number.isNaN(new Date(record.dateOfBirth).getTime())) {
          errors.push({ row: rowNum, message: 'Invalid date of birth' });
          continue;
        }
        // Validate required fields
        if (!record.firstName || !record.lastName) {
          errors.push({ row: rowNum, message: 'First name and last name are required' });
          continue;
        }

        // Check for duplicate phone
        if (record.phone) {
          const existing = await this.prisma.member.findFirst({
            where: {
              church_id: churchId,
              phone: record.phone,
            },
          });

          if (existing) {
            errors.push({ row: rowNum, message: `Phone ${record.phone} already exists` });
            continue;
          }
        }

        // Check for duplicate email
        if (record.email) {
          const existingEmail = await this.prisma.member.findFirst({
            where: {
              church_id: churchId,
              email: record.email,
            },
          });

          if (existingEmail) {
            errors.push({ row: rowNum, message: `Email ${record.email} already exists` });
            continue;
          }
        }

        if (!dryRun) {
          await this.prisma.member.create({
            data: {
              church_id: churchId,
              branch_id: this.requestContext.branchIdForWrite(churchId, record.branchId) ?? null,
              first_name: record.firstName,
              last_name: record.lastName,
              email: record.email || null,
              phone: record.phone || null,
              whatsapp_number: record.whatsappNumber || null,
              date_of_birth: record.dateOfBirth ? new Date(record.dateOfBirth) : null,
              gender: record.gender || null,
              address: record.address || null,
              city: record.city || null,
              state: record.state || null,
              custom_fields: (record.customFields as Prisma.InputJsonValue) || Prisma.JsonNull,
              notes: record.notes || null,
            },
          });
        }

        created++;
      } catch (error) {
        errors.push({
          row: rowNum,
          message:
            subscriptionError(error)?.message ??
            (error instanceof Error ? error.message : 'Unknown error'),
        });
      }
    }

    // Audit-log the import
    if (!dryRun && created > 0) {
      await this.audit.log({
        userId,
        churchId,
        entity: 'member',
        action: 'CREATE',
        entityId: 'bulk-import',
        newValues: { importedCount: created, errorCount: errors.length },
      });
    }

    this.logger.log(
      `Bulk import ${dryRun ? '(dry run) ' : ''}completed: ${created} created, ${errors.length} errors`,
    );

    return { created, errors, dryRun };
  }

  /**
   * Exports members as CSV data.
   *
   * @param churchId - Church ID for tenant scoping
   * @param status - Optional status filter
   * @param branchId - Optional branch filter
   * @returns CSV string
   */
  async exportMembersCsv(
    churchId: string,
    status?: string,
    branchId?: string,
    viewerPermissions: string[] = [],
    viewer?: ViewerScope | null,
  ): Promise<string> {
    const scope = this.branchScope.resolve(viewer);
    const where: Prisma.MemberWhereInput = { church_id: churchId };

    if (!scope.churchOnly && scope.branchId) {
      where.branch_id = scope.branchId;
    }

    if (status) {
      where.status = status as 'active' | 'inactive' | 'suspended' | 'transferred';
    }

    if (branchId && scope.churchOnly) {
      where.branch_id = branchId;
    }

    const members = await this.prisma.member.findMany({
      where,
      orderBy: { created_at: 'desc' },
      select: {
        id: true,
        first_name: true,
        last_name: true,
        email: true,
        phone: true,
        whatsapp_number: true,
        date_of_birth: true,
        gender: true,
        address: true,
        city: true,
        state: true,
        status: true,
        member_since: true,
        notes: true,
        created_at: true,
      },
    });

    // CSV header
    const headers = [
      'ID',
      'First Name',
      'Last Name',
      'Email',
      'Phone',
      'WhatsApp Number',
      'Date of Birth',
      'Gender',
      'Address',
      'City',
      'State',
      'Status',
      'Member Since',
      'Notes',
      'Created At',
    ];

    const hasSensitiveAccess = viewerPermissions.some((permission) =>
      ['members:update', 'members:delete'].includes(permission),
    );

    const rows = members.map((m) => [
      m.id,
      m.first_name,
      m.last_name,
      hasSensitiveAccess ? m.email || '' : '',
      hasSensitiveAccess ? m.phone || '' : '',
      hasSensitiveAccess ? m.whatsapp_number || '' : '',
      hasSensitiveAccess ? m.date_of_birth?.toISOString().split('T')[0] || '' : '',
      hasSensitiveAccess ? m.gender || '' : '',
      hasSensitiveAccess ? m.address || '' : '',
      hasSensitiveAccess ? m.city || '' : '',
      hasSensitiveAccess ? m.state || '' : '',
      m.status,
      m.member_since.toISOString().split('T')[0],
      hasSensitiveAccess ? m.notes || '' : '',
      m.created_at.toISOString(),
    ]);

    // Escape CSV values (handle commas, quotes, newlines)
    const escapeCsv = (value: string): string => {
      if (/^[\s\u0000-\u001f]*[=+@-]/.test(value)) value = `'${value}`;
      if (value.includes(',') || value.includes('"') || value.includes('\n')) {
        return `"${value.replace(/"/g, '""')}"`;
      }
      return value;
    };

    const csvLines = [headers.join(','), ...rows.map((row) => row.map(escapeCsv).join(','))];

    this.logger.log(`Exported ${members.length} members as CSV`);

    return csvLines.join('\n');
  }

  /**
   * Exports members as XLSX buffer.
   *
   * @param churchId - Church ID for tenant scoping
   * @param status - Optional status filter
   * @param branchId - Optional branch filter
   * @returns XLSX buffer
   */
  async exportMembersXlsx(
    churchId: string,
    status?: string,
    branchId?: string,
    viewerPermissions: string[] = [],
    viewer?: ViewerScope | null,
  ): Promise<Buffer> {
    const ExcelJS = await import('exceljs');

    const scope = this.branchScope.resolve(viewer);
    const where: Prisma.MemberWhereInput = { church_id: churchId };

    if (!scope.churchOnly && scope.branchId) {
      where.branch_id = scope.branchId;
    }

    if (status) {
      where.status = status as 'active' | 'inactive' | 'suspended' | 'transferred';
    }

    if (branchId && scope.churchOnly) {
      where.branch_id = branchId;
    }

    const members = await this.prisma.member.findMany({
      where,
      orderBy: { created_at: 'desc' },
      select: {
        id: true,
        first_name: true,
        last_name: true,
        email: true,
        phone: true,
        whatsapp_number: true,
        date_of_birth: true,
        gender: true,
        address: true,
        city: true,
        state: true,
        status: true,
        member_since: true,
        notes: true,
        created_at: true,
      },
    });

    const workbook = new ExcelJS.Workbook();
    initializeWorkbook(workbook);

    const hasSensitiveAccess = viewerPermissions.some((permission) =>
      ['members:update', 'members:delete'].includes(permission),
    );

    const columns = [
      { label: 'ID', key: 'id', width: 36 },
      { label: 'First Name', key: 'firstName', width: 15 },
      { label: 'Last Name', key: 'lastName', width: 15 },
      { label: 'Email', key: 'email', width: 25 },
      { label: 'Phone', key: 'phone', width: 18 },
      { label: 'WhatsApp Number', key: 'whatsappNumber', width: 18 },
      { label: 'Date of Birth', key: 'dateOfBirth', width: 14 },
      { label: 'Gender', key: 'gender', width: 10 },
      { label: 'Address', key: 'address', width: 30 },
      { label: 'City', key: 'city', width: 15 },
      { label: 'State', key: 'state', width: 15 },
      { label: 'Status', key: 'status', width: 12 },
      { label: 'Member Since', key: 'memberSince', width: 14 },
      { label: 'Notes', key: 'notes', width: 30 },
      { label: 'Created At', key: 'createdAt', width: 20 },
    ];
    const data = members.map((m) => ({
      id: m.id,
      firstName: m.first_name,
      lastName: m.last_name,
      email: hasSensitiveAccess ? m.email || '' : '',
      phone: hasSensitiveAccess ? m.phone || '' : '',
      whatsappNumber: hasSensitiveAccess ? m.whatsapp_number || '' : '',
      dateOfBirth: hasSensitiveAccess ? m.date_of_birth?.toISOString().split('T')[0] || '' : '',
      gender: hasSensitiveAccess ? m.gender || '' : '',
      address: hasSensitiveAccess ? m.address || '' : '',
      city: hasSensitiveAccess ? m.city || '' : '',
      state: hasSensitiveAccess ? m.state || '' : '',
      status: m.status,
      memberSince: m.member_since.toISOString().split('T')[0],
      notes: hasSensitiveAccess ? m.notes || '' : '',
      createdAt: m.created_at.toISOString(),
    }));
    addDesignedSheet(
      workbook,
      {
        name: 'Members',
        columns,
        data,
        metadata: [{ label: 'Scope', value: where.branch_id ? 'Selected branch' : 'All branches' }],
      },
      0,
    );

    const buffer = await workbook.xlsx.writeBuffer();

    this.logger.log(`Exported ${members.length} members as XLSX`);

    return Buffer.from(buffer);
  }

  /**
   * Generates a QR code data string for a member.
   *
   * The QR code encodes the member ID for check-in scanning.
   *
   * @param id - Member UUID
   * @param churchId - Church ID for tenant scoping
   * @returns QR code data string
   * @throws NotFoundException if member not found
   */
  async generateMemberQRCode(
    id: string,
    churchId: string,
  ): Promise<{ qrData: string; memberId: string }> {
    const member = await this.prisma.member.findUnique({
      where: { id },
      select: { id: true, church_id: true, branch_id: true },
    });

    if (
      !member ||
      member.church_id !== churchId ||
      !this.branchScope.isVisible(undefined, member.branch_id)
    ) {
      throw new NotFoundException('Member not found');
    }

    // QR data format: CHURCHOS:MEMBER:<id>
    const qrData = `CHURCHOS:MEMBER:${member.id}`;

    return { qrData, memberId: member.id };
  }

  /**
   * Retrieves giving history for a member.
   *
   * @param id - Member UUID
   * @param churchId - Church ID for tenant scoping
   * @returns Array of giving transactions
   * @throws NotFoundException if member not found
   */
  async getMemberGivingHistory(
    id: string,
    churchId: string,
  ): Promise<
    Array<{
      id: string;
      amount: number;
      currency: string;
      categoryId: string;
      status: string;
      givingDate: string;
      createdAt: string;
    }>
  > {
    const member = await this.prisma.member.findUnique({
      where: { id },
      select: { id: true, church_id: true, branch_id: true },
    });

    if (
      !member ||
      member.church_id !== churchId ||
      !this.branchScope.isVisible(undefined, member.branch_id)
    ) {
      throw new NotFoundException('Member not found');
    }

    const transactions = await this.prisma.transaction.findMany({
      where: { member_id: id },
      orderBy: [{ giving_date: 'desc' }, { created_at: 'desc' }],
      select: {
        id: true,
        amount: true,
        currency: true,
        category_id: true,
        status: true,
        giving_date: true,
        created_at: true,
      },
    });

    return transactions.map((t) => ({
      id: t.id,
      amount: t.amount,
      currency: t.currency,
      categoryId: t.category_id ?? '',
      status: t.status,
      givingDate: (t.giving_date ?? t.created_at).toISOString().slice(0, 10),
      createdAt: t.created_at.toISOString(),
    }));
  }

  /**
   * Retrieves attendance history for a member.
   *
   * @param id - Member UUID
   * @param churchId - Church ID for tenant scoping
   * @returns Array of attendance records
   * @throws NotFoundException if member not found
   */
  async getMemberAttendanceHistory(
    id: string,
    churchId: string,
    viewer?: ViewerScope | null,
  ): Promise<
    Array<{
      id: string;
      checkInAt: string;
      serviceName: string;
      source: string;
      createdAt: string;
    }>
  > {
    const member = await this.prisma.member.findUnique({
      where: { id },
      select: { id: true, church_id: true, branch_id: true },
    });

    if (
      !member ||
      member.church_id !== churchId ||
      !this.branchScope.isVisible(undefined, member.branch_id)
    ) {
      throw new NotFoundException('Member not found');
    }

    const attendance = await this.prisma.attendance.findMany({
      where: {
        member_id: id,
        church_id: churchId,
        ...(viewer?.permissions && !viewer.permissions.includes('events:checkin:read')
          ? { event_id: null }
          : {}),
      },
      orderBy: { checkin_at: 'desc' },
      include: {
        service: {
          select: {
            name: true,
          },
        },
      },
    });

    return attendance.map((a) => ({
      id: a.id,
      checkInAt: a.checkin_at.toISOString(),
      serviceName: a.service?.name || 'Unknown Service',
      source: a.source,
      createdAt: a.created_at.toISOString(),
    }));
  }

  /**
   * Adds an admin note to a member.
   *
   * @param id - Member UUID
   * @param note - Note content
   * @param churchId - Church ID for tenant scoping
   * @param userId - ID of the user adding the note (for audit)
   * @throws NotFoundException if member not found
   */
  async addMemberNote(
    id: string,
    note: string,
    churchId: string,
    userId: string,
  ): Promise<{ success: boolean }> {
    const member = await this.prisma.member.findUnique({
      where: { id },
      select: { id: true, church_id: true, branch_id: true, notes: true, archived_at: true },
    });

    if (
      !member ||
      member.church_id !== churchId ||
      !this.branchScope.isVisible(undefined, member.branch_id)
    ) {
      throw new NotFoundException('Member not found');
    }

    if (member.archived_at) {
      throw new NotFoundException('Member not found');
    }

    // Append note with timestamp
    const timestamp = new Date().toISOString();
    const newNote = `[${timestamp}] ${note}`;
    const updatedNotes = member.notes ? `${member.notes}\n${newNote}` : newNote;

    await this.prisma.member.update({
      where: { id },
      data: { notes: updatedNotes },
    });

    // Audit-log the note addition
    await this.audit.log({
      userId,
      churchId,
      entity: 'member',
      action: 'UPDATE',
      entityId: id,
      newValues: { action: 'note_added', note },
    });

    this.logger.log(`Note added to member ${id}`);

    return { success: true };
  }

  /**
   * Maps a Prisma Member record to a response DTO.
   *
   * @param member - Raw Prisma member record
   * @returns Formatted MemberResponseDto
   */
  private mapToResponseDto(
    member: {
      id: string;
      church_id: string;
      branch_id: string | null;
      first_name: string;
      last_name: string;
      email: string | null;
      phone: string | null;
      whatsapp_number: string | null;
      date_of_birth: Date | null;
      gender: string | null;
      address: string | null;
      city: string | null;
      state: string | null;
      status: string;
      member_since: Date;
      photo_url: string | null;
      custom_fields: Prisma.JsonValue;
      notes: string | null;
      archived_at: Date | null;
      created_at: Date;
      updated_at: Date;
    },
    viewerPermissions: string[] = [],
  ): MemberResponseDto {
    const hasSensitiveAccess = viewerPermissions.some((permission) =>
      ['members:update', 'members:delete'].includes(permission),
    );

    return {
      memberId: member.id,
      churchId: member.church_id,
      branchId: member.branch_id || undefined,
      firstName: member.first_name,
      lastName: member.last_name,
      email: hasSensitiveAccess ? member.email || undefined : undefined,
      phone: hasSensitiveAccess ? member.phone || undefined : undefined,
      whatsappNumber: hasSensitiveAccess ? member.whatsapp_number || undefined : undefined,
      dateOfBirth: hasSensitiveAccess
        ? member.date_of_birth?.toISOString() || undefined
        : undefined,
      gender: hasSensitiveAccess ? member.gender || undefined : undefined,
      address: hasSensitiveAccess ? member.address || undefined : undefined,
      city: hasSensitiveAccess ? member.city || undefined : undefined,
      state: hasSensitiveAccess ? member.state || undefined : undefined,
      status: member.status,
      memberSince: member.member_since.toISOString(),
      photoUrl: member.photo_url || undefined,
      customFields:
        member.custom_fields && typeof member.custom_fields === 'object'
          ? (member.custom_fields as Record<string, unknown>)
          : undefined,
      notes: hasSensitiveAccess ? member.notes || undefined : undefined,
      archivedAt: member.archived_at?.toISOString(),
      createdAt: member.created_at.toISOString(),
      updatedAt: member.updated_at.toISOString(),
    };
  }
}
