import { LEGACY_BRAND } from '../brand/brand';
import { RequestContextService } from '../common/services/request-context.service';
/**
 * @file pastoral.service.ts
 * @description Business logic for pastoral note management with AES-256-GCM encryption.
 *
 * Handles CRUD operations for pastoral notes. Content is encrypted at rest
 * using AES-256-GCM with a per-church encryption key derived from the
 * PASTORAL_ENCRYPTION_KEY environment variable.
 *
 * Confidentiality levels control access:
 * - standard: visible to all church staff
 * - confidential: visible to pastors and admin only
 * - restricted: visible to the author and senior pastors only
 *
 * All queries are scoped by church_id for multi-tenant data isolation.
 * All mutations are audit-logged.
 *
 * @module pastoral/pastoral.service
 * @since 1.0.0
 */

import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLoggingService } from '../common/services/audit-logging.service';
import { Prisma } from '@prisma/client';
import { CreatePastoralNoteDto } from './dto/create-pastoral-note.dto';
import { UpdatePastoralNoteDto } from './dto/update-pastoral-note.dto';
import { ListPastoralNotesDto } from './dto/list-pastoral-notes.dto';
import { PastoralNoteResponseDto } from './dto/pastoral-note-response.dto';
import { CreateLifeEventDto } from './dto/create-life-event.dto';
import { ListLifeEventsDto } from './dto/list-life-events.dto';
import { LifeEventResponseDto } from './dto/life-event-response.dto';
import * as crypto from 'crypto';

/**
 * Encryption algorithm used for pastoral note content.
 * AES-256-GCM provides both confidentiality and integrity.
 */
const ALGORITHM = 'aes-256-gcm';

/**
 * Length of the random IV (initialization vector) for each encryption operation.
 */
const IV_LENGTH = 16;

/**
 * Length of the authentication tag for GCM mode.
 */
const AUTH_TAG_LENGTH = 16;

@Injectable()
export class PastoralService {
  // Initialize the logger for this service
  private readonly logger = new Logger(PastoralService.name);

  /**
   * Encryption key derived from PASTORAL_ENCRYPTION_KEY env var.
   * Falls back to a dev-only key for local development.
   */
  private readonly encryptionKey: Buffer;

  constructor(
    // Inject PrismaService for database access
    private readonly prisma: PrismaService,
    private readonly requestContext: RequestContextService,
    // Inject AuditLoggingService for mutation audit trails
    private readonly audit: AuditLoggingService,
  ) {
    // Read the raw encryption key from environment or use a dev fallback
    const configuredKey = process.env.PASTORAL_ENCRYPTION_KEY;
    if (
      process.env.NODE_ENV === 'production' &&
      (!configuredKey || configuredKey === 'dev-only-change-in-production-32b')
    ) {
      throw new Error('PASTORAL_ENCRYPTION_KEY must be configured in production');
    }
    const rawKey = configuredKey || 'dev-only-change-in-production-32b';
    // Derive a 32-byte AES-256 key using scrypt with a fixed salt
    this.encryptionKey = crypto.scryptSync(rawKey, LEGACY_BRAND.pastoralSalt, 32);
  }

  /**
   * Creates a new pastoral note with encrypted content.
   *
   * @param dto - Note creation data (memberId, content, confidentiality, tags)
   * @param churchId - Church ID for tenant scoping
   * @param userId - Author's user ID
   * @returns Created pastoral note with decrypted content
   */
  async createNote(
    dto: CreatePastoralNoteDto,
    churchId: string,
    userId: string,
  ): Promise<PastoralNoteResponseDto> {
    // Resolve Supabase user ID to member ID for the author_id FK
    const memberId = await this.ensureMemberId(userId);

    // Verify the subject member belongs to this church
    const subjectMember = await this.prisma.member.findFirst({
      where: {
        id: dto.memberId,
        church_id: churchId,
        ...this.requestContext.branchWhere(churchId),
      },
      select: { id: true },
    });

    if (!subjectMember) {
      throw new NotFoundException('Member not found in this church');
    }

    // Encrypt the plaintext content using AES-256-GCM
    const encryptedContent = this.encrypt(dto.content);

    // Create the pastoral note record in the database with encrypted content
    const note = await this.prisma.pastoralNote.create({
      data: {
        church_id: churchId,
        member_id: dto.memberId,
        author_id: memberId,
        content: encryptedContent,
        confidentiality: dto.confidentiality || 'standard',
        tags: dto.tags || [],
      },
      include: {
        member: { select: { first_name: true, last_name: true } },
        author: { select: { first_name: true, last_name: true } },
      },
    });

    // Log the creation event for audit trail
    this.logger.log(`Pastoral note created: ${note.id} for member ${dto.memberId}`);

    // Record the mutation in the audit log table
    await this.audit.log({
      churchId,
      userId,
      action: 'CREATE',
      entity: 'pastoral_note',
      entityId: note.id,
      newValues: { memberId: dto.memberId, confidentiality: note.confidentiality },
    });

    // Map the Prisma record to a response DTO with decrypted content
    return this.mapToResponseDto(note, dto.content);
  }

