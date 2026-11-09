import { contentBranch } from '../common/services/content-branch';
/**
 * @file templates.service.ts
 * @description Business logic for message template management.
 *
 * Handles CRUD operations for reusable message templates used across
 * WhatsApp, SMS, and Email channels. Templates allow church admins to
 * create standardized messages for common communications:
 * - Welcome messages for new members
 * - Event reminders and invitations
 * - Giving receipt confirmations
 * - Prayer request acknowledgments
 * - Birthday/anniversary greetings
 *
 * All queries are scoped by church_id for multi-tenant data isolation.
 * All mutations are audit-logged.
 *
 * @module templates/templates.service
 * @since 1.0.0
 */

import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLoggingService } from '../common/services/audit-logging.service';
import { BranchScopeService, ViewerScope } from '../common/services/branch-scope.service';
import { CreateTemplateDto } from './dto/create-template.dto';
import { UpdateTemplateDto } from './dto/update-template.dto';
import { ListTemplatesDto } from './dto/list-templates.dto';
import { TemplateResponseDto } from './dto/template-response.dto';
import { Prisma } from '@prisma/client';

@Injectable()
export class TemplatesService {
  private readonly logger = new Logger(TemplatesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLoggingService,
    private readonly branchScope: BranchScopeService,
  ) {}

  /**
   * Creates a new message template.
   *
   * @param dto - Template creation data (name, content, channel, optional language)
   * @param churchId - Church ID for tenant scoping
   * @param userId - ID of the user creating the template (for audit)
   * @returns Created template response
   */
  async create(
    dto: CreateTemplateDto,
    churchId: string,
    userId: string,
    viewer?: ViewerScope | null,
  ): Promise<TemplateResponseDto> {
    const scope = this.branchScope.resolve(viewer);
    const branchId = await contentBranch(this.prisma, scope, churchId, dto.branchId);
    const template = await this.prisma.template.create({
      include: { branch: { select: { name: true } } },
      data: {
        church_id: churchId,
        branch_id: branchId,
        name: dto.name,
        content: dto.content,
        channel: dto.channel,
        language: dto.language || 'en',
        status: dto.status || 'draft',
        category: dto.category,
        variables: (dto.variables ?? []) as Prisma.InputJsonValue,
        external_id: dto.externalId,
      },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'template',
      action: 'CREATE',
      entityId: template.id,
      newValues: { name: dto.name, channel: dto.channel },
    });

    this.logger.log(`Template created: ${template.name} (${template.id})`);
    return this.mapToResponseDto(template);
  }

  /**
   * Lists templates with pagination and optional filters.
   *
   * @param churchId - Church ID for tenant scoping
   * @param query - List query parameters (pagination, channel, status, search)
   * @returns Paginated list of templates with total count
   */
  async findAll(
    churchId: string,
    query: ListTemplatesDto,
    viewer?: ViewerScope | null,
  ): Promise<{ data: TemplateResponseDto[]; total: number }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.TemplateWhereInput = {
      church_id: churchId,
      archived_at: query.archived === true ? { not: null } : null,
    };
    const scope = this.branchScope.resolve(viewer);
    if (!scope.churchOnly)
      where.AND = [{ OR: [{ branch_id: scope.branchId ?? null }, { branch_id: null }] }];
    else if (scope.churchOnly && query.branchId)
      where.AND = [{ OR: [{ branch_id: query.branchId }, { branch_id: null }] }];

    if (query.channel) where.channel = query.channel;
    if (query.status) where.status = query.status;
    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { content: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const sortFields = {
      name: 'name',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      channel: 'channel',
      status: 'status',
    } as const;
    const sortField = sortFields[query.sortBy ?? 'name'] ?? 'name';
    const orderBy: Prisma.TemplateOrderByWithRelationInput[] = [
      { [sortField]: query.sortOrder ?? 'asc' },
      { id: 'asc' },
    ];
    const [templates, total] = await Promise.all([
      this.prisma.template.findMany({
        include: { branch: { select: { name: true } } },
        where,
        orderBy,
        skip,
        take: limit,
      }),
      this.prisma.template.count({ where }),
    ]);

    return {
      data: templates.map((t) => this.mapToResponseDto(t)),
      total,
    };
  }

  /**
   * Gets a single template by ID.
   *
   * @param templateId - Template UUID
   * @param churchId - Church ID for tenant scoping
   * @returns Template response
   * @throws NotFoundException if template doesn't exist or belongs to another church
   */
  async findById(templateId: string, churchId: string): Promise<TemplateResponseDto> {
    const template = await this.prisma.template.findFirst({
      include: { branch: { select: { name: true } } },
      where: { id: templateId, church_id: churchId },
    });

    if (
      !template ||
      (template.branch_id && !this.branchScope.isVisible(undefined, template.branch_id))
    ) {
      throw new NotFoundException('Template not found');
    }

    return this.mapToResponseDto(template);
  }

