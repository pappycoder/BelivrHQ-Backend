import { LEGACY_BRAND } from '../brand/brand';
import { assertPlanFeature, assertPlanReadableFeature } from '../billing/entitlements';
import { featureForMediaFolder } from '../billing/feature-policy';
/**
 * @file Media upload service with Supabase Storage integration.
 * @module MediaService
 * @description Handles file uploads, image optimization, and deletion from Supabase Storage.
 * Images are automatically optimized to WebP format with quality 80 and max dimensions 1200x1200px.
 * Metadata is stripped from images for privacy and size reduction.
 * @since 1.0.0
 */

import {
  Injectable,
  ForbiddenException,
  StreamableFile,
  Logger,
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../supabase/supabase.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLoggingService } from '../common/services/audit-logging.service';
import { BranchScopeService, ViewerScope } from '../common/services/branch-scope.service';
import { MediaResponseDto } from './dto/media-response.dto';
import { ListLibraryDto } from './dto/list-library.dto';
import { MediaAssetResponseDto } from './dto/media-asset-response.dto';
import { MediaFolderSummaryDto } from './dto/media-folder-summary.dto';
import sharp from 'sharp';
import { Readable } from 'node:stream';
import { randomUUID, createHmac, timingSafeEqual } from 'crypto';
import { DirectUploadDto } from './dto/direct-upload.dto';
import { assertMediaUploadPermission } from './media-upload-policy';
import { Prisma } from '@prisma/client';

/** Allowed MIME types for image uploads */
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];
/** Allowed MIME types for document uploads */
const ALLOWED_DOC_TYPES = [
  'application/pdf',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
  'audio/mp4',
  'audio/aac',
  'audio/flac',
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
];
const FILE_EXTENSIONS: Record<string, string> = {
  'application/pdf': 'pdf',
  'text/csv': 'csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel': 'xls',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/ogg': 'ogg',
  'video/quicktime': 'mov',
};

/** Maximum file size for images (5MB) */
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;
/** Maximum file size for general files incl. audio/video (50MB) */
const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;

/**
 * Interface representing a file uploaded via Multer.
 * @property fieldname - The field name from the form
 * @property originalname - The original filename
 * @property encoding - The file encoding
 * @property mimetype - The MIME type
 * @property size - File size in bytes
 * @property buffer - File content as Buffer
 */
export interface MulterFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/**
 * Service for handling media uploads and file management.
 * Provides methods for uploading images with optimization and documents,
 * as well as deleting files from Supabase Storage.
 */
