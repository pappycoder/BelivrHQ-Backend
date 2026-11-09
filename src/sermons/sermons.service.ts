import { contentBranch } from '../common/services/content-branch';
/**
 * @file sermons.service.ts
 * @description Business logic for sermon management.
 *
 * Handles sermon CRUD with full-text search, filtering, and pagination.
 * All queries are scoped by church_id for multi-tenant isolation.
 *
 * @module sermons/sermons.service
 * @since 1.0.0
 */

import { Injectable, Logger, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLoggingService } from '../common/services/audit-logging.service';
import { BranchScopeService, ViewerScope } from '../common/services/branch-scope.service';
import { CreateSermonDto } from './dto/create-sermon.dto';
import { UpdateSermonDto } from './dto/update-sermon.dto';
import { SermonResponseDto } from './dto/sermon-response.dto';
import { ListSermonsDto } from './dto/list-sermons.dto';
import { Prisma } from '@prisma/client';

/**
 * Service for managing sermon records.
 * Provides sermon CRUD with search, filtering, and pagination.
 */
@Injectable()
export class SermonsService {
  private readonly logger = new Logger(SermonsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLoggingService,
    private readonly branchScope: BranchScopeService,
  ) {}

  /**
   * Creates a new sermon record.
   */
  async createSermon(
    dto: CreateSermonDto,
    churchId: string,
    userId: string,
    viewer?: ViewerScope | null,
  ): Promise<SermonResponseDto> {
    const scope = this.branchScope.resolve(viewer);
    const branchId = await contentBranch(this.prisma, scope, churchId, dto.branchId);
    const sermon = await this.prisma.sermon.create({
      include: { branch: { select: { name: true } } },
      data: {
        church_id: churchId,
        branch_id: branchId,
        title: dto.title,
        speaker: dto.speaker,
        sermon_date: new Date(dto.sermonDate),
        scripture_reference: dto.scriptureReference,
        series_name: dto.seriesName,
        tags: dto.tags ?? [],
        audio_url: dto.audioUrl,
        video_url: dto.videoUrl,
        description: dto.description,
        duration_seconds: dto.durationSeconds,
      },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'sermon',
      action: 'CREATE',
      entityId: sermon.id,
      newValues: { title: dto.title },
    });

    this.logger.log(`Sermon created: ${sermon.id} (${dto.title})`);
    return this.mapSermonToDto(sermon);
  }

  /**
   * Lists sermons with pagination and filters.
   */
  async listSermons(
    dto: ListSermonsDto,
    churchId: string,
    viewer?: ViewerScope | null,
  ): Promise<{ data: SermonResponseDto[]; total: number }> {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.SermonWhereInput = {
      church_id: churchId,
      archived_at: dto.archived === true ? { not: null } : null,
    };
    const scope = this.branchScope.resolve(viewer);
    if (!scope.churchOnly)
      where.AND = [{ OR: [{ branch_id: scope.branchId ?? null }, { branch_id: null }] }];
    else if (scope.churchOnly && dto.branchId)
      where.AND = [{ OR: [{ branch_id: dto.branchId }, { branch_id: null }] }];

    if (dto.speaker) {
      where.speaker = { contains: dto.speaker, mode: 'insensitive' };
    }

    if (dto.series) {
      where.series_name = { contains: dto.series, mode: 'insensitive' };
    }

    if (dto.tag) {
      where.tags = { has: dto.tag };
    }

    if (dto.search) {
      where.OR = [
        { title: { contains: dto.search, mode: 'insensitive' } },
        { speaker: { contains: dto.search, mode: 'insensitive' } },
        { scripture_reference: { contains: dto.search, mode: 'insensitive' } },
        { series_name: { contains: dto.search, mode: 'insensitive' } },
      ];
    }

    if (dto.startDate) {
      where.sermon_date = {
        ...(where.sermon_date as Prisma.DateTimeFilter),
        gte: new Date(dto.startDate),
      };
    }
    if (dto.endDate) {
      where.sermon_date = {
        ...(where.sermon_date as Prisma.DateTimeFilter),
        lte: new Date(dto.endDate),
      };
    }

    // Accept both wire shapes: the web sends camelCase (createdAt/sermonDate),
    // older clients may send the snake_case column names.
    const normalizedSortBy =
      dto.sortBy === 'createdAt' || dto.sortBy === 'created_at'
        ? 'created_at'
        : dto.sortBy === 'sermonDate' || dto.sortBy === 'sermon_date'
          ? 'sermon_date'
          : (dto.sortBy ?? 'sermon_date');
    const orderBy: Prisma.SermonOrderByWithRelationInput =
      normalizedSortBy === 'title'
        ? { title: dto.sortOrder ?? 'asc' }
        : normalizedSortBy === 'created_at'
          ? { created_at: dto.sortOrder ?? 'desc' }
          : { sermon_date: dto.sortOrder ?? 'desc' };

    const [sermons, total] = await Promise.all([
      this.prisma.sermon.findMany({
        include: { branch: { select: { name: true } } },
        where,
        orderBy,
        skip,
        take: limit,
      }),
      this.prisma.sermon.count({ where }),
    ]);

    return {
      data: sermons.map((s) => this.mapSermonToDto(s)),
      total,
    };
  }

