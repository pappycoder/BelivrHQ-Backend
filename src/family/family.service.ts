/**
 * @file family.service.ts
 * @description Business logic for family and family member management.
 *
 * Handles CRUD operations for families and their member associations.
 * A Family groups related church members (e.g., a household). Each family
 * has a head member and can contain multiple FamilyMember links with
 * relationship types (spouse, child, parent, etc.).
 *
 * All queries are scoped by church_id for multi-tenant data isolation.
 * All mutations are audit-logged.
 *
 * @module family/family.service
 * @since 1.0.0
 */

import { Injectable, Logger, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLoggingService } from '../common/services/audit-logging.service';
import { CreateFamilyDto, AddFamilyMemberDto } from './dto/create-family.dto';
import { UpdateFamilyDto } from './dto/update-family.dto';
import { ListFamiliesDto } from './dto/list-families.dto';
import { FamilyResponseDto } from './dto/family-response.dto';
import { Prisma } from '@prisma/client';
import { BranchScopeService, ViewerScope } from '../common/services/branch-scope.service';

@Injectable()
export class FamilyService {
  private readonly logger = new Logger(FamilyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLoggingService,
    private readonly branchScope: BranchScopeService,
  ) {}

  /**
   * Creates a new family record.
   *
   * @param dto - Family creation data (name, optional head member ID)
   * @param churchId - Church ID for tenant scoping
   * @param userId - ID of the user creating the family (for audit)
   * @returns Created family response
   */
  async createFamily(
    dto: CreateFamilyDto,
    churchId: string,
    userId: string,
    viewer?: ViewerScope | null,
  ): Promise<FamilyResponseDto> {
    const scope = this.branchScope.resolve(viewer);
    const family = await this.prisma.family.create({
      data: {
        church_id: churchId,
        branch_id: scope.churchOnly ? dto.branchId : scope.branchId,
        name: dto.name,
        head_id: dto.headId,
      },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'family',
      action: 'CREATE',
      entityId: family.id,
      newValues: { name: dto.name },
    });

    this.logger.log(`Family created: ${family.name} (${family.id})`);
    return this.mapToResponseDto(family, []);
  }

  /**
   * Lists families for a church with pagination and optional search.
   *
   * @param churchId - Church ID for tenant scoping
   * @param query - List query parameters (pagination, search)
   * @returns Paginated list of families with their members
   */
  async listFamilies(
    churchId: string,
    query: ListFamiliesDto,
    viewer?: ViewerScope | null,
  ): Promise<{ data: FamilyResponseDto[]; total: number }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.FamilyWhereInput = {
      church_id: churchId,
      archived_at: query.archived === true ? { not: null } : null,
    };
    const scope = this.branchScope.resolve(viewer);
    if (!scope.churchOnly) {
      where.OR = [{ branch_id: scope.branchId ?? null }, { branch_id: null }];
    } else if (scope.churchOnly && query.branchId) {
      where.OR = [{ branch_id: query.branchId }, { branch_id: null }];
    }

    if (query.search) {
      where.name = { contains: query.search, mode: 'insensitive' };
    }

    const order = query.sortOrder ?? 'asc';
    const orderBy: Prisma.FamilyOrderByWithRelationInput[] =
      query.sortBy === 'memberCount'
        ? [{ family_members: { _count: order } }, { name: 'asc' }]
        : query.sortBy === 'createdAt'
          ? [{ created_at: order }, { name: 'asc' }]
          : [{ name: order }];

    const [families, total] = await Promise.all([
      this.prisma.family.findMany({
        where,
        orderBy,
        skip,
        take: limit,
        include: {
          family_members: {
            include: {
              member: {
                select: { id: true, first_name: true, last_name: true },
              },
            },
          },
        },
      }),
      this.prisma.family.count({ where }),
    ]);