  /**
   * Lists pastoral notes with pagination and filtering.
   *
   * Respects confidentiality permissions granted to the requesting user.
   * Returns decrypted content in the response.
   *
   * @param query - List/filter parameters
   * @param churchId - Church ID for tenant scoping
   * @param userPermissions - Effective permissions (for confidentiality filtering)
   * @param userId - Requesting user's ID (for restricted note access)
   * @returns Paginated list of pastoral notes
   */
  async listNotes(
    query: ListPastoralNotesDto,
    churchId: string,
    userPermissions: string[],
    userId: string,
  ): Promise<{
    data: PastoralNoteResponseDto[];
    meta: { total: number; page: number; limit: number; totalPages: number };
  }> {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    // Build the base where clause scoped to the church
    const where: Prisma.PastoralNoteWhereInput = {
      church_id: churchId,
      member: this.requestContext.branchWhere(churchId),
      archived_at: query.archived === true ? { not: null } : null,
    };

    // Apply optional member filter
    if (query.memberId) {
      where.member_id = query.memberId;
    }

    // Apply optional author filter
    if (query.authorId) {
      where.author_id = query.authorId;
    }

    // Apply optional confidentiality filter
    if (query.confidentiality) {
      where.confidentiality = query.confidentiality;
    }

    // Apply optional tag filter using Prisma's hasSome
    if (query.tags && query.tags.length > 0) {
      where.tags = { hasSome: query.tags };
    }

    // Apply confidentiality-based access control filter for the user's role
    const memberId = await this.resolveMemberId(userId);
    const confidentialityFilter = this.getConfidentialityFilter(userPermissions, memberId);
    if (confidentialityFilter) {
      where.AND = confidentialityFilter;
    }

    // Execute paginated query and count total in parallel
    const [notes, total] = await Promise.all([
      this.prisma.pastoralNote.findMany({
        where,
        include: {
          member: { select: { first_name: true, last_name: true } },
          author: { select: { first_name: true, last_name: true } },
        },
        orderBy: {
          [query.sortBy || 'created_at']: query.sortOrder || 'desc',
        },
        skip,
        take: limit,
      }),
      this.prisma.pastoralNote.count({ where }),
    ]);

    // Decrypt content and map each note to a response DTO
    const data = notes.map((note) => {
      const decryptedContent = this.decrypt(note.content);
      return this.mapToResponseDto(note, decryptedContent);
    });

    // Return the paginated result with metadata
    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Gets a single pastoral note by ID with decrypted content.
   *
   * @param noteId - Pastoral note ID
   * @param churchId - Church ID for tenant scoping
   * @param userPermissions - Effective permissions
   * @param userId - Requesting user's ID
   * @returns Pastoral note with decrypted content
   * @throws NotFoundException if note not found
   * @throws ForbiddenException if user lacks access due to confidentiality
   */
  async getNoteById(
    noteId: string,
    churchId: string,
    userPermissions: string[],
    userId: string,
  ): Promise<PastoralNoteResponseDto> {
    // Fetch the note by ID scoped to the church
    const note = await this.prisma.pastoralNote.findFirst({
      where: { id: noteId, church_id: churchId, member: this.requestContext.branchWhere(churchId) },
      include: {
        member: { select: { first_name: true, last_name: true } },
        author: { select: { first_name: true, last_name: true } },
      },
    });

    // Throw NotFoundException if the note does not exist
    if (!note) {
      throw new NotFoundException(`Pastoral note ${noteId} not found`);
    }

    // Verify the user has access based on the note's confidentiality level
    const memberId = await this.resolveMemberId(userId);
    this.checkConfidentialityAccess(note, userPermissions, memberId);

    // Decrypt the content and map to response DTO
    const decryptedContent = this.decrypt(note.content);
    return this.mapToResponseDto(note, decryptedContent);
  }

  /**
   * Updates a pastoral note. Only the author or admin can update.
   *
   * @param noteId - Pastoral note ID
   * @param dto - Update data
   * @param churchId - Church ID for tenant scoping
   * @param userId - User performing the update
   * @param userPermissions - Effective user permissions
   * @returns Updated pastoral note
   * @throws NotFoundException if note not found
   * @throws ForbiddenException if user is not the author or admin
   */
  async updateNote(
    noteId: string,
    dto: UpdatePastoralNoteDto,
    churchId: string,
    userId: string,
    userPermissions: string[],
  ): Promise<PastoralNoteResponseDto> {
    // Resolve Supabase user ID to member ID for ownership check
    const memberId = await this.resolveMemberId(userId);

    // Fetch the existing note to verify it exists and check ownership
    const existing = await this.prisma.pastoralNote.findFirst({
      where: { id: noteId, church_id: churchId, member: this.requestContext.branchWhere(churchId) },
    });

    // Throw NotFoundException if the note does not exist
    if (!existing) {
      throw new NotFoundException(`Pastoral note ${noteId} not found`);
    }

    // Archived notes are hidden from update-style mutations (purge via delete only)
    if (existing.archived_at) {
      throw new NotFoundException(`Pastoral note ${noteId} not found`);
    }

    // Enforce that only the author or admin/pastor can update
    if (
      existing.author_id !== memberId &&
      !userPermissions.includes('pastoral_moderation:update')
    ) {
      throw new ForbiddenException('Only the author or admin can update this note');
    }

    // Build the update payload with only provided fields
    const updateData: Prisma.PastoralNoteUpdateInput = {};

    // Encrypt new content if provided
    if (dto.content !== undefined) {
      updateData.content = this.encrypt(dto.content);
    }

    // Update confidentiality level if provided
    if (dto.confidentiality !== undefined) {
      updateData.confidentiality = dto.confidentiality;
    }

    // Update tags if provided
    if (dto.tags !== undefined) {
      updateData.tags = dto.tags;
    }

    // Apply the update to the database
    const updated = await this.prisma.pastoralNote.update({
      where: { id: noteId },
      data: updateData,
      include: {
        member: { select: { first_name: true, last_name: true } },
        author: { select: { first_name: true, last_name: true } },
      },
    });

    // Log the update event
    this.logger.log(`Pastoral note updated: ${noteId}`);

    // Record the mutation in the audit log
    await this.audit.log({
      churchId,
      userId,
      action: 'UPDATE',
      entity: 'pastoral_note',
      entityId: noteId,
      newValues: { updatedFields: Object.keys(updateData) },
    });

    // Decrypt content (use original plaintext if content was updated)
    const decryptedContent = dto.content || this.decrypt(updated.content);
    return this.mapToResponseDto(updated, decryptedContent);
  }

  /**
   * Deletes a pastoral note. Requires dual authorization for restricted notes.
   *
   * @param noteId - Pastoral note ID
   * @param churchId - Church ID for tenant scoping
   * @param userId - User performing the delete
   * @param userPermissions - Effective user permissions
   */
  async deleteNote(
    noteId: string,
    churchId: string,
    userId: string,
    userPermissions: string[],
  ): Promise<void> {
    // Resolve Supabase user ID to member ID for ownership check
    const memberId = await this.resolveMemberId(userId);

    // Fetch the existing note to verify it exists and check confidentiality
    const existing = await this.prisma.pastoralNote.findFirst({
      where: { id: noteId, church_id: churchId, member: this.requestContext.branchWhere(churchId) },
    });

    // Throw NotFoundException if the note does not exist
    if (!existing) {
      throw new NotFoundException(`Pastoral note ${noteId} not found`);
    }

    // Enforce dual authorization for restricted notes (admin or senior pastor only)
    if (
      existing.confidentiality === 'restricted' &&
      !userPermissions.includes('pastoral_moderation:delete')
    ) {
      throw new ForbiddenException(
        'Restricted pastoral notes require admin or senior pastor to delete',
      );
    }

    // For non-restricted notes, only the author or admin can delete
    if (
      existing.confidentiality !== 'restricted' &&
      existing.author_id !== memberId &&
      !userPermissions.includes('pastoral_moderation:delete')
    ) {
      throw new ForbiddenException('Only the author or admin can delete this note');
    }

    // Delete the note from the database
    await this.prisma.pastoralNote.delete({ where: { id: noteId } });

    // Log the deletion event
    this.logger.log(`Pastoral note deleted: ${noteId}`);

    // Record the deletion in the audit log
    await this.audit.log({
      churchId,
      userId,
      action: 'DELETE',
      entity: 'pastoral_note',
      entityId: noteId,
      newValues: { memberId: existing.member_id },
    });
  }

  /**
   * Archives a pastoral note by setting archived_at. Archived notes drop out
   * of active note lists (they stay reachable by ID and can be restored).
   *
   * @param noteId - Pastoral note ID
   * @param churchId - Church ID for tenant scoping
   * @param userId - User performing the archive
   * @returns Archived note with decrypted content
   * @throws NotFoundException if the note is missing or not in this church
   * @throws ConflictException if the note is already archived
   */
  async archiveNote(
    noteId: string,
    churchId: string,
    userId: string,
  ): Promise<PastoralNoteResponseDto> {
    const existing = await this.prisma.pastoralNote.findFirst({
      where: { id: noteId, church_id: churchId, member: this.requestContext.branchWhere(churchId) },
    });

    if (!existing) {
      throw new NotFoundException(`Pastoral note ${noteId} not found`);
    }

    if (existing.archived_at) {
      throw new ConflictException('Pastoral note is already archived');
    }

    const updated = await this.prisma.pastoralNote.update({
      where: { id: noteId },
      data: { archived_at: new Date() },
      include: {
        member: { select: { first_name: true, last_name: true } },
        author: { select: { first_name: true, last_name: true } },
      },
    });

    await this.audit.log({
      churchId,
      userId,
      action: 'ARCHIVE',
      entity: 'pastoral_note',
      entityId: noteId,
      oldValues: { archived_at: existing.archived_at },
      newValues: { archived_at: updated.archived_at },
    });

    this.logger.log(`Pastoral note archived: ${noteId}`);
    return this.mapToResponseDto(updated, this.decrypt(updated.content));
  }

  /**
   * Restores an archived pastoral note by clearing archived_at.
   *
   * @param noteId - Pastoral note ID
   * @param churchId - Church ID for tenant scoping
   * @param userId - User performing the restore
   * @returns Restored note with decrypted content
   * @throws NotFoundException if the note is missing or not in this church
   * @throws ConflictException if the note is not currently archived
   */
  async restoreNote(
    noteId: string,
    churchId: string,
    userId: string,
  ): Promise<PastoralNoteResponseDto> {
    const existing = await this.prisma.pastoralNote.findFirst({
      where: { id: noteId, church_id: churchId, member: this.requestContext.branchWhere(churchId) },
    });

    if (!existing) {
      throw new NotFoundException(`Pastoral note ${noteId} not found`);
    }

    if (!existing.archived_at) {
      throw new ConflictException('Pastoral note is not archived');
    }

    const updated = await this.prisma.pastoralNote.update({
      where: { id: noteId },
      data: { archived_at: null },
      include: {
        member: { select: { first_name: true, last_name: true } },
        author: { select: { first_name: true, last_name: true } },
      },
    });

    await this.audit.log({
      churchId,
      userId,
      action: 'RESTORE',
      entity: 'pastoral_note',
      entityId: noteId,
      oldValues: { archived_at: existing.archived_at },
      newValues: { archived_at: null },
    });

    this.logger.log(`Pastoral note restored: ${noteId}`);
    return this.mapToResponseDto(updated, this.decrypt(updated.content));
  }

  // ─── Member ID Resolution ────────────────────────────────

  /**
   * Resolves a Supabase Auth user ID to a Member ID via the Profile table.
   *
   * @param userId - Supabase Auth user ID (user.sub)
   * @returns The member_id from the user's Profile, or null if none
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
   * record on the fly for write operations that require an author.
   *
   * @param userId - Supabase Auth user ID (user.sub)
   * @returns The member_id from the user's Profile
   * @throws BadRequestException if user has no member profile
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
      throw new BadRequestException('User does not have a profile');
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

  // ─── Encryption ──────────────────────────────────────────

  /**
   * Encrypts plaintext content using AES-256-GCM.
   *
   * @param plaintext - Content to encrypt
   * @returns Encrypted string in format: iv:authTag:ciphertext (all hex-encoded)
   */
  encrypt(plaintext: string): string {
    // Generate a random initialization vector
    const iv = crypto.randomBytes(IV_LENGTH);
    // Create the AES-256-GCM cipher with the derived key and IV
    const cipher = crypto.createCipheriv(ALGORITHM, this.encryptionKey, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });

    // Encrypt the plaintext in chunks and finalize
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    // Extract the authentication tag for integrity verification
    const authTag = cipher.getAuthTag();

    // Return the combined payload: iv:authTag:ciphertext (all hex)
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
  }