  /**
   * Gets a single sermon by ID.
   */
  async getSermon(
    sermonId: string,
    churchId: string,
    viewer?: ViewerScope | null,
  ): Promise<SermonResponseDto> {
    const sermon = await this.prisma.sermon.findFirst({
      include: { branch: { select: { name: true } } },
      where: { id: sermonId, church_id: churchId },
    });

    if (!sermon || (sermon.branch_id && !this.branchScope.isVisible(viewer, sermon.branch_id))) {
      throw new NotFoundException(`Sermon not found`);
    }

    return this.mapSermonToDto(sermon);
  }

  /**
   * Updates a sermon.
   */
  async updateSermon(
    sermonId: string,
    dto: UpdateSermonDto,
    churchId: string,
    userId: string,
    viewer?: ViewerScope | null,
  ): Promise<SermonResponseDto> {
    const existing = await this.prisma.sermon.findFirst({
      include: { branch: { select: { name: true } } },
      where: { id: sermonId, church_id: churchId },
    });

    if (
      !existing ||
      (existing.branch_id && !this.branchScope.isVisible(viewer, existing.branch_id))
    ) {
      throw new NotFoundException(`Sermon not found`);
    }

    if (existing.archived_at) {
      throw new NotFoundException('Sermon is archived');
    }

    const data: Prisma.SermonUpdateInput = {};
    if (dto.branchId !== undefined) {
      const branchId = await contentBranch(
        this.prisma,
        this.branchScope.resolve(viewer),
        churchId,
        dto.branchId,
      );
      data.branch = { connect: { id: branchId! } };
    }

    if (dto.title !== undefined) data.title = dto.title;
    if (dto.speaker !== undefined) data.speaker = dto.speaker;
    if (dto.sermonDate !== undefined) data.sermon_date = new Date(dto.sermonDate);
    if (dto.scriptureReference !== undefined) data.scripture_reference = dto.scriptureReference;
    if (dto.seriesName !== undefined) data.series_name = dto.seriesName;
    if (dto.tags !== undefined) data.tags = dto.tags;
    if (dto.audioUrl !== undefined) data.audio_url = dto.audioUrl;
    if (dto.videoUrl !== undefined) data.video_url = dto.videoUrl;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.durationSeconds !== undefined) data.duration_seconds = dto.durationSeconds;

    const updated = await this.prisma.sermon.update({
      include: { branch: { select: { name: true } } },
      where: { id: sermonId },
      data,
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'sermon',
      action: 'UPDATE',
      oldValues: { branchId: existing.branch_id },
      entityId: sermonId,
      newValues: dto as unknown as Record<string, unknown>,
    });