    return {
      data: families.map((f) => this.mapToResponseDto(f, f.family_members)),
      total,
    };
  }

  /**
   * Gets a single family by ID with its member associations.
   *
   * @param familyId - Family UUID
   * @param churchId - Church ID for tenant scoping
   * @returns Family response with member details
   * @throws NotFoundException if family doesn't exist or belongs to another church
   */
  async getFamilyById(
    familyId: string,
    churchId: string,
    viewer?: ViewerScope | null,
  ): Promise<FamilyResponseDto> {
    const scope = this.branchScope.resolve(viewer);
    const family = await this.prisma.family.findFirst({
      where: {
        id: familyId,
        church_id: churchId,
        ...(!scope.churchOnly
          ? { OR: [{ branch_id: scope.branchId ?? null }, { branch_id: null }] }
          : {}),
      },
      include: {
        family_members: {
          include: {
            member: {
              select: { id: true, first_name: true, last_name: true },
            },
          },
        },
      },
    });

    if (!family) {
      throw new NotFoundException('Family not found');
    }

    return this.mapToResponseDto(family, family.family_members);
  }

  /**
   * Updates a family record with partial data.
   *
   * @param familyId - Family UUID to update
   * @param dto - Update data (name, headId — all optional)
   * @param churchId - Church ID for tenant scoping
   * @param userId - ID of the user performing the update (for audit)
   * @returns Updated family response
   * @throws NotFoundException if family doesn't exist
   */
  async updateFamily(
    familyId: string,
    dto: UpdateFamilyDto,
    churchId: string,
    userId: string,
    viewer?: ViewerScope | null,
  ): Promise<FamilyResponseDto> {
    const existing = await this.prisma.family.findFirst({
      where: { id: familyId, church_id: churchId },
    });

    if (
      !existing ||
      (existing.branch_id && !this.branchScope.isVisible(viewer, existing.branch_id))
    ) {
      throw new NotFoundException('Family not found');
    }

    if (existing.archived_at) {
      throw new NotFoundException('Family not found');
    }

    const updateData: Record<string, unknown> = {};
    if (dto.name !== undefined) updateData.name = dto.name;
    if (dto.headId !== undefined) updateData.head_id = dto.headId;

    if (Object.keys(updateData).length === 0) {
      return this.getFamilyById(familyId, churchId, viewer);
    }

    await this.prisma.family.update({
      where: { id: familyId },
      data: updateData,
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'family',
      action: 'UPDATE',
      entityId: familyId,
      oldValues: { name: existing.name, headId: existing.head_id },
      newValues: updateData,
    });

    this.logger.log(`Family updated: ${familyId}`);
    return this.getFamilyById(familyId, churchId, viewer);
  }

  /**
   * Deletes a family and all its member associations.
   *
   * @param familyId - Family UUID to delete
   * @param churchId - Church ID for tenant scoping
   * @param userId - ID of the user performing the deletion (for audit)
   * @throws NotFoundException if family doesn't exist
   */
  async deleteFamily(familyId: string, churchId: string, userId: string): Promise<void> {
    const existing = await this.prisma.family.findFirst({
      where: { id: familyId, church_id: churchId },
    });

    if (
      !existing ||
      (existing.branch_id && !this.branchScope.isVisible(undefined, existing.branch_id))
    ) {
      throw new NotFoundException('Family not found');
    }

    await this.prisma.familyMember.deleteMany({ where: { family_id: familyId } });
    await this.prisma.family.delete({ where: { id: familyId } });

    await this.audit.log({
      userId,
      churchId,
      entity: 'family',
      action: 'DELETE',
      entityId: familyId,
      oldValues: { name: existing.name },
    });

    this.logger.log(`Family deleted: ${familyId}`);
  }

  /**
   * Adds a profile member to a family.
   *
   * @param familyId - Family UUID to add the member to
   * @param dto - Member data (profileId, optional relationship, role)
   * @param churchId - Church ID for tenant scoping
   * @param userId - ID of the user performing the action (for audit)
   * @returns Updated family response with new member
   * @throws NotFoundException if family or profile doesn't exist
   * @throws ConflictException if member already belongs to this family
   */
  async addMember(
    familyId: string,
    dto: AddFamilyMemberDto,
    churchId: string,
    userId: string,
    viewer?: ViewerScope | null,
  ): Promise<FamilyResponseDto> {
    const family = await this.prisma.family.findFirst({
      where: { id: familyId, church_id: churchId },
    });

    if (!family || (family.branch_id && !this.branchScope.isVisible(viewer, family.branch_id))) {
      throw new NotFoundException('Family not found');
    }

    if (family.archived_at) {
      throw new NotFoundException('Family not found');
    }

    const member = await this.prisma.member.findFirst({
      where: { id: dto.memberId, church_id: churchId },
    });

    if (!member) {
      throw new NotFoundException('Member not found');
    }

    const existingLink = await this.prisma.familyMember.findUnique({
      where: { family_id_member_id: { family_id: familyId, member_id: dto.memberId } },
    });

    if (existingLink) {
      throw new ConflictException('Member is already in this family');
    }

    await this.prisma.familyMember.create({
      data: {
        family_id: familyId,
        member_id: dto.memberId,
        relationship: dto.relationship,
        is_head: dto.isHead ?? false,
      },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'family_member',
      action: 'CREATE',
      entityId: familyId,
      newValues: { memberId: dto.memberId, relationship: dto.relationship },
    });

    this.logger.log(`Member added to family: ${dto.memberId} → ${familyId}`);
    return this.getFamilyById(familyId, churchId);
  }

  /**
   * Removes a profile member from a family.
   *
   * @param familyId - Family UUID
   * @param memberId - Profile UUID to remove
   * @param churchId - Church ID for tenant scoping
   * @param userId - ID of the user performing the removal (for audit)
   * @returns Updated family response without the removed member
   * @throws NotFoundException if family or membership record doesn't exist
   */
  async removeMember(
    familyId: string,
    memberId: string,
    churchId: string,
    userId: string,
    viewer?: ViewerScope | null,
  ): Promise<FamilyResponseDto> {
    const family = await this.prisma.family.findFirst({
      where: { id: familyId, church_id: churchId },
    });

    if (!family || (family.branch_id && !this.branchScope.isVisible(viewer, family.branch_id))) {
      throw new NotFoundException('Family not found');
    }

    if (family.archived_at) {
      throw new NotFoundException('Family not found');
    }

    const link = await this.prisma.familyMember.findUnique({
      where: { family_id_member_id: { family_id: familyId, member_id: memberId } },
    });

    if (!link) {
      throw new NotFoundException('Member is not in this family');
    }

    await this.prisma.familyMember.delete({
      where: { family_id_member_id: { family_id: familyId, member_id: memberId } },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'family_member',
      action: 'DELETE',
      entityId: familyId,
      oldValues: { memberId },
    });

    this.logger.log(`Member removed from family: ${memberId} ← ${familyId}`);
    return this.getFamilyById(familyId, churchId);
  }

  /**
   * Archives a family by setting archived_at. Archived families drop out of
   * active family lists (they stay reachable by ID and can be restored).
   *
   * @param familyId - Family UUID
   * @param churchId - Church ID for tenant scoping
   * @param userId - Acting user ID for audit logging
   * @returns Updated family response
   * @throws NotFoundException if the family is missing or not in this church
   * @throws ConflictException if the family is already archived
   */
  async archive(
    familyId: string,
    churchId: string,
    userId: string,
    viewer?: ViewerScope | null,
  ): Promise<FamilyResponseDto> {
    const existing = await this.prisma.family.findFirst({
      where: { id: familyId, church_id: churchId },
    });

    if (
      !existing ||
      (existing.branch_id && !this.branchScope.isVisible(viewer, existing.branch_id))
    ) {
      throw new NotFoundException('Family not found');
    }

    if (existing.archived_at) {
      throw new ConflictException('Family is already archived');
    }

    await this.prisma.family.update({
      where: { id: familyId },
      data: { archived_at: new Date() },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'family',
      action: 'ARCHIVE',
      entityId: familyId,
      oldValues: { archived_at: existing.archived_at },
      newValues: { archived_at: new Date() },
    });

    this.logger.log(`Family archived: ${familyId}`);
    return this.getFamilyById(familyId, churchId);
  }

  /**
   * Restores an archived family by clearing archived_at.
   *
   * @param familyId - Family UUID
   * @param churchId - Church ID for tenant scoping
   * @param userId - Acting user ID for audit logging
   * @returns Updated family response
   * @throws NotFoundException if the family is missing or not in this church
   * @throws ConflictException if the family is not currently archived
   */
  async restore(
    familyId: string,
    churchId: string,
    userId: string,
    viewer?: ViewerScope | null,
  ): Promise<FamilyResponseDto> {
    const existing = await this.prisma.family.findFirst({
      where: { id: familyId, church_id: churchId },
    });

    if (
      !existing ||
      (existing.branch_id && !this.branchScope.isVisible(viewer, existing.branch_id))
    ) {
      throw new NotFoundException('Family not found');
    }

    if (!existing.archived_at) {
      throw new ConflictException('Family is not archived');
    }

    await this.prisma.family.update({
      where: { id: familyId },
      data: { archived_at: null },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'family',
      action: 'RESTORE',
      entityId: familyId,
      oldValues: { archived_at: existing.archived_at },
      newValues: { archived_at: null },
    });

    this.logger.log(`Family restored: ${familyId}`);
    return this.getFamilyById(familyId, churchId);
  }

  /**
   * Maps raw Prisma family + member data to a FamilyResponseDto.
   *
   * @param family - Raw family record from Prisma
   * @param members - Associated member records with profile details
   * @returns Formatted family response DTO
   */
  private mapToResponseDto(
    family: {
      id: string;
      church_id: string;
      name: string;
      head_id: string | null;
      archived_at: Date | null;
      created_at: Date;
    },
    members: Array<{
      id: string;
      member_id: string;
      relationship: string;
      is_head: boolean;
      member?: { id: string; first_name: string; last_name: string } | null;
    }>,
  ): FamilyResponseDto {
    return {
      familyId: family.id,
      churchId: family.church_id,
      name: family.name,
      headId: family.head_id ?? undefined,
      members: members.map((m) => ({
        id: m.id,
        memberId: m.member_id,
        firstName: m.member?.first_name ?? '',
        lastName: m.member?.last_name ?? '',
        relationship: m.relationship,
        isHead: m.is_head,
      })),
      archivedAt: family.archived_at?.toISOString(),
      createdAt: family.created_at.toISOString(),
    };
  }
}
