import { errorDiagnostic } from '../common/privacy';
import { assertAssignableRoles } from '../billing/role-policy';
import { StaffInvitationService } from '../company-email/staff-invitation.service';
import { reserveStaffSeat, releaseStaffSeat } from '../billing/entitlements';
import { RequestContextService } from '../common/services/request-context.service';
import { isRetiredRole } from '../auth/role-policy';
/**
 * @file Church management service with CRUD operations.
 * @module ChurchService
 * @description Handles church details, configuration, and staff management.
 * Provides multi-tenant isolation via church_id and audit logging for all mutations.
 * @since 1.0.0
 */

import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  InternalServerErrorException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseService } from '../supabase/supabase.service';
import { AuditLoggingService } from '../common/services/audit-logging.service';
import { MediaService } from '../media/media.service';
import { UpdateChurchDto } from './dto/update-church.dto';
import { UpdateChurchEmailDto } from './dto/update-church-email.dto';
import { ChurchResponseDto } from './dto/church-response.dto';
import { ChurchConfigResponseDto } from './dto/church-config-response.dto';
import { UpdateChurchConfigDto } from './dto/update-church-config.dto';
import { InviteStaffDto } from './dto/invite-staff.dto';
import { StaffResponseDto } from './dto/staff-response.dto';
import { UpdateStaffRoleDto } from './dto/update-staff-role.dto';
import { Prisma } from '@prisma/client';

/**
 * Service for managing church details, configuration, and staff.
 * Provides CRUD operations with multi-tenant isolation and audit logging.
 */
@Injectable()
export class ChurchService {
  private readonly logger = new Logger(ChurchService.name);

  /**
   * Creates an instance of ChurchService.
   * @param prisma - Prisma database service
   * @param supabase - Supabase client for auth operations
   * @param audit - Audit logging service for tracking mutations
   * @param media - Media service for file operations
   */
  constructor(
    private readonly prisma: PrismaService,
    private readonly requestContext: RequestContextService,
    private readonly supabase: SupabaseService,
    private readonly audit: AuditLoggingService,
    private readonly media: MediaService,
    private readonly staffInvitations: StaffInvitationService,
  ) {}

  /**
   * Retrieves a church by ID with branch and member counts.
   * @param churchId - The church UUID
   * @returns ChurchResponseDto with church details
   * @throws NotFoundException if church not found
   */
  async getChurch(churchId: string): Promise<ChurchResponseDto> {
    const branchId = this.requestContext.branchWhere(churchId).branch_id;
    const church = await this.prisma.church.findUnique({
      where: { id: churchId },
      include: {
        _count: {
          select: {
            branches: branchId ? { where: { id: branchId } } : true,
            members: branchId ? { where: { branch_id: branchId } } : true,
          },
        },
      },
    });

    if (!church) {
      throw new NotFoundException('Church not found');
    }

    return this.mapToResponseDto(church);
  }

  /**
   * Updates church details with partial updates.
   * Deletes old logo from Supabase Storage when replaced.
   * @param churchId - The church UUID
   * @param dto - Update data (all fields optional)
   * @param userId - User performing the update (for audit log)
   * @returns Updated ChurchResponseDto
   * @throws NotFoundException if church not found
   */
  async updateChurch(
    churchId: string,
    dto: UpdateChurchDto,
    userId: string,
  ): Promise<ChurchResponseDto> {
    const existing = await this.prisma.church.findUnique({ where: { id: churchId } });

    if (!existing) {
      throw new NotFoundException('Church not found');
    }

    if (existing.logo_url && dto.logoUrl && existing.logo_url !== dto.logoUrl) {
      await this.media.deleteByUrl(existing.logo_url);
    }

    const updateData: Prisma.ChurchUpdateInput = {};
    if (dto.name !== undefined) updateData.name = dto.name?.trim() || '';
    if (dto.denomination !== undefined) updateData.denomination = dto.denomination?.trim() || '';
    if (dto.address !== undefined) updateData.address = dto.address?.trim() || '';
    if (dto.city !== undefined) updateData.city = dto.city?.trim() || '';
    if (dto.state !== undefined) updateData.state = dto.state?.trim() || '';
    if (dto.country !== undefined) updateData.country = dto.country?.trim() || '';
    if (dto.phone !== undefined) updateData.phone = dto.phone?.trim() || '';
    if (dto.email !== undefined) updateData.email = dto.email?.trim() || '';
    if (dto.website !== undefined) updateData.website = dto.website?.trim() || '';
    if (dto.logoUrl !== undefined) updateData.logo_url = dto.logoUrl || '';

    if (Object.keys(updateData).length === 0) {
      return this.getChurch(churchId);
    }

    const church = await this.prisma.church.update({
      where: { id: churchId },
      data: updateData,
      include: {
        _count: {
          select: { branches: true, members: true },
        },
      },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'church',
      action: 'UPDATE',
      entityId: churchId,
      oldValues: {
        name: existing.name,
        denomination: existing.denomination,
        logo_url: existing.logo_url,
      },
      newValues: updateData as Record<string, unknown>,
    });

    this.logger.log(`Church updated: ${churchId}`);

    return this.mapToResponseDto(church);
  }