  /**
   * Decrypts AES-256-GCM encrypted content.
   *
   * @param encryptedPayload - Encrypted string in format: iv:authTag:ciphertext
   * @returns Decrypted plaintext
   * @throws Error if decryption fails (tampered data, wrong key)
   */
  decrypt(encryptedPayload: string): string {
    // Split the payload into iv, auth tag, and ciphertext components
    const [ivHex, authTagHex, ciphertext] = encryptedPayload.split(':');

    // Validate the payload format has all three components
    if (!ivHex || !authTagHex || !ciphertext) {
      this.logger.error('Invalid encrypted payload format');
      return '[Decryption failed: invalid format]';
    }

    // Attempt decryption within a try-catch for error handling
    try {
      // Reconstruct the IV and auth tag from hex strings
      const iv = Buffer.from(ivHex, 'hex');
      const authTag = Buffer.from(authTagHex, 'hex');
      // Create the decipher with the derived key and reconstructed IV
      const decipher = crypto.createDecipheriv(ALGORITHM, this.encryptionKey, iv, {
        authTagLength: AUTH_TAG_LENGTH,
      });

      // Set the auth tag for GCM integrity verification
      decipher.setAuthTag(authTag);

      // Decrypt the ciphertext and finalize
      let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      return decrypted;
    } catch (error) {
      // Return a placeholder if decryption fails (wrong key, tampered data)
      this.logger.error(`Decryption failed: ${error}`);
      return '[Decryption failed]';
    }
  }