  /**
   * Publishes a draft template, making it available for use in broadcasts.
   *
   * @param templateId - Template UUID to publish
   * @param churchId - Church ID for tenant scoping
   * @param userId - ID of the user performing the publish (for audit)
   * @returns Updated template response
   * @throws NotFoundException if template doesn't exist
   * @throws BadRequestException if template is already published or archived
   */
  async publish(
    templateId: string,
    churchId: string,
    userId: string,
  ): Promise<TemplateResponseDto> {
    const existing = await this.prisma.template.findFirst({
      include: { branch: { select: { name: true } } },
      where: { id: templateId, church_id: churchId },
    });

    if (
      !existing ||
      (existing.branch_id && !this.branchScope.isVisible(undefined, existing.branch_id))
    ) {
      throw new NotFoundException('Template not found');
    }

    if (existing.archived_at) {
      throw new NotFoundException('Template not found');
    }

    if (existing.status === 'published') {
      throw new BadRequestException('Template is already published');
    }

    if (existing.status === 'archived') {
      throw new BadRequestException('Cannot publish an archived template');
    }

    const updated = await this.prisma.template.update({
      include: { branch: { select: { name: true } } },
      where: { id: templateId },
      data: { status: 'published' },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'template',
      action: 'UPDATE',
      entityId: templateId,
      oldValues: { status: existing.status },
      newValues: { status: 'published' },
    });

    this.logger.log(`Template published: ${templateId}`);
    return this.mapToResponseDto(updated);
  }

  /**
   * Updates a template with partial data.
   *
   * @param templateId - Template UUID to update
   * @param dto - Update data (name, content, channel, status, language — all optional)
   * @param churchId - Church ID for tenant scoping
   * @param userId - ID of the user performing the update (for audit)
   * @returns Updated template response
   * @throws NotFoundException if template doesn't exist
   */
  async update(
    templateId: string,
    dto: UpdateTemplateDto,
    churchId: string,
    userId: string,
  ): Promise<TemplateResponseDto> {
    const existing = await this.prisma.template.findFirst({
      include: { branch: { select: { name: true } } },
      where: { id: templateId, church_id: churchId },
    });

    if (
      !existing ||
      (existing.branch_id && !this.branchScope.isVisible(undefined, existing.branch_id))
    ) {
      throw new NotFoundException('Template not found');
    }

    if (existing.archived_at) {
      throw new NotFoundException('Template not found');
    }

    const updateData: Record<string, unknown> = {};
    if (dto.branchId !== undefined) {
      const branchId = await contentBranch(
        this.prisma,
        this.branchScope.resolve(),
        churchId,
        dto.branchId,
      );
      updateData.branch_id = branchId;
    }
    if (dto.name !== undefined) updateData.name = dto.name;
    if (dto.content !== undefined) updateData.content = dto.content;
    if (dto.channel !== undefined) updateData.channel = dto.channel;
    if (dto.status !== undefined) updateData.status = dto.status;
    if (dto.language !== undefined) updateData.language = dto.language;
    if (dto.category !== undefined) updateData.category = dto.category;
    if (dto.variables !== undefined) updateData.variables = dto.variables as Prisma.InputJsonValue;
    if (dto.externalId !== undefined) updateData.external_id = dto.externalId;
    if (dto.externalStatus !== undefined) updateData.external_status = dto.externalStatus;

    if (Object.keys(updateData).length === 0) {
      return this.mapToResponseDto(existing);
    }

    const updated = await this.prisma.template.update({
      include: { branch: { select: { name: true } } },
      where: { id: templateId },
      data: updateData,
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'template',
      action: 'UPDATE',
      entityId: templateId,
      oldValues: { branchId: existing.branch_id, name: existing.name, status: existing.status },
      newValues: updateData,
    });

    this.logger.log(`Template updated: ${templateId}`);
    return this.mapToResponseDto(updated);
  }