  /**
   * Updates the unified church email — the acting admin's sign-in email
   * (Supabase Auth), their profile contact record, and the church's public
   * contact email are all kept aligned in one operation.
   *
   * The Supabase sync happens first so a rejected email never touches the
   * database. A no-op returns early when everything already matches.
   *
   * @param churchId - The church UUID
   * @param userId - The acting admin's Supabase Auth user ID
   * @param dto - The new email address
   * @returns Updated ChurchResponseDto
   * @throws NotFoundException if the church or the acting admin's profile is missing
   * @throws BadRequestException if Supabase rejects the new email
   */
  async updateChurchEmail(
    churchId: string,
    userId: string,
    dto: UpdateChurchEmailDto,
  ): Promise<ChurchResponseDto> {
    const newEmail = dto.email.trim().toLowerCase();

    const church = await this.prisma.church.findUnique({ where: { id: churchId } });
    if (!church) {
      throw new NotFoundException('Church not found');
    }

    const profile = await this.prisma.profile.findFirst({
      where: { user_id: userId, church_id: churchId },
    });
    if (!profile) {
      throw new NotFoundException('User profile not found');
    }

    // No-op when the email is already aligned everywhere
    if (newEmail === (church.email ?? '') && newEmail === (profile.email ?? '')) {
      return this.getChurch(churchId);
    }

    // Sync the sign-in credential first — fail fast before any DB write
    const { error } = await this.supabase.client.auth.admin.updateUserById(userId, {
      email: newEmail,
    });
    if (error) {
      throw new BadRequestException(`Failed to update auth email: ${error.message}`);
    }

    await this.prisma.$transaction([
      this.prisma.church.update({
        where: { id: churchId },
        data: { email: newEmail },
      }),
      this.prisma.profile.update({
        where: { id: profile.id },
        data: { email: newEmail },
      }),
    ]);

    await this.audit.log({
      userId,
      churchId,
      entity: 'church',
      action: 'UPDATE',
      entityId: churchId,
      oldValues: { email: church.email },
      newValues: { email: newEmail },
    });

    this.logger.log(`Unified church email updated for ${churchId} by user ${userId}`);

    return this.getChurch(churchId);
  }

  /**
   * Archives a church by setting its archived_at timestamp. Once archived, the
   * request-context middleware rejects every request from the church's profiles
   * except the restore route, so this effectively takes the church offline.
   * @param churchId - The church UUID
   * @param userId - User performing the archive (for audit log)
   * @returns Updated ChurchResponseDto
   * @throws NotFoundException if church not found
   * @throws ConflictException if the church is already archived
   */
  async archiveChurch(churchId: string, userId: string): Promise<ChurchResponseDto> {
    const existing = await this.prisma.church.findUnique({ where: { id: churchId } });

    if (!existing) {
      throw new NotFoundException('Church not found');
    }

    if (existing.archived_at) {
      throw new ConflictException('Church is already archived');
    }

    await this.audit.log({
      userId,
      churchId,
      entity: 'church',
      action: 'ARCHIVE',
      entityId: churchId,
      oldValues: { archived_at: existing.archived_at },
      newValues: { archived_at: new Date() },
    });

    this.logger.log(`Church archived: ${churchId} by user ${userId}`);

    return this.getChurch(churchId);
  }

  /**
   * Restores an archived church by clearing its archived_at timestamp. This is
   * the one request the request-context middleware allows through for profiles
   * whose church is archived, so an admin session can bring the church back.
   * @param churchId - The church UUID
   * @param userId - User performing the restore (for audit log)
   * @returns Updated ChurchResponseDto
   * @throws NotFoundException if church not found
   * @throws ConflictException if the church is not archived
   */
  async restoreChurch(churchId: string, userId: string): Promise<ChurchResponseDto> {
    const existing = await this.prisma.church.findUnique({ where: { id: churchId } });

    if (!existing) {
      throw new NotFoundException('Church not found');
    }

    if (!existing.archived_at) {
      throw new ConflictException('Church is not archived');
    }

    await this.audit.log({
      userId,
      churchId,
      entity: 'church',
      action: 'RESTORE',
      entityId: churchId,
      oldValues: { archived_at: existing.archived_at },
      newValues: { archived_at: null },
    });

    this.logger.log(`Church restored: ${churchId} by user ${userId}`);

    return this.getChurch(churchId);
  }