  /**
   * Builds a confidentiality-based access filter based on permissions.
   *
   * @param userPermissions - Effective permissions
   * @param userId - User's member ID
   * @returns Prisma filter object or null if no restriction needed
   */
  private getConfidentialityFilter(
    userPermissions: string[],
    userId: string | null,
  ): Prisma.PastoralNoteWhereInput | null {
    // Check if the user is an admin or pastor role
    const canReadConfidential = userPermissions.includes('pastoral_confidential:read');
    const canReadRestricted = userPermissions.includes('pastoral_restricted:read');

    if (canReadConfidential || canReadRestricted) {
      const allowed: Prisma.PastoralNoteWhereInput[] = [{ confidentiality: 'standard' }];
      if (canReadConfidential) allowed.push({ confidentiality: 'confidential' });
      if (canReadRestricted) allowed.push({ confidentiality: 'restricted' });
      else if (userId) allowed.push({ confidentiality: 'restricted', author_id: userId });

      return { OR: allowed };
    }

    // Regular staff only see standard (non-confidential) notes
    return { confidentiality: 'standard' };
  }

  /**
   * Checks if a user has access to a note based on its confidentiality level.
   *
   * @param note - Pastoral note record
   * @param userPermissions - Effective permissions
   * @param userId - User's member ID
   * @throws ForbiddenException if access is denied
   */
  private checkConfidentialityAccess(
    note: { confidentiality: string; author_id: string },
    userPermissions: string[],
    userId: string | null,
  ): void {
    // Allow all staff to access standard notes
    if (note.confidentiality === 'standard') {
      return; // All staff can access
    }

    // Check if the user has elevated privileges
    const canReadConfidential = userPermissions.includes('pastoral_confidential:read');
    const canReadRestricted = userPermissions.includes('pastoral_restricted:read');

    // Allow pastors and admin to access confidential notes
    if (note.confidentiality === 'confidential' && canReadConfidential) {
      return; // Pastors and admin can access confidential
    }

    // For restricted notes, allow the author or senior pastor/admin
    if (note.confidentiality === 'restricted') {
      if (note.author_id === userId) return; // Author can always access
      if (canReadRestricted) return;
    }

    // Deny access for all other cases
    throw new ForbiddenException(
      `Access denied: ${note.confidentiality} note requires elevated permissions`,
    );
  }