    this.logger.log(`Sermon updated: ${sermonId}`);
    return this.mapSermonToDto(updated);
  }

  /**
   * Deletes a sermon.
   */
  async deleteSermon(
    sermonId: string,
    churchId: string,
    userId: string,
    viewer?: ViewerScope | null,
  ): Promise<void> {
    const existing = await this.prisma.sermon.findFirst({
      include: { branch: { select: { name: true } } },
      where: { id: sermonId, church_id: churchId },
    });

    if (
      !existing ||
      (existing.branch_id && !this.branchScope.isVisible(viewer, existing.branch_id))
    ) {
      throw new NotFoundException(`Sermon not found`);
    }

    await this.prisma.sermon.delete({ where: { id: sermonId } });

    await this.audit.log({
      userId,
      churchId,
      entity: 'sermon',
      action: 'DELETE',
      entityId: sermonId,
      oldValues: { title: existing.title },
    });

    this.logger.log(`Sermon deleted: ${sermonId}`);
  }

  /**
   * Archives a sermon by setting archived_at. Archived sermons drop out of
   * active lists (listSermons filters archived_at: null) but their details stay
   * reachable by ID and they can be restored or permanently deleted.
   *
   * @param sermonId - Sermon UUID
   * @param churchId - Church UUID for tenant scoping
   * @param userId - Acting user ID for audit logging
   * @returns Updated SermonResponseDto
   * @throws NotFoundException if the sermon is missing or not in this church
   * @throws ConflictException if the sermon is already archived
   */
  async archiveSermon(
    sermonId: string,
    churchId: string,
    userId: string,
    viewer?: ViewerScope | null,
  ): Promise<SermonResponseDto> {
    const existing = await this.prisma.sermon.findFirst({
      include: { branch: { select: { name: true } } },
      where: { id: sermonId, church_id: churchId },
    });

    if (
      !existing ||
      (existing.branch_id && !this.branchScope.isVisible(viewer, existing.branch_id))
    ) {
      throw new NotFoundException('Sermon not found');
    }

    if (existing.archived_at) {
      throw new ConflictException('Sermon is already archived');
    }

    const updated = await this.prisma.sermon.update({
      include: { branch: { select: { name: true } } },
      where: { id: sermonId },
      data: { archived_at: new Date() },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'sermon',
      action: 'ARCHIVE',
      entityId: sermonId,
      oldValues: { archived_at: existing.archived_at },
      newValues: { archived_at: updated.archived_at },
    });

    this.logger.log(`Sermon archived: ${sermonId}`);
    return this.mapSermonToDto(updated);
  }

  /**
   * Restores an archived sermon by clearing archived_at.
   *
   * @param sermonId - Sermon UUID
   * @param churchId - Church UUID for tenant scoping
   * @param userId - Acting user ID for audit logging
   * @returns Updated SermonResponseDto
   * @throws NotFoundException if the sermon is missing or not in this church
   * @throws ConflictException if the sermon is not currently archived
   */
  async restoreSermon(
    sermonId: string,
    churchId: string,
    userId: string,
    viewer?: ViewerScope | null,
  ): Promise<SermonResponseDto> {
    const existing = await this.prisma.sermon.findFirst({
      include: { branch: { select: { name: true } } },
      where: { id: sermonId, church_id: churchId },
    });

    if (
      !existing ||
      (existing.branch_id && !this.branchScope.isVisible(viewer, existing.branch_id))
    ) {
      throw new NotFoundException('Sermon not found');
    }

    if (!existing.archived_at) {
      throw new ConflictException('Sermon is not archived');
    }

    const updated = await this.prisma.sermon.update({
      include: { branch: { select: { name: true } } },
      where: { id: sermonId },
      data: { archived_at: null },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'sermon',
      action: 'RESTORE',
      entityId: sermonId,
      oldValues: { archived_at: existing.archived_at },
      newValues: { archived_at: null },
    });

    this.logger.log(`Sermon restored: ${sermonId}`);
    return this.mapSermonToDto(updated);
  }

  // ─── BOOKMARKS ──────────────────────────────────────────────────

  /**
   * Resolves a member ID from a user's Supabase Auth ID.
   *
   * Looks up the user's profile to find the linked member record.
   *
   * @param userId - Supabase Auth user ID (from JWT sub claim)
   * @returns The member ID linked to the user's profile, or null if none
   */
  private async resolveMemberId(userId: string): Promise<string | null> {
    const profile = await this.prisma.profile.findUnique({
      where: { user_id: userId },
      select: {
        id: true,
        member_id: true,
        first_name: true,
        last_name: true,
        church_id: true,
        branch_id: true,
      },
    });

    if (!profile) {
      return null;
    }

    return profile.member_id;
  }

  /**
   * Returns the member ID linked to a user's profile, creating a Member
   * record on the fly for write operations that require one.
   *
   * @param userId - Supabase Auth user ID (from JWT sub claim)
   * @returns The member ID linked to the user's profile
   */
  private async ensureMemberId(userId: string): Promise<string> {
    const profile = await this.prisma.profile.findUnique({
      where: { user_id: userId },
      select: {
        id: true,
        member_id: true,
        first_name: true,
        last_name: true,
        church_id: true,
        branch_id: true,
      },
    });

    if (!profile) {
      throw new NotFoundException('User does not have a profile');
    }

    if (profile.member_id) {
      return profile.member_id;
    }

    // Create a Member record and link it to the profile
    const member = await this.prisma.member.create({
      data: {
        church_id: profile.church_id,
        branch_id: profile.branch_id,
        first_name: profile.first_name,
        last_name: profile.last_name,
        status: 'active',
      },
    });

    await this.prisma.profile.update({
      where: { id: profile.id },
      data: { member_id: member.id },
    });

    return member.id;
  }

  /**
   * Adds a sermon bookmark for the current user.
   *
   * @param sermonId - Sermon ID to bookmark
   * @param userId - Current user's Supabase Auth ID
   * @param churchId - Church ID for tenant scoping
   * @throws NotFoundException if sermon not found or user has no member link
   */
  async addBookmark(
    sermonId: string,
    userId: string,
    churchId: string,
  ): Promise<{ bookmarked: boolean }> {
    const sermon = await this.prisma.sermon.findFirst({
      include: { branch: { select: { name: true } } },
      where: { id: sermonId, church_id: churchId },
    });

    if (!sermon) {
      throw new NotFoundException('Sermon not found');
    }

    const memberId = await this.ensureMemberId(userId);

    // Check if already bookmarked
    const existing = await this.prisma.sermonBookmark.findUnique({
      where: { member_id_sermon_id: { member_id: memberId, sermon_id: sermonId } },
    });

    if (existing) {
      return { bookmarked: true };
    }

    await this.prisma.sermonBookmark.create({
      data: {
        church_id: churchId,
        member_id: memberId,
        sermon_id: sermonId,
      },
    });

    this.logger.log(`Sermon ${sermonId} bookmarked by member ${memberId}`);
    return { bookmarked: true };
  }

  /**
   * Removes a sermon bookmark for the current user.
   *
   * @param sermonId - Sermon ID to unbookmark
   * @param userId - Current user's Supabase Auth ID
   */
  async removeBookmark(sermonId: string, userId: string): Promise<{ bookmarked: boolean }> {
    const memberId = await this.resolveMemberId(userId);

    if (!memberId) {
      return { bookmarked: false };
    }

    const existing = await this.prisma.sermonBookmark.findUnique({
      where: { member_id_sermon_id: { member_id: memberId, sermon_id: sermonId } },
    });

    if (!existing) {
      return { bookmarked: false };
    }

    await this.prisma.sermonBookmark.delete({
      where: { member_id_sermon_id: { member_id: memberId, sermon_id: sermonId } },
    });

    this.logger.log(`Sermon ${sermonId} unbookmarked by member ${memberId}`);
    return { bookmarked: false };
  }

  /**
   * Lists bookmarked sermons for the current user.
   *
   * @param userId - Current user's Supabase Auth ID
   * @param churchId - Church ID for tenant scoping
   * @returns List of bookmarked sermons
   */
  async listBookmarks(userId: string, churchId: string): Promise<SermonResponseDto[]> {
    const memberId = await this.resolveMemberId(userId);

    if (!memberId) {
      return [];
    }

    const bookmarks = await this.prisma.sermonBookmark.findMany({
      where: {
        member_id: memberId,
        sermon: { church_id: churchId },
      },
      include: {
        sermon: true,
      },
      orderBy: { created_at: 'desc' },
    });

    return bookmarks.map((b) => {
      return this.mapSermonToDto(b.sermon);
    });
  }

  /**
   * Checks if a sermon is bookmarked by the current user.
   *
   * @param sermonId - Sermon ID
   * @param userId - Current user's Supabase Auth ID
   * @returns Whether the sermon is bookmarked
   */
  async isBookmarked(sermonId: string, userId: string): Promise<{ bookmarked: boolean }> {
    const memberId = await this.resolveMemberId(userId);

    if (!memberId) {
      return { bookmarked: false };
    }

    const bookmark = await this.prisma.sermonBookmark.findUnique({
      where: { member_id_sermon_id: { member_id: memberId, sermon_id: sermonId } },
    });

    return { bookmarked: !!bookmark };
  }

  /**
   * Sets the audio URL for a sermon (called after Supabase Storage upload).
   */
  async setAudioUrl(
    sermonId: string,
    audioUrl: string,
    churchId: string,
    _userId: string,
  ): Promise<SermonResponseDto> {
    const existing = await this.prisma.sermon.findFirst({
      include: { branch: { select: { name: true } } },
      where: { id: sermonId, church_id: churchId },
    });

    if (!existing) {
      throw new NotFoundException(`Sermon not found`);
    }

    if (existing.archived_at) {
      throw new NotFoundException('Sermon is archived');
    }

    const updated = await this.prisma.sermon.update({
      include: { branch: { select: { name: true } } },
      where: { id: sermonId },
      data: { audio_url: audioUrl },
    });

    this.logger.log(`Sermon audio URL set: ${sermonId}`);
    return this.mapSermonToDto(updated);
  }

  // ─── AGGREGATIONS ──────────────────────────────────────────────

  /**
   * Returns distinct series names with sermon counts for the church.
   */
  async listSeries(
    churchId: string,
    viewer?: ViewerScope | null,
  ): Promise<{ name: string; count: number; lastDate: string }[]> {
    const scope = this.branchScope.resolve(viewer);
    const rows = await this.prisma.sermon.groupBy({
      by: ['series_name'],
      where: {
        church_id: churchId,
        series_name: { not: null },
        archived_at: null,
        ...(!scope.churchOnly
          ? { OR: [{ branch_id: scope.branchId ?? null }, { branch_id: null }] }
          : {}),
      },
      _count: { id: true },
      _max: { sermon_date: true },
      orderBy: { _count: { id: 'desc' } },
    });

    return rows
      .filter((r) => r.series_name)
      .map((r) => ({
        name: r.series_name!,
        count: r._count.id,
        lastDate: r._max.sermon_date?.toISOString() ?? '',
      }));
  }

  /**
   * Returns distinct speakers with sermon counts for the church.
   */
  async listSpeakers(
    churchId: string,
    viewer?: ViewerScope | null,
  ): Promise<{ name: string; count: number; lastDate: string }[]> {
    const scope = this.branchScope.resolve(viewer);
    const rows = await this.prisma.sermon.groupBy({
      by: ['speaker'],
      where: {
        church_id: churchId,
        speaker: { not: null },
        archived_at: null,
        ...(!scope.churchOnly
          ? { OR: [{ branch_id: scope.branchId ?? null }, { branch_id: null }] }
          : {}),
      },
      _count: { id: true },
      _max: { sermon_date: true },
      orderBy: { _count: { id: 'desc' } },
    });

    return rows
      .filter((r) => r.speaker)
      .map((r) => ({
        name: r.speaker!,
        count: r._count.id,
        lastDate: r._max.sermon_date?.toISOString() ?? '',
      }));
  }

  /** Reuse the tenant/branch-scoped active archive; expose only reusable names. */
  async formOptions(churchId: string, viewer?: ViewerScope | null) {
    const [speakers, series] = await Promise.all([
      this.listSpeakers(churchId, viewer),
      this.listSeries(churchId, viewer),
    ]);
    const names = (items: { name: string }[]) =>
      [...new Set(items.map((item) => item.name.trim()).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b),
      );
    return { speakers: names(speakers), series: names(series) };
  }

  // ─── MAPPERS ───────────────────────────────────────────────────

  /**
   * Maps a Prisma Sermon to SermonResponseDto.
   */
  private mapSermonToDto(
    sermon: Record<string, unknown> & {
      id: string;
      sermon_date: Date;
      created_at: Date;
      updated_at: Date;
      archived_at: Date | null;
    },
  ): SermonResponseDto {
    return {
      sermonId: sermon.id,
      branchId: (sermon.branch_id as string) || undefined,
      branchName: (sermon.branch as { name: string } | null)?.name,
      churchId: sermon.church_id as string,
      title: sermon.title as string,
      speaker: (sermon.speaker as string) || undefined,
      sermonDate: sermon.sermon_date.toISOString(),
      scriptureReference: (sermon.scripture_reference as string) || undefined,
      seriesName: (sermon.series_name as string) || undefined,
      tags: (sermon.tags as string[]) || [],
      audioUrl: (sermon.audio_url as string) || undefined,
      videoUrl: (sermon.video_url as string) || undefined,
      durationSeconds: (sermon.duration_seconds as number) || undefined,
      description: (sermon.description as string) || undefined,
      archivedAt: sermon.archived_at?.toISOString(),
      createdAt: sermon.created_at.toISOString(),
      updatedAt: sermon.updated_at.toISOString(),
    };
  }
}