  /**
   * Retrieves all configuration key-value pairs for a church.
   * @param churchId - The church UUID
   * @returns ChurchConfigResponseDto with all config values
   */
  async getChurchConfig(churchId: string): Promise<ChurchConfigResponseDto> {
    const configs = await this.prisma.churchConfig.findMany({
      where: { church_id: churchId },
    });

    const config: Record<string, unknown> = {};
    for (const c of configs) {
      config[c.key] = c.value;
    }

    return { config };
  }

  /**
   * Upserts configuration key-value pairs for a church.
   * @param churchId - The church UUID
   * @param dto - Config key-value pairs to upsert
   * @param userId - User performing the update (for audit log)
   * @returns Updated ChurchConfigResponseDto
   */
  async updateChurchConfig(
    churchId: string,
    dto: UpdateChurchConfigDto,
    userId: string,
  ): Promise<ChurchConfigResponseDto> {
    const existing = await this.prisma.churchConfig.findMany({
      where: { church_id: churchId },
    });

    const oldConfig: Record<string, unknown> = {};
    for (const c of existing) {
      oldConfig[c.key] = c.value;
    }

    if (dto.config) {
      const entries = Object.entries(dto.config);
      for (const [key, value] of entries) {
        await this.prisma.churchConfig.upsert({
          where: {
            church_id_key: { church_id: churchId, key },
          },
          update: { value: value as Prisma.InputJsonValue },
          create: {
            church_id: churchId,
            key,
            value: value as Prisma.InputJsonValue,
          },
        });
      }
    }

    await this.audit.log({
      userId,
      churchId,
      entity: 'church_config',
      action: 'UPDATE',
      entityId: churchId,
      oldValues: oldConfig,
      newValues: dto.config as Record<string, unknown>,
    });

    this.logger.log(`Church config updated: ${churchId}`);

    return this.getChurchConfig(churchId);
  }

  /**
   * Invites a staff member via Supabase Auth invitation.
   * Creates a Profile record and sends invitation email.
   * @param churchId - The church UUID
   * @param dto - Staff invitation details (email, name, role, branch)
   * @param userId - User performing the invitation (for audit log)
   * @returns StaffResponseDto with created profile details
   * @throws ConflictException if staff with email already exists
   * @throws InternalServerErrorException if invitation fails
   */
  async inviteStaff(
    churchId: string,
    dto: InviteStaffDto,
    userId: string,
  ): Promise<StaffResponseDto> {
    if (isRetiredRole(dto.role?.trim()))
      throw new BadRequestException('This login role has been removed');
    if (dto.role?.trim() === 'super_admin')
      throw new BadRequestException('Super Admin cannot be assigned through church invitations');
    const inviteRole = await this.prisma.role.findFirst({
      where: { name: dto.role?.trim(), OR: [{ church_id: null }, { church_id: churchId }] },
      select: { name: true },
    });
    if (!inviteRole) throw new BadRequestException('Role not found in this church');
    const existingProfile = await this.prisma.profile.findFirst({
      where: { church_id: churchId },
    });

    if (existingProfile) {
      const { data: userData } = await this.supabase.client.auth.admin.getUserById(
        existingProfile.user_id,
      );
      if (userData?.user?.email === dto.email) {
        throw new ConflictException('A staff member with this email already exists in your church');
      }
    }

    const normalizedEmail = dto.email?.trim().toLowerCase();
    const normalizedFirstName = dto.firstName?.trim();
    const normalizedLastName = dto.lastName?.trim();
    const normalizedRole = dto.role?.trim();
    const normalizedPhone = dto.phone?.trim() || null;

    const branchId = this.requestContext.branchIdForWrite(churchId, dto.branchId);
    if (
      branchId &&
      !(await this.prisma.branch.findUnique({
        where: { id: branchId, church_id: churchId, archived_at: null },
        select: { id: true },
      }))
    )
      throw new BadRequestException('Branch not found in this church');

    if (!normalizedEmail) {
      throw new InternalServerErrorException('Email is required');
    }

    await assertAssignableRoles(this.prisma, churchId, [normalizedRole]);
    const reservation = await reserveStaffSeat(this.prisma, churchId, normalizedEmail);
    try {
      const profile = await this.staffInvitations.create({
        churchId,
        email: normalizedEmail,
        firstName: normalizedFirstName,
        lastName: normalizedLastName,
        role: normalizedRole,
        phone: normalizedPhone,
        branchId,
        inviterUserId: userId,
      });
      let branchName: string | undefined;
      if (branchId) {
        const branch = await this.prisma.branch.findUnique({
          where: { id: branchId, church_id: churchId, archived_at: null },
          select: { name: true },
        });
        branchName = branch?.name;
      }

      await this.audit.log({
        userId,
        churchId,
        entity: 'staff',
        action: 'CREATE',
        entityId: profile.id,
        newValues: {
          email: normalizedEmail,
          firstName: normalizedFirstName,
          lastName: normalizedLastName,
          role: normalizedRole,
          branchId,
        },
      });

      this.logger.log(`Staff invitation created for church ${churchId}`);

      return {
        profileId: profile.id,
        userId: profile.user_id,
        email: normalizedEmail,
        firstName: profile.first_name,
        lastName: profile.last_name,
        phone: profile.phone || undefined,
        role: profile.role,
        branchName,
        branchId: profile.branch_id || undefined,
        createdAt: profile.created_at.toISOString(),
      };
    } finally {
      await releaseStaffSeat(this.prisma, reservation.id);
    }
  }