  /**
   * Maps a Prisma PastoralNote record to a response DTO.
   *
   * @param note - Prisma PastoralNote with included member/author
   * @param decryptedContent - Decrypted content string
   * @returns Response DTO
   */
  private mapToResponseDto(
    note: {
      id: string;
      church_id: string;
      member_id: string;
      author_id: string;
      confidentiality: string;
      tags: string[];
      archived_at: Date | null;
      created_at: Date;
      updated_at: Date;
      member?: { first_name: string; last_name: string } | null;
      author?: { first_name: string; last_name: string } | null;
    },
    decryptedContent: string,
  ): PastoralNoteResponseDto {
    // Transform the Prisma record snake_case fields to camelCase DTO format
    return {
      id: note.id,
      churchId: note.church_id,
      memberId: note.member_id,
      memberFirstName: note.member?.first_name || '',
      memberLastName: note.member?.last_name || '',
      authorId: note.author_id,
      authorFirstName: note.author?.first_name || '',
      authorLastName: note.author?.last_name || '',
      content: decryptedContent,
      confidentiality: note.confidentiality,
      tags: note.tags || [],
      archivedAt: note.archived_at?.toISOString(),
      createdAt: note.created_at.toISOString(),
      updatedAt: note.updated_at.toISOString(),
    };
  }