@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);
  private readonly bucket: string;
  private privateBucketReady?: Promise<void>;
  private readonly publicFolders = new Set(['churches', 'branches', 'profiles']);

  /**
   * Creates an instance of MediaService.
   * @param supabase - Supabase client for storage operations
   * @param config - Configuration service for environment variables
   */
  constructor(
    private readonly supabase: SupabaseService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditLoggingService,
    private readonly branchScope: BranchScopeService,
  ) {
    this.bucket = this.config.get<string>('SUPABASE_STORAGE_BUCKET', 'media');
  }

  private signUpload(payload: string) {
    return createHmac('sha256', this.config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY'))
      .update(`${LEGACY_BRAND.uploadDomain}${payload}`)
      .digest('base64url');
  }

  async prepareDirectUpload(
    dto: DirectUploadDto,
    churchId: string,
    userId: string,
    viewer?: ViewerScope,
  ) {
    const folder = dto.folder || 'uploads';
    this.validateFolder(folder, viewer);
    if (this.publicFolders.has(folder))
      throw new BadRequestException('Use the image uploader for public branding');
    assertMediaUploadPermission(folder, viewer?.permissions ?? []);
    const feature = featureForMediaFolder(folder);
    if (feature) await assertPlanFeature(this.prisma, churchId, feature);
    if (
      !ALLOWED_DOC_TYPES.includes(dto.contentType) ||
      !Number.isInteger(dto.size) ||
      dto.size < 1 ||
      dto.size > MAX_FILE_SIZE_BYTES
    )
      throw new BadRequestException('Choose a supported file no larger than 50 MB');
    const scope = this.branchScope.resolve(viewer);
    if (!scope.churchOnly && dto.branchId && dto.branchId !== scope.branchId)
      throw new ForbiddenException('You can only upload to your branch');
    const branchId = scope.churchOnly ? (dto.branchId ?? null) : (scope.branchId ?? null);
    if (!scope.churchOnly && !branchId)
      throw new ForbiddenException('A branch assignment is required');
    if (
      branchId &&
      !(await this.prisma.branch.findFirst({
        where: { id: branchId, church_id: churchId, archived_at: null },
      }))
    )
      throw new BadRequestException('Invalid branch');
    const bucket = await this.uploadBucket(folder);
    const assetId = randomUUID();
    const path = `${folder}/${churchId}/${randomUUID()}.${FILE_EXTENSIONS[dto.contentType]}`;
    const filename = dto.filename
      .replace(/\\/g, '/')
      .split('/')
      .pop()
      ?.replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, 200);
    if (!filename) throw new BadRequestException('A filename is required');
    const payload = Buffer.from(
      JSON.stringify({
        assetId,
        path,
        bucket,
        filename,
        folder,
        churchId,
        userId,
        branchId,
        size: dto.size,
        contentType: dto.contentType,
        expires: Date.now() + 60 * 60 * 1000,
      }),
    ).toString('base64url');
    const { data, error } = await this.supabase.client.storage
      .from(bucket)
      .createSignedUploadUrl(path, { upsert: false });
    if (error || !data?.signedUrl)
      throw new InternalServerErrorException('Unable to authorize storage upload');
    return { uploadUrl: data.signedUrl, ticket: `${payload}.${this.signUpload(payload)}` };
  }

  async completeDirectUpload(
    ticket: string,
    churchId: string,
    userId: string,
    viewer?: ViewerScope,
  ): Promise<MediaResponseDto> {
    const [payload, signature, extra] = ticket.split('.');
    const expected = this.signUpload(payload ?? '');
    if (
      !payload ||
      !signature ||
      extra ||
      !/^[A-Za-z0-9_-]{43}$/.test(signature) ||
      signature.length !== expected.length ||
      !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    )
      throw new ForbiddenException('Invalid upload authorization');
    const grant = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
      assetId: string;
      path: string;
      bucket: string;
      filename: string;
      folder: string;
      churchId: string;
      userId: string;
      branchId: string | null;
      size: number;
      contentType: string;
      expires: number;
    };
    if (grant.churchId !== churchId || grant.userId !== userId || grant.expires < Date.now())
      throw new ForbiddenException('Upload authorization expired or belongs to another user');
    this.validateFolder(grant.folder, viewer);
    assertMediaUploadPermission(grant.folder, viewer?.permissions ?? []);
    const feature = featureForMediaFolder(grant.folder);
    if (feature) await assertPlanFeature(this.prisma, churchId, feature);
    const scope = this.branchScope.resolve(viewer);
    if (!scope.churchOnly && grant.branchId !== scope.branchId)
      throw new ForbiddenException('You can only upload to your branch');
    if (
      grant.branchId &&
      !(await this.prisma.branch.findFirst({
        where: { id: grant.branchId, church_id: churchId, archived_at: null },
      }))
    )
      throw new BadRequestException('Invalid branch');
    const existing = await this.prisma.mediaAsset.findFirst({
      where: { id: grant.assetId, church_id: churchId, uploaded_by_user_id: userId },
    });
    const response = (asset: { id: string; url: string }) => ({
      assetId: asset.id,
      url: asset.url,
      path: grant.path,
      size: grant.size,
      contentType: grant.contentType,
    });
    if (existing) return response(existing);
    const { data, error } = await this.supabase.client.storage.from(grant.bucket).info(grant.path);
    if (error || !data)
      throw new BadRequestException('The file has not finished uploading. Please retry.');
    if (
      Number(data.size ?? data.metadata?.size) !== grant.size ||
      (data.contentType ?? data.metadata?.mimetype) !== grant.contentType
    )
      throw new BadRequestException('The uploaded file does not match its authorized type or size');
    const url = `${this.config.get<string>('WEB_URL', 'http://localhost:3000')}/api/backend/media/files/${grant.assetId}`;
    // Upsert makes a retried completion safe if the prior response was lost.
    const asset = await this.prisma.mediaAsset.upsert({
      where: { id: grant.assetId },
      update: {},
      create: {
        id: grant.assetId,
        church_id: churchId,
        branch_id: grant.branchId,
        uploaded_by_user_id: userId,
        storage_bucket: grant.bucket,
        storage_path: grant.path,
        filename: grant.filename,
        folder: grant.folder,
        url,
        mime_type: grant.contentType,
        size_bytes: grant.size,
        permissions: 'members',
      },
    });
    await this.audit.log({
      userId,
      churchId,
      entity: 'media_asset',
      action: 'CREATE',
      entityId: asset.id,
      newValues: {
        filename: grant.filename,
        folder: grant.folder,
        size: grant.size,
        directUpload: true,
      },
    });
    return response(asset);
  }

  /**
   * Uploads an image with automatic optimization.
   * Converts to WebP format, resizes to max 1200x1200px, quality 80, strips metadata.
   * @param file - The image file to upload
   * @param folder - Storage folder path (e.g., "churches", "branches")
   * @param churchId - Church ID for multi-tenant storage isolation
   * @returns MediaResponseDto with URL, path, dimensions, and size
   * @throws BadRequestException if file is invalid or too large
   * @throws InternalServerErrorException if upload fails
   */
  async uploadImage(
    file: MulterFile,
    folder: string,
    churchId: string,
    userId?: string,
    viewer?: ViewerScope | null,
    branchId?: string,
  ): Promise<MediaResponseDto> {
    this.validateFile(file, true);
    this.validateFolder(folder, viewer);
    const scope = this.branchScope.resolve(viewer);
    if (!scope.churchOnly && branchId && branchId !== scope.branchId)
      throw new ForbiddenException('You can only upload to your branch');
    const assetId = randomUUID();
    const storageBucket = await this.uploadBucket(folder);
    if (
      branchId &&
      !(await this.prisma.branch.findFirst({ where: { id: branchId, church_id: churchId } }))
    )
      throw new BadRequestException('Invalid branch');

    const optimized = await this.optimizeImage(file.buffer);
    const ext = 'webp';
    const filename = `${randomUUID()}.${ext}`;
    const path = `${folder}/${churchId}/${filename}`;

    const { error } = await this.supabase.client.storage
      .from(storageBucket)
      .upload(path, optimized.buffer, {
        contentType: 'image/webp',
        upsert: false,
      });

    if (error) {
      this.logger.error(`Supabase upload failed: ${error.message}`);
      throw new InternalServerErrorException('Failed to upload image');
    }

    const assetUrl = this.publicFolders.has(folder)
      ? this.supabase.client.storage.from(storageBucket).getPublicUrl(path).data.publicUrl
      : `${this.config.get<string>('WEB_URL', 'http://localhost:3000')}/api/backend/media/files/${assetId}`;

    const metadata = await sharp(optimized.buffer).metadata();

    const asset = await this.prisma.mediaAsset.create({
      data: {
        id: assetId,
        uploaded_by_user_id: userId ?? null,
        storage_path: path,
        storage_bucket: storageBucket,
        church_id: churchId,
        branch_id: scope.churchOnly ? (branchId ?? null) : (scope.branchId ?? null),
        filename,
        url: assetUrl,
        mime_type: 'image/webp',
        size_bytes: optimized.buffer.length,
        folder,
        permissions: this.publicFolders.has(folder) ? 'public' : 'members',
      },
    });

    if (userId) {
      await this.audit.log({
        userId,
        churchId,
        entity: 'media_asset',
        action: 'CREATE',
        entityId: asset.id,
        newValues: { filename, folder, mime_type: 'image/webp', size: optimized.buffer.length },
      });
    }

    return {
      assetId: asset.id,
      url: assetUrl,
      path,
      width: metadata.width,
      height: metadata.height,
      size: optimized.buffer.length,
      contentType: 'image/webp',
    };
  }

  /**
   * Uploads a file without optimization.
   * Accepts images, PDF, CSV, and Excel files.
   * @param file - The file to upload
   * @param folder - Storage folder path (e.g., "documents")
   * @param churchId - Church ID for multi-tenant storage isolation
   * @returns MediaResponseDto with URL, path, and size
   * @throws BadRequestException if file is invalid or too large
   * @throws InternalServerErrorException if upload fails
   */
  async uploadFile(
    file: MulterFile,
    folder: string,
    churchId: string,
    userId?: string,
    viewer?: ViewerScope | null,
    branchId?: string,
  ): Promise<MediaResponseDto> {
    if (file && ALLOWED_IMAGE_TYPES.includes(file.mimetype))
      return this.uploadImage(file, folder, churchId, userId, viewer, branchId);
    this.validateFile(file, false);
    this.validateFolder(folder, viewer);
    const scope = this.branchScope.resolve(viewer);
    if (!scope.churchOnly && branchId && branchId !== scope.branchId)
      throw new ForbiddenException('You can only upload to your branch');
    const assetId = randomUUID();
    const storageBucket = await this.uploadBucket(folder);
    if (
      branchId &&
      !(await this.prisma.branch.findFirst({ where: { id: branchId, church_id: churchId } }))
    )
      throw new BadRequestException('Invalid branch');

    const ext = FILE_EXTENSIONS[file.mimetype] ?? 'bin';
    const filename = `${randomUUID()}.${ext}`;
    const path = `${folder}/${churchId}/${filename}`;
    const displayName =
      file.originalname
        ?.replace(/\\/g, '/')
        .split('/')
        .pop()
        ?.replace(/[\u0000-\u001f\u007f]/g, '')
        .trim()
        .slice(0, 200) || filename;

    const { error } = await this.supabase.client.storage
      .from(storageBucket)
      .upload(path, file.buffer, {
        contentType: file.mimetype,
        upsert: false,
      });

    if (error) {
      this.logger.error(`Supabase upload failed: ${error.message}`);
      throw new InternalServerErrorException('Failed to upload file');
    }

    const assetUrl = this.publicFolders.has(folder)
      ? this.supabase.client.storage.from(storageBucket).getPublicUrl(path).data.publicUrl
      : `${this.config.get<string>('WEB_URL', 'http://localhost:3000')}/api/backend/media/files/${assetId}`;

    const asset = await this.prisma.mediaAsset.create({
      data: {
        id: assetId,
        uploaded_by_user_id: userId ?? null,
        storage_path: path,
        storage_bucket: storageBucket,
        church_id: churchId,
        branch_id: scope.churchOnly ? (branchId ?? null) : (scope.branchId ?? null),
        filename: displayName,
        url: assetUrl,
        mime_type: file.mimetype,
        size_bytes: file.buffer.length,
        folder,
        permissions: this.publicFolders.has(folder) ? 'public' : 'members',
      },
    });

    if (userId) {
      await this.audit.log({
        userId,
        churchId,
        entity: 'media_asset',
        action: 'CREATE',
        entityId: asset.id,
        newValues: {
          filename: displayName,
          folder,
          mime_type: file.mimetype,
          size: file.buffer.length,
        },
      });
    }

    return {
      assetId: asset.id,
      url: assetUrl,
      path,
      size: file.buffer.length,
      contentType: file.mimetype,
    };
  }

  /**
   * Deletes a file from Supabase Storage by its path.
   * @param path - Storage path of the file to delete
   * @returns Promise<void>
   */
  async deleteFile(
    path: string,
    churchId?: string,
    userId?: string,
    viewer?: ViewerScope,
  ): Promise<void> {
    if (
      !churchId ||
      path.split('/')[1] !== churchId ||
      path.split('/').some((part) => !part || part === '.' || part === '..')
    )
      throw new ForbiddenException('Invalid storage path');
    const asset = await this.prisma.mediaAsset.findFirst({
      where: {
        church_id: churchId,
        OR: [
          { storage_path: path },
          { url: this.supabase.client.storage.from(this.bucket).getPublicUrl(path).data.publicUrl },
        ],
      },
    });
    if (!asset) throw new NotFoundException('Media asset not found');
    await this.deleteAsset(asset.id, churchId, userId, viewer);
  }

  /**
   * Deletes a file from Supabase Storage by its public URL.
   * Extracts the path from the URL and calls deleteFile.
   * @param url - Public URL of the file to delete
   * @returns Promise<void>
   */
  async deleteByUrl(url: string): Promise<void> {
    const path = this.extractPathFromUrl(url);
    if (!path) return;
    const asset = await this.prisma.mediaAsset.findFirst({ where: { url, storage_path: path } });
    if (!asset || !this.publicFolders.has(asset.folder)) return;
    const { error } = await this.supabase.client.storage
      .from(asset.storage_bucket ?? this.bucket)
      .remove([path]);
    if (!error) await this.prisma.mediaAsset.delete({ where: { id: asset.id } });
  }

  /**
   * Lists media assets with pagination, folder filter, and search.
   */
  async listLibrary(
    dto: ListLibraryDto,
    churchId: string,
    viewer?: ViewerScope | null,
  ): Promise<{ data: MediaAssetResponseDto[]; total: number }> {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.MediaAssetWhereInput = {
      church_id: churchId,
    };
    const scope = this.branchScope.resolve(viewer);
    if (!scope.churchOnly)
      where.AND = [{ OR: [{ branch_id: scope.branchId ?? null }, { branch_id: null }] }];
    else if (scope.churchOnly && dto.branchId)
      where.AND = [{ OR: [{ branch_id: dto.branchId }, { branch_id: null }] }];

    if (dto.folder) {
      where.folder = { contains: dto.folder, mode: 'insensitive' };
    }

    if (dto.mimeType) {
      where.mime_type = { contains: dto.mimeType, mode: 'insensitive' };
    }

    if (dto.permissions) where.permissions = dto.permissions;
    if (!viewer?.permissions?.includes('media:restricted:read')) {
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : []),
        { permissions: { not: 'leadership' } },
      ];
    }

    if (dto.search) {
      where.filename = { contains: dto.search, mode: 'insensitive' };
    }

    const orderBy: Prisma.MediaAssetOrderByWithRelationInput =
      dto.sortBy === 'filename'
        ? { filename: dto.sortOrder ?? 'asc' }
        : dto.sortBy === 'size_bytes'
          ? { size_bytes: dto.sortOrder ?? 'desc' }
          : { created_at: dto.sortOrder ?? 'desc' };

    const [assets, total] = await Promise.all([
      this.prisma.mediaAsset.findMany({
        where,
        orderBy,
        skip,
        take: limit,
      }),
      this.prisma.mediaAsset.count({ where }),
    ]);

    return {
      data: assets.map((a) => this.mapAssetToDto(a)),
      total,
    };
  }

  /**
   * Gets a single media asset by ID.
   */
  async getAsset(
    assetId: string,
    churchId: string,
    viewer?: ViewerScope | null,
  ): Promise<MediaAssetResponseDto> {
    const asset = await this.prisma.mediaAsset.findFirst({
      where: { id: assetId, church_id: churchId },
    });

    if (!asset || (asset.branch_id && !this.branchScope.isVisible(viewer, asset.branch_id))) {
      throw new NotFoundException('Media asset not found');
    }

    if (
      asset.permissions === 'leadership' &&
      !viewer?.permissions?.includes('media:restricted:read')
    )
      throw new NotFoundException('Media asset not found');
    return this.mapAssetToDto(asset);
  }

  /**
   * Gets folder summaries for the church's media assets — each folder name
   * with an asset count and the newest asset's timestamp. The web media
   * library derives per-folder stats from this instead of walking the entire
   * asset list.
   */
  async getFolders(churchId: string, viewer?: ViewerScope): Promise<MediaFolderSummaryDto[]> {
    const result = await this.prisma.mediaAsset.groupBy({
      by: ['folder'],
      where: {
        church_id: churchId,
        ...(viewer?.permissions?.includes('media:restricted:read')
          ? {}
          : { permissions: { not: 'leadership' } }),
        ...(this.branchScope.resolve(viewer).churchOnly
          ? {}
          : {
              OR: [{ branch_id: this.branchScope.resolve(viewer).branchId }, { branch_id: null }],
            }),
      },
      _count: { _all: true },
      _max: { created_at: true },
      orderBy: { folder: 'asc' },
    });

    return result.map((r) => ({
      folder: r.folder,
      count: r._count._all,
      newestAt: r._max.created_at ? r._max.created_at.toISOString() : null,
    }));
  }

  /**
   * Deletes a media asset from both the database and Supabase Storage.
   */
  async deleteAsset(
    assetId: string,
    churchId: string,
    userId?: string,
    viewer?: ViewerScope | null,
  ): Promise<void> {
    const asset = await this.prisma.mediaAsset.findFirst({
      where: { id: assetId, church_id: churchId },
    });

    if (!asset || (asset.branch_id && !this.branchScope.isVisible(viewer, asset.branch_id))) {
      throw new NotFoundException('Media asset not found');
    }

    if (
      asset.permissions === 'leadership' &&
      !viewer?.permissions?.includes('media:restricted:read')
    )
      throw new NotFoundException('Media asset not found');
    if (
      !asset.branch_id &&
      this.branchScope.isBranchRestricted(viewer) &&
      asset.uploaded_by_user_id !== userId
    )
      throw new ForbiddenException(
        'Shared media can only be deleted by its owner or an HQ administrator',
      );

    // Remove bytes before the library record.
    const path = asset.storage_path ?? this.extractPathFromUrl(asset.url);
    if (path) {
      const { error } = await this.supabase.client.storage
        .from(asset.storage_bucket ?? this.bucket)
        .remove([path]);
      if (error) throw new InternalServerErrorException('Unable to remove media bytes');
    }

    await this.prisma.mediaAsset.delete({ where: { id: assetId } });

    if (userId) {
      await this.audit.log({
        userId,
        churchId,
        entity: 'media_asset',
        action: 'DELETE',
        entityId: assetId,
        oldValues: { filename: asset.filename, folder: asset.folder },
      });
    }

    this.logger.log(`Media asset deleted: ${assetId}`);
  }

  /**
   * Updates the permissions on a media asset.
   */
  async updatePermissions(
    assetId: string,
    permissions: string,
    churchId: string,
    userId?: string,
    viewer?: ViewerScope | null,
  ): Promise<MediaAssetResponseDto> {
    const asset = await this.prisma.mediaAsset.findFirst({
      where: { id: assetId, church_id: churchId },
    });

    if (!asset || (asset.branch_id && !this.branchScope.isVisible(viewer, asset.branch_id))) {
      throw new NotFoundException('Media asset not found');
    }

    if (
      asset.permissions === 'leadership' &&
      !viewer?.permissions?.includes('media:restricted:read')
    )
      throw new NotFoundException('Media asset not found');
    if (
      !asset.branch_id &&
      this.branchScope.isBranchRestricted(viewer) &&
      asset.uploaded_by_user_id !== userId
    )
      throw new ForbiddenException(
        'Shared media can only be changed by its owner or an HQ administrator',
      );
    if (permissions === 'leadership' && !viewer?.permissions?.includes('media:restricted:read'))
      throw new ForbiddenException('Restricted media permission is required');
    const updated = await this.prisma.mediaAsset.update({
      where: { id: assetId },
      data: { permissions },
    });

    if (userId) {
      await this.audit.log({
        userId,
        churchId,
        entity: 'media_asset',
        action: 'UPDATE',
        entityId: assetId,
        oldValues: { permissions: asset.permissions },
        newValues: { permissions },
      });
    }

    return this.mapAssetToDto(updated);
  }

  private validateFolder(folder: string, viewer?: ViewerScope | null) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(folder))
      throw new BadRequestException('Use a simple folder name');
    if (folder === 'churches' && viewer && !viewer.permissions?.includes('church_settings:update'))
      throw new ForbiddenException('Branding permission is required');
    if (folder === 'branches' && viewer && !viewer.permissions?.includes('branches:update'))
      throw new ForbiddenException('Branch update permission is required');
  }

  private async uploadBucket(folder: string) {
    if (this.publicFolders.has(folder)) return this.bucket;
    const bucket = this.config.get<string>('SUPABASE_PRIVATE_STORAGE_BUCKET', 'media-private');
    if (!this.privateBucketReady) {
      this.privateBucketReady = (async () => {
        const { data, error } = await this.supabase.client.storage.getBucket(bucket);
        if (error) {
          if (String(error.statusCode) !== '404')
            throw new InternalServerErrorException('Unable to verify private storage');
          const { error: createError } = await this.supabase.client.storage.createBucket(bucket, {
            public: false,
          });
          if (createError) {
            // A parallel instance may have just created it; verify rather than assume.
            const result = await this.supabase.client.storage.getBucket(bucket);
            if (result.error || result.data?.public !== false)
              throw new InternalServerErrorException('Private storage is unavailable');
          }
        } else if (data?.public !== false)
          throw new InternalServerErrorException(
            'Restricted media requires a private storage bucket',
          );
      })().catch((error) => {
        this.privateBucketReady = undefined;
        throw error;
      });
    }
    await this.privateBucketReady;
    return bucket;
  }

  async getFile(
    assetId: string,
    churchId: string,
    viewer: ViewerScope | undefined,
    range?: string,
    userId?: string,
  ) {
    const asset = await this.prisma.mediaAsset.findFirst({
      where: { id: assetId, church_id: churchId },
    });
    if (
      !asset ||
      !viewer ||
      (asset.branch_id && !this.branchScope.isVisible(viewer, asset.branch_id))
    )
      throw new NotFoundException('Media not found');
    const feature = featureForMediaFolder(asset.folder);
    if (feature) await assertPlanReadableFeature(this.prisma, churchId, feature);
    const permissions = viewer.permissions ?? [];
    const allowed =
      asset.uploaded_by_user_id === userId ||
      permissions.includes('media:library:read') ||
      (asset.folder === 'assets' && permissions.includes('assets:list:read')) ||
      (asset.folder === 'form-attachments' && permissions.includes('forms:submissions:read')) ||
      (asset.folder.startsWith('sermon') && permissions.includes('sermons:list:read'));
    if (
      !allowed ||
      (asset.permissions === 'leadership' && !permissions.includes('media:restricted:read'))
    )
      throw new ForbiddenException('You cannot view this media');
    if (!asset.storage_path || !asset.storage_bucket)
      throw new NotFoundException('This file has not been migrated to managed storage');
    const { data, error } = await this.supabase.client.storage
      .from(asset.storage_bucket)
      .createSignedUrl(asset.storage_path, 60);
    if (error || !data?.signedUrl)
      throw new InternalServerErrorException('Unable to retrieve media');
    const headers: Record<string, string> = {};
    if (range && /^bytes=\d+-\d*$/.test(range)) headers.Range = range;
    const response = await fetch(data.signedUrl, {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok || !response.body) throw new NotFoundException('Media bytes are unavailable');
    return {
      status: response.status,
      contentRange: response.headers.get('content-range'),
      length: response.headers.get('content-length'),
      file: new StreamableFile(
        Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
        {
          type: asset.mime_type,
          disposition: `inline; filename="${asset.filename.replace(/[^a-zA-Z0-9._-]/g, '_')}"`,
        },
      ),
    };
  }

  // ─── MAPPERS ───────────────────────────────────────────────────

  /**
   * Maps a Prisma MediaAsset to MediaAssetResponseDto.
   */
  private mapAssetToDto(
    asset: Record<string, unknown> & { id: string; created_at: Date },
  ): MediaAssetResponseDto {
    return {
      assetId: asset.id,
      churchId: asset.church_id as string,
      filename: asset.filename as string,
      url: asset.url as string,
      mimeType: asset.mime_type as string,
      sizeBytes: asset.size_bytes as number,
      folder: asset.folder as string,
      permissions: asset.permissions as string,
      createdAt: asset.created_at.toISOString(),
    };
  }

  /**
   * Optimizes an image buffer using sharp.
   * Converts to WebP, resizes to max 1200x1200px, quality 80.
   * @param buffer - The image buffer to optimize
   * @returns Optimized image buffer
   */
  private async optimizeImage(buffer: Buffer): Promise<{ buffer: Buffer }> {
    const result = await sharp(buffer, { limitInputPixels: 25_000_000, sequentialRead: true })
      .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer({ resolveWithObject: true });

    return { buffer: result.data };
  }

  /**
   * Validates file size and MIME type.
   * @param file - The file to validate
   * @param isImage - Whether to validate as image only (true) or image + document (false)
   * @throws BadRequestException if file is missing, too large, or has invalid type
   */
  private validateFile(file: MulterFile, isImage: boolean): void {
    if (!file?.buffer || !file.size) throw new BadRequestException('Choose a non-empty file');
    if (!file) {
      throw new BadRequestException('No file provided');
    }

    const maxBytes = isImage ? MAX_IMAGE_SIZE_BYTES : MAX_FILE_SIZE_BYTES;
    if (file.size > maxBytes) {
      throw new BadRequestException(`File size exceeds maximum of ${maxBytes / 1024 / 1024}MB`);
    }

    const allowedTypes = isImage
      ? ALLOWED_IMAGE_TYPES
      : [...ALLOWED_IMAGE_TYPES, ...ALLOWED_DOC_TYPES];

    const bytes = file.buffer;
    const ascii = (start: number, length: number) =>
      bytes.subarray(start, start + length).toString('ascii');
    const starts = (hex: string) =>
      bytes.subarray(0, hex.length / 2).equals(Buffer.from(hex, 'hex'));
    const signatures: Record<string, () => boolean> = {
      'application/pdf': () => ascii(0, 5) === '%PDF-',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': () => starts('504b0304'),
      'application/vnd.ms-excel': () => starts('d0cf11e0a1b11ae1'),
      'audio/mpeg': () =>
        ascii(0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0),
      'audio/wav': () => ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE',
      'audio/ogg': () => ascii(0, 4) === 'OggS',
      'video/ogg': () => ascii(0, 4) === 'OggS',
      'audio/flac': () => ascii(0, 4) === 'fLaC',
      'audio/aac': () => bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0,
      'audio/mp4': () => ascii(4, 4) === 'ftyp',
      'video/mp4': () => ascii(4, 4) === 'ftyp',
      'video/quicktime': () => ['ftyp', 'moov', 'mdat', 'wide'].includes(ascii(4, 4)),
      'video/webm': () => starts('1a45dfa3'),
      'text/csv': () =>
        !bytes.includes(0) &&
        !/^\s*<(?:!doctype|html|script|svg)/i.test(bytes.subarray(0, 512).toString('utf8')),
    };
    if (signatures[file.mimetype] && !signatures[file.mimetype]())
      throw new BadRequestException('File content does not match its declared type');
    if (!allowedTypes.includes(file.mimetype)) {
      throw new BadRequestException(
        `File type "${file.mimetype}" is not allowed. Accepted: ${allowedTypes.join(', ')}`,
      );
    }
  }

  /**
   * Extracts the storage path from a Supabase public URL.
   * @param url - The full Supabase Storage public URL
   * @returns The storage path relative to the bucket, or null if invalid
   */
  private extractPathFromUrl(url: string): string | null {
    try {
      const marker = `/storage/v1/object/public/${this.bucket}/`;
      const parsed = new URL(url);
      if (
        parsed.origin !== new URL(this.config.getOrThrow<string>('SUPABASE_URL')).origin ||
        !parsed.pathname.startsWith(marker)
      )
        return null;
      const path = decodeURIComponent(parsed.pathname.slice(marker.length));
      if (path.split('/').some((part) => !part || part === '.' || part === '..')) return null;
      return path;
    } catch {
      return null;
    }
  }
}