  /**
   * Lists staff members with pagination and filtering.
   * Fetches emails from Supabase Auth for each staff member.
   * @param churchId - The church UUID
   * @param query - Pagination and filter parameters
   * @returns Array of StaffResponseDto and total count
   */
  async listStaff(
    churchId: string,
    query: { page?: number; limit?: number; search?: string; role?: string },
  ): Promise<{ data: StaffResponseDto[]; total: number }> {
    const page = query.page || 1;
    const limit = Math.min(query.limit || 20, 100);
    const skip = (page - 1) * limit;

    const where: Prisma.ProfileWhereInput = {
      church_id: churchId,
      ...this.requestContext.branchWhere(churchId),
    };

    if (query.role) {
      where.role = { has: query.role };
    }

    const [profiles, total] = await Promise.all([
      this.prisma.profile.findMany({
        where,
        include: {
          branch: { select: { id: true, name: true } },
        },
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.profile.count({ where }),
    ]);

    const userIds = profiles.map((p) => p.user_id);
    const emailMap = await this.getEmailsByUserIds(userIds);

    const data = profiles.map((p) => ({
      profileId: p.id,
      userId: p.user_id,
      email: emailMap.get(p.user_id) || '',
      firstName: p.first_name,
      lastName: p.last_name,
      phone: p.phone || undefined,
      role: p.role,
      branchName: p.branch?.name,
      branchId: p.branch_id || undefined,
      createdAt: p.created_at.toISOString(),
    }));

    return { data, total };
  }

  /**
   * Updates a staff member's role.
   * @param churchId - The church UUID
   * @param profileId - The profile UUID to update
   * @param dto - New role data
   * @param userId - User performing the update (for audit log)
   * @returns Updated StaffResponseDto
   * @throws NotFoundException if staff member not found or doesn't belong to church
   */
  async updateStaffRole(
    churchId: string,
    profileId: string,
    dto: UpdateStaffRoleDto,
    userId: string,
  ): Promise<StaffResponseDto> {
    if (isRetiredRole(dto.role)) throw new BadRequestException('This login role has been removed');
    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      include: {
        branch: { select: { name: true } },
      },
    });

    if (
      !profile ||
      profile.church_id !== churchId ||
      (this.requestContext.branchWhere(churchId).branch_id &&
        profile.branch_id !== this.requestContext.branchWhere(churchId).branch_id)
    ) {
      throw new NotFoundException('Staff member not found');
    }

    if (profile.role.includes('super_admin'))
      throw new ForbiddenException('Super administrator accounts must use the profile roles API');
    if (profile.user_id === userId) throw new ForbiddenException('Cannot change your own roles');

    const role = await this.prisma.role.findFirst({
      where: { name: dto.role, OR: [{ church_id: null }, { church_id: churchId }] },
      select: { name: true },
    });
    if (!role || dto.role === 'super_admin')
      throw new BadRequestException('Invalid church staff role');
    await assertAssignableRoles(this.prisma, churchId, [dto.role], profile.role);
    const oldRole = profile.role;

    // Replace the full role set with the single requested role. is_admin_hq is
    // left manual (never cleared); default it on only when promoting to
    // church_admin.
    const updated = await this.prisma.profile.update({
      where: { id: profileId },
      data: {
        role: [dto.role],
        ...(dto.role === 'church_admin' && !oldRole.includes('church_admin')
          ? { is_admin_hq: true }
          : {}),
      },
      include: {
        branch: { select: { name: true } },
      },
    });

    let email = '';
    try {
      const { data: userData } = await this.supabase.client.auth.admin.getUserById(profile.user_id);
      email = userData?.user?.email || '';
    } catch {
      this.logger.warn(`Could not fetch email for user ${profile.user_id}`);
    }

    await this.audit.log({
      userId,
      churchId,
      entity: 'staff',
      action: 'UPDATE',
      entityId: profileId,
      oldValues: { role: oldRole },
      newValues: { role: dto.role },
    });

    this.logger.log(`Staff role updated: ${profileId} → ${dto.role}`);

    return {
      profileId: updated.id,
      userId: updated.user_id,
      email,
      firstName: updated.first_name,
      lastName: updated.last_name,
      phone: updated.phone || undefined,
      role: updated.role,
      branchName: updated.branch?.name,
      branchId: updated.branch_id || undefined,
      createdAt: updated.created_at.toISOString(),
    };
  }