  // ─── Life Events ──────────────────────────────────────────

  /**
   * Creates a new life event record.
   *
   * @param dto - Life event data (memberId, type, date, details)
   * @param churchId - Church ID for tenant scoping
   * @param userId - User creating the event
   * @returns Created life event
   */
  async createLifeEvent(
    dto: CreateLifeEventDto,
    churchId: string,
    userId: string,
  ): Promise<LifeEventResponseDto> {
    // Verify the member belongs to this church
    const subjectMember = await this.prisma.member.findFirst({
      where: {
        id: dto.memberId,
        church_id: churchId,
        ...this.requestContext.branchWhere(churchId),
      },
      select: { id: true },
    });

    if (!subjectMember) {
      throw new NotFoundException('Member not found in this church');
    }

    // Create the life event record in the database
    const event = await this.prisma.lifeEvent.create({
      data: {
        church_id: churchId,
        member_id: dto.memberId,
        type: dto.type,
        date: new Date(dto.date),
        details: (dto.details || {}) as Prisma.InputJsonValue,
      },
      include: {
        member: { select: { first_name: true, last_name: true } },
      },
    });

    // Log the creation event
    this.logger.log(`Life event created: ${event.type} for member ${dto.memberId}`);

    // Record the mutation in the audit log
    await this.audit.log({
      churchId,
      userId,
      action: 'CREATE',
      entity: 'life_event',
      entityId: event.id,
      newValues: { type: event.type, memberId: dto.memberId },
    });

    // Map the Prisma record to a response DTO
    return this.mapLifeEventToResponseDto(event);
  }