  /**
   * Deletes a template permanently.
   *
   * @param templateId - Template UUID to delete
   * @param churchId - Church ID for tenant scoping
   * @param userId - ID of the user performing the deletion (for audit)
   * @throws NotFoundException if template doesn't exist
   */
  async delete(templateId: string, churchId: string, userId: string): Promise<void> {
    const existing = await this.prisma.template.findFirst({
      include: { branch: { select: { name: true } } },
      where: { id: templateId, church_id: churchId },
    });

    if (
      !existing ||
      (existing.branch_id && !this.branchScope.isVisible(undefined, existing.branch_id))
    ) {
      throw new NotFoundException('Template not found');
    }

    await this.prisma.template.delete({ where: { id: templateId } });

    await this.audit.log({
      userId,
      churchId,
      entity: 'template',
      action: 'DELETE',
      entityId: templateId,
      oldValues: { name: existing.name },
    });

    this.logger.log(`Template deleted: ${templateId}`);
  }

  /**
   * Archives a template by setting archived_at. Archived templates drop out of
   * active template lists (they stay reachable by ID and can be restored).
   *
   * @param templateId - Template UUID
   * @param churchId - Church ID for tenant scoping
   * @param userId - Acting user ID for audit logging
   * @returns Updated template response
   * @throws NotFoundException if the template is missing or not in this church
   * @throws ConflictException if the template is already archived
   */
  async archive(
    templateId: string,
    churchId: string,
    userId: string,
  ): Promise<TemplateResponseDto> {
    const existing = await this.prisma.template.findFirst({
      include: { branch: { select: { name: true } } },
      where: { id: templateId, church_id: churchId },
    });

    if (
      !existing ||
      (existing.branch_id && !this.branchScope.isVisible(undefined, existing.branch_id))
    ) {
      throw new NotFoundException('Template not found');
    }

    if (existing.archived_at) {
      throw new ConflictException('Template is already archived');
    }

    const updated = await this.prisma.template.update({
      include: { branch: { select: { name: true } } },
      where: { id: templateId },
      data: { archived_at: new Date() },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'template',
      action: 'ARCHIVE',
      entityId: templateId,
      oldValues: { archived_at: existing.archived_at },
      newValues: { archived_at: updated.archived_at },
    });

    this.logger.log(`Template archived: ${templateId}`);
    return this.mapToResponseDto(updated);
  }

  /**
   * Restores an archived template by clearing archived_at.
   *
   * @param templateId - Template UUID
   * @param churchId - Church ID for tenant scoping
   * @param userId - Acting user ID for audit logging
   * @returns Updated template response
   * @throws NotFoundException if the template is missing or not in this church
   * @throws ConflictException if the template is not currently archived
   */
  async restore(
    templateId: string,
    churchId: string,
    userId: string,
  ): Promise<TemplateResponseDto> {
    const existing = await this.prisma.template.findFirst({
      include: { branch: { select: { name: true } } },
      where: { id: templateId, church_id: churchId },
    });

    if (
      !existing ||
      (existing.branch_id && !this.branchScope.isVisible(undefined, existing.branch_id))
    ) {
      throw new NotFoundException('Template not found');
    }

    if (!existing.archived_at) {
      throw new ConflictException('Template is not archived');
    }

    const updated = await this.prisma.template.update({
      include: { branch: { select: { name: true } } },
      where: { id: templateId },
      data: { archived_at: null },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'template',
      action: 'RESTORE',
      entityId: templateId,
      oldValues: { archived_at: existing.archived_at },
      newValues: { archived_at: null },
    });

    this.logger.log(`Template restored: ${templateId}`);
    return this.mapToResponseDto(updated);
  }

  /**
   * Maps raw Prisma template data to a TemplateResponseDto.
   *
   * @param template - Raw template record from Prisma
   * @returns Formatted template response DTO
   */
  private mapToResponseDto(template: {
    id: string;
    church_id: string;
    branch_id?: string | null;
    branch?: { name: string } | null;
    name: string;
    content: string;
    channel: string;
    language: string;
    status: string;
    category: string | null;
    variables: Prisma.JsonValue;
    external_id: string | null;
    external_status: string | null;
    archived_at: Date | null;
    created_at: Date;
    updated_at: Date;
  }): TemplateResponseDto {
    return {
      templateId: template.id,
      branchId: template.branch_id ?? undefined,
      branchName: template.branch?.name,
      churchId: template.church_id,
      name: template.name,
      content: template.content,
      channel: template.channel,
      language: template.language,
      status: template.status,
      category: template.category ?? undefined,
      variables: Array.isArray(template.variables) ? (template.variables as string[]) : undefined,
      externalId: template.external_id ?? undefined,
      externalStatus: template.external_status ?? undefined,
      archivedAt: template.archived_at?.toISOString(),
      createdAt: template.created_at.toISOString(),
      updatedAt: template.updated_at.toISOString(),
    };
  }
}