  /**
   * Soft-deletes a staff member by setting role to "removed".
   * @param churchId - The church UUID
   * @param profileId - The profile UUID to remove
   * @param userId - User performing the removal (for audit log)
   * @returns Object with success status
   * @throws NotFoundException if staff member not found or doesn't belong to church
   */
  async removeStaff(
    churchId: string,
    profileId: string,
    userId: string,
  ): Promise<{ success: boolean }> {
    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
    });

    if (
      !profile ||
      profile.church_id !== churchId ||
      (this.requestContext.branchWhere(churchId).branch_id &&
        profile.branch_id !== this.requestContext.branchWhere(churchId).branch_id)
    ) {
      throw new NotFoundException('Staff member not found');
    }

    await this.prisma.profile.update({
      where: { id: profileId },
      data: { role: ['removed'], status: 'inactive', is_admin_hq: false },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'staff',
      action: 'DELETE',
      entityId: profileId,
      oldValues: { role: profile.role },
      newValues: { role: 'removed' },
    });

    this.logger.log(`Staff removed: ${profileId}`);

    return { success: true };
  }

  /**
   * Fetches emails from Supabase Auth for a batch of user IDs.
   * Processes in batches of 50 users.
   * @param userIds - Array of Supabase user IDs
   * @returns Map of user ID to email address
   */
  private async getEmailsByUserIds(userIds: string[]): Promise<Map<string, string>> {
    const emailMap = new Map<string, string>();
    if (userIds.length === 0) return emailMap;

    try {
      const pageSize = 50;
      for (let page = 0; page * pageSize < userIds.length; page++) {
        const batch = userIds.slice(page * pageSize, (page + 1) * pageSize);
        const { data } = await this.supabase.client.auth.admin.listUsers({
          page: page + 1,
          perPage: pageSize,
        });

        if (data?.users) {
          for (const user of data.users) {
            if (batch.includes(user.id) && user.email) {
              emailMap.set(user.id, user.email);
            }
          }
        }
      }
    } catch (error) {
      this.logger.warn(`Failed to fetch emails from Supabase: ${errorDiagnostic(error)}`);
    }

    return emailMap;
  }

  /**
   * Maps a Prisma Church object to a ChurchResponseDto.
   * @param church - Prisma Church object with optional counts
   * @returns ChurchResponseDto with camelCase properties
   */
  private mapToResponseDto(church: {
    id: string;
    name: string;
    denomination: string | null;
    address: string | null;
    city: string | null;
    state: string | null;
    country: string;
    phone: string | null;
    email: string | null;
    website: string | null;
    logo_url: string | null;
    created_at: Date;
    updated_at: Date;
    archived_at: Date | null;
    _count?: { branches: number; members: number };
  }): ChurchResponseDto {
    return {
      churchId: church.id,
      name: church.name,
      denomination: church.denomination || undefined,
      address: church.address || undefined,
      city: church.city || undefined,
      state: church.state || undefined,
      country: church.country,
      phone: church.phone || undefined,
      email: church.email || undefined,
      website: church.website || undefined,
      logoUrl: church.logo_url || undefined,
      branchCount: church._count?.branches ?? 0,
      memberCount: church._count?.members ?? 0,
      archivedAt: church.archived_at?.toISOString(),
      createdAt: church.created_at.toISOString(),
      updatedAt: church.updated_at.toISOString(),
    };
  }
}