  /**
   * Lists life events with pagination and filters.
   *
   * @param query - List/filter parameters
   * @param churchId - Church ID for tenant scoping
   * @returns Paginated list of life events
   */
  async listLifeEvents(
    query: ListLifeEventsDto,
    churchId: string,
  ): Promise<{
    data: LifeEventResponseDto[];
    meta: { total: number; page: number; limit: number; totalPages: number };
  }> {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    // Build the base where clause scoped to the church
    const where: Prisma.LifeEventWhereInput = {
      church_id: churchId,
      member: this.requestContext.branchWhere(churchId),
      archived_at: query.archived === true ? { not: null } : null,
    };

    // Apply optional member filter
    if (query.memberId) {
      where.member_id = query.memberId;
    }

    // Apply optional life event type filter
    if (query.type) {
      where.type = query.type;
    }

    // If upcoming filter is set, only return events on or after today
    if (query.upcoming === 'true') {
      where.date = { gte: new Date() };
    }

    // Execute paginated query and count total in parallel
    const [events, total] = await Promise.all([
      this.prisma.lifeEvent.findMany({
        where,
        include: {
          member: { select: { first_name: true, last_name: true } },
        },
        orderBy: { [query.sortBy || 'date']: query.sortOrder || 'asc' },
        skip,
        take: limit,
      }),
      this.prisma.lifeEvent.count({ where }),
    ]);

    // Map each event to a response DTO and return with pagination metadata
    return {
      data: events.map((e) => this.mapLifeEventToResponseDto(e)),
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Gets a single life event by ID.
   *
   * @param eventId - Life event ID
   * @param churchId - Church ID for tenant scoping
   * @returns Life event data
   */
  async getLifeEventById(eventId: string, churchId: string): Promise<LifeEventResponseDto> {
    // Fetch the life event by ID scoped to the church
    const event = await this.prisma.lifeEvent.findFirst({
      where: {
        id: eventId,
        church_id: churchId,
        member: this.requestContext.branchWhere(churchId),
      },
      include: {
        member: { select: { first_name: true, last_name: true } },
      },
    });

    // Throw NotFoundException if the event does not exist
    if (!event) {
      throw new NotFoundException(`Life event ${eventId} not found`);
    }

    // Map to response DTO and return
    return this.mapLifeEventToResponseDto(event);
  }

  /**
   * Deletes a life event.
   *
   * @param eventId - Life event ID
   * @param churchId - Church ID for tenant scoping
   * @param userId - User performing the delete
   */
  async deleteLifeEvent(eventId: string, churchId: string, userId: string): Promise<void> {
    // Fetch the existing event to verify it exists
    const event = await this.prisma.lifeEvent.findFirst({
      where: {
        id: eventId,
        church_id: churchId,
        member: this.requestContext.branchWhere(churchId),
      },
    });

    // Throw NotFoundException if the event does not exist
    if (!event) {
      throw new NotFoundException(`Life event ${eventId} not found`);
    }

    // Delete the event from the database
    await this.prisma.lifeEvent.delete({ where: { id: eventId } });

    // Log the deletion event
    this.logger.log(`Life event deleted: ${eventId}`);

    // Record the deletion in the audit log
    await this.audit.log({
      churchId,
      userId,
      action: 'DELETE',
      entity: 'life_event',
      entityId: eventId,
      newValues: { type: event.type, memberId: event.member_id },
    });
  }

  /**
   * Archives a life event by setting archived_at. Archived events drop out of
   * active life-event lists and upcoming-greeting pulls (they stay reachable
   * by ID and can be restored).
   *
   * @param eventId - Life event ID
   * @param churchId - Church ID for tenant scoping
   * @param userId - User performing the archive
   * @returns Archived life event
   * @throws NotFoundException if the event is missing or not in this church
   * @throws ConflictException if the event is already archived
   */
  async archiveLifeEvent(
    eventId: string,
    churchId: string,
    userId: string,
  ): Promise<LifeEventResponseDto> {
    const existing = await this.prisma.lifeEvent.findFirst({
      where: {
        id: eventId,
        church_id: churchId,
        member: this.requestContext.branchWhere(churchId),
      },
    });

    if (!existing) {
      throw new NotFoundException(`Life event ${eventId} not found`);
    }

    if (existing.archived_at) {
      throw new ConflictException('Life event is already archived');
    }

    const updated = await this.prisma.lifeEvent.update({
      where: { id: eventId },
      data: { archived_at: new Date() },
      include: {
        member: { select: { first_name: true, last_name: true } },
      },
    });

    await this.audit.log({
      churchId,
      userId,
      action: 'ARCHIVE',
      entity: 'life_event',
      entityId: eventId,
      oldValues: { archived_at: existing.archived_at },
      newValues: { archived_at: updated.archived_at },
    });

    this.logger.log(`Life event archived: ${eventId}`);
    return this.mapLifeEventToResponseDto(updated);
  }

  /**
   * Restores an archived life event by clearing archived_at.
   *
   * @param eventId - Life event ID
   * @param churchId - Church ID for tenant scoping
   * @param userId - User performing the restore
   * @returns Restored life event
   * @throws NotFoundException if the event is missing or not in this church
   * @throws ConflictException if the event is not currently archived
   */
  async restoreLifeEvent(
    eventId: string,
    churchId: string,
    userId: string,
  ): Promise<LifeEventResponseDto> {
    const existing = await this.prisma.lifeEvent.findFirst({
      where: {
        id: eventId,
        church_id: churchId,
        member: this.requestContext.branchWhere(churchId),
      },
    });

    if (!existing) {
      throw new NotFoundException(`Life event ${eventId} not found`);
    }

    if (!existing.archived_at) {
      throw new ConflictException('Life event is not archived');
    }

    const updated = await this.prisma.lifeEvent.update({
      where: { id: eventId },
      data: { archived_at: null },
      include: {
        member: { select: { first_name: true, last_name: true } },
      },
    });

    await this.audit.log({
      churchId,
      userId,
      action: 'RESTORE',
      entity: 'life_event',
      entityId: eventId,
      oldValues: { archived_at: existing.archived_at },
      newValues: { archived_at: null },
    });

    this.logger.log(`Life event restored: ${eventId}`);
    return this.mapLifeEventToResponseDto(updated);
  }

  /**
   * Gets upcoming life events for the next N days.
   * Used for automated birthday/bereavement greetings.
   *
   * @param churchId - Church ID
   * @param daysAhead - Number of days to look ahead (default: 30)
   * @returns Upcoming life events
   */
  async getUpcomingLifeEvents(churchId: string, daysAhead = 30): Promise<LifeEventResponseDto[]> {
    // Compute the date range (now to N days ahead)
    const now = new Date();
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + daysAhead);

    // Fetch un-notified events within the date range, including member contact info
    const events = await this.prisma.lifeEvent.findMany({
      where: {
        church_id: churchId,
        member: this.requestContext.branchWhere(churchId),
        archived_at: null,
        date: { gte: now, lte: futureDate },
        notified: false,
      },
      include: {
        member: {
          select: {
            first_name: true,
            last_name: true,
            whatsapp_number: true,
          },
        },
      },
      orderBy: { date: 'asc' },
    });

    // Map each event to a response DTO
    return events.map((e) => this.mapLifeEventToResponseDto(e));
  }

  /**
   * Marks a life event as notified.
   *
   * @param eventId - Life event ID
   */
  async markLifeEventNotified(eventId: string): Promise<void> {
    // Update the notified flag to true for the given event
    await this.prisma.lifeEvent.update({
      where: { id: eventId },
      data: { notified: true },
    });
  }

  /**
   * Maps a Prisma LifeEvent record to a response DTO.
   */
  private mapLifeEventToResponseDto(event: {
    id: string;
    church_id: string;
    member_id: string;
    type: string;
    date: Date;
    details: Prisma.JsonValue;
    notified: boolean;
    archived_at: Date | null;
    created_at: Date;
    member?: { first_name: string; last_name: string } | null;
  }): LifeEventResponseDto {
    // Transform the Prisma record to camelCase response format
    return {
      id: event.id,
      churchId: event.church_id,
      memberId: event.member_id,
      memberFirstName: event.member?.first_name || '',
      memberLastName: event.member?.last_name || '',
      type: event.type,
      date: event.date.toISOString(),
      details: (event.details || {}) as Record<string, unknown>,
      notified: event.notified,
      archivedAt: event.archived_at?.toISOString(),
      createdAt: event.created_at.toISOString(),
    };
  }
}
