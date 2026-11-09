import { DirectUploadDto, CompleteDirectUploadDto } from './dto/direct-upload.dto';
import { assertPlanFeature } from '../billing/entitlements';
import { featureForMediaFolder } from '../billing/feature-policy';
import { PrismaService } from '../prisma/prisma.service';
/**
 * @file Media upload controller with REST API endpoints.
 * @module MediaController
 * @description Handles HTTP requests for file uploads, image optimization, and deletion.
 * All endpoints require JWT authentication via Supabase.
 * @since 1.0.0
 */

import {
  Controller,
  Get,
  Headers,
  Header,
  Post,
  Delete,
  Patch,
  Param,
  Body,
  Query,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  HttpCode,
  HttpStatus,
  Request,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiBearerAuth,
  ApiConsumes,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiOkResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { CacheInterceptor, CacheTTL } from '../common/interceptors/cache.interceptor';
import {
  AuthenticatedRequest,
  CurrentUser,
  SupabaseUser,
} from '../common/decorators/current-user.decorator';
import {
  ApiCreateEndpoint,
  ApiGetEndpoint,
  ApiUpdateEndpoint,
  ApiDeleteEndpoint,
} from '../common/decorators/api-standard-responses.decorator';
import { ApiPaginatedResponse } from '../common/decorators/api-paginated.decorator';
import { MediaService, MulterFile } from './media.service';
import { assertMediaUploadPermission } from './media-upload-policy';
import { UploadMediaDto } from './dto/upload-media.dto';
import { MediaResponseDto } from './dto/media-response.dto';
import { ListLibraryDto } from './dto/list-library.dto';
import { MediaAssetResponseDto } from './dto/media-asset-response.dto';
import { MediaFolderSummaryDto } from './dto/media-folder-summary.dto';

/**
 * Controller for media upload operations.
 * Provides endpoints for uploading images and files, and deleting them.
 * All endpoints require JWT authentication.
 */
@ApiTags('Media')
@ApiBearerAuth('supabase-auth')
@UseGuards(JwtAuthGuard)
@Controller('media')
export class MediaController {
  @Post('upload/prepare')
  @ApiOperation({ summary: 'Authorize a direct file upload' })
  async prepareUpload(
    @Body() dto: DirectUploadDto,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.mediaService.prepareDirectUpload(
      dto,
      req.profile?.church_id || '',
      user.sub,
      req.profile,
    );
  }

  @Post('upload/complete')
  @ApiOperation({ summary: 'Verify and save a completed direct upload' })
  async completeUpload(
    @Body() dto: CompleteDirectUploadDto,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.mediaService.completeDirectUpload(
      dto.ticket,
      req.profile?.church_id || '',
      user.sub,
      req.profile,
    );
  }

  /**
   * Creates an instance of MediaController.
   * @param mediaService - Service for media operations
   */
  constructor(
    private readonly mediaService: MediaService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('files/:assetId')
  @Header('Cache-Control', 'private, no-store')
  async file(
    @Param('assetId') assetId: string,
    @Request() req: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
    @Headers('range') range?: string,
  ) {
    const result = await this.mediaService.getFile(
      assetId,
      req.profile?.church_id ?? '',
      req.profile,
      range,
      req.user.sub,
    );
    response.status(result.status);
    response.setHeader('Accept-Ranges', 'bytes');
    if (result.contentRange) response.setHeader('Content-Range', result.contentRange);
    if (result.length) response.setHeader('Content-Length', result.length);
    return result.file;
  }

  @Post('upload/image')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 5, fieldSize: 8192, parts: 8 },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'Image file (JPEG, PNG, WebP, GIF, AVIF)',
        },
        folder: {
          type: 'string',
          description: 'Storage folder (e.g., churches, branches, profiles)',
          example: 'churches',
        },
      },
      required: ['file'],
    },
  })
  @ApiCreateEndpoint(
    'Upload and optimize an image',
    'Uploads an image to Supabase Storage with automatic optimization (WebP conversion, resize to max 1200px, quality 80, metadata stripped).',
  )
  /**
   * Uploads and optimizes an image.
   * @param file - The image file to upload
   * @param dto - Upload metadata (folder, optional entity ID)
   * @param req - Authenticated request with user profile
   * @returns MediaResponseDto with optimized image URL and metadata
   */
  async uploadImage(
    @UploadedFile() file: MulterFile,
    @Body() dto: UploadMediaDto,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<MediaResponseDto> {
    const churchId = req.profile?.church_id || '';
    const folder = dto.folder || 'uploads';
    const feature = featureForMediaFolder(folder);
    if (feature) await assertPlanFeature(this.prisma, churchId, feature);
    assertMediaUploadPermission(folder, req.profile?.permissions ?? []);
    return this.mediaService.uploadImage(
      file,
      folder,
      churchId,
      user.sub,
      req.profile,
      dto.branchId,
    );
  }

  @Post('upload')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 50 * 1024 * 1024, files: 1, fields: 5, fieldSize: 8192, parts: 8 },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'File to upload (images, PDF, CSV, Excel, audio, video: max 50MB)',
        },
        folder: { type: 'string', description: 'Storage folder', example: 'documents' },
      },
      required: ['file'],
    },
  })
  @ApiCreateEndpoint(
    'Upload a file',
    'Uploads a file to Supabase Storage without image optimization. Supports images, documents, audio, and video (max 50MB).',
  )
  /**
   * Uploads a file without optimization.
   * @param file - The file to upload
   * @param dto - Upload metadata (folder, optional entity ID)
   * @param req - Authenticated request with user profile
   * @returns MediaResponseDto with file URL and metadata
   */
  async uploadFile(
    @UploadedFile() file: MulterFile,
    @Body() dto: UploadMediaDto,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<MediaResponseDto> {
    const churchId = req.profile?.church_id || '';
    const folder = dto.folder || 'uploads';
    const feature = featureForMediaFolder(folder);
    if (feature) await assertPlanFeature(this.prisma, churchId, feature);
    assertMediaUploadPermission(folder, req.profile?.permissions ?? []);
    return this.mediaService.uploadFile(
      file,
      folder,
      churchId,
      user.sub,
      req.profile,
      dto.branchId,
    );
  }

  /**
   * Lists media assets with pagination and filters.
   */
  @Get('library')
  @RequirePermissions('media:library:read')
  @ApiPaginatedResponse(MediaAssetResponseDto)
  @ApiOperation({
    summary: 'Browse media library',
    description: 'List media assets with folder, MIME type, permission, and search filters.',
  })
  async listLibrary(
    @Query() dto: ListLibraryDto,
    @Request() req: AuthenticatedRequest,
  ): Promise<{ data: MediaAssetResponseDto[]; total: number }> {
    const churchId = req.profile?.church_id || '';
    return this.mediaService.listLibrary(dto, churchId, req.profile);
  }

  /**
   * Gets unique folder list for the church's media library.
   */
  @Get('library/folders')
  @UseInterceptors(CacheInterceptor)
  @CacheTTL(300)
  @RequirePermissions('media:folders:read')
  @ApiOkResponse({ type: MediaFolderSummaryDto, isArray: true })
  @ApiOperation({
    summary: 'List media folders',
    description: 'Returns each media folder with its asset count and newest asset timestamp.',
  })
  async getFolders(
    @Request() req: AuthenticatedRequest,
  ): Promise<{ data: MediaFolderSummaryDto[] }> {
    const churchId = req.profile?.church_id || '';
    const folders = await this.mediaService.getFolders(churchId, req.profile);
    return { data: folders };
  }

  /**
   * Gets a single media asset by ID.
   */
  @Get('library/:assetId')
  @RequirePermissions('media:library:read')
  @ApiGetEndpoint('Get media asset details')
  @ApiParam({ name: 'assetId', description: 'Media asset UUID' })
  async getAsset(
    @Param('assetId') assetId: string,
    @Request() req: AuthenticatedRequest,
  ): Promise<MediaAssetResponseDto> {
    const churchId = req.profile?.church_id || '';
    return this.mediaService.getAsset(assetId, churchId, req.profile);
  }

  /**
   * Updates permissions on a media asset.
   */
  @Patch('library/:assetId/permissions')
  @RequirePermissions('media:library:update')
  @ApiUpdateEndpoint('Update media permissions')
  @ApiParam({ name: 'assetId', description: 'Media asset UUID' })
  async updatePermissions(
    @Param('assetId') assetId: string,
    @Body('permissions') permissions: string,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<MediaAssetResponseDto> {
    const churchId = req.profile?.church_id || '';
    return this.mediaService.updatePermissions(
      assetId,
      permissions,
      churchId,
      user.sub,
      req.profile,
    );
  }

  /**
   * Deletes a media asset from both database and storage.
   */
  @Delete('library/:assetId')
  @RequirePermissions('media:library:delete')
  @HttpCode(HttpStatus.OK)
  @ApiDeleteEndpoint('Delete a media asset')
  @ApiParam({ name: 'assetId', description: 'Media asset UUID' })
  async deleteAsset(
    @Param('assetId') assetId: string,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<{ success: boolean }> {
    const churchId = req.profile?.church_id || '';
    await this.mediaService.deleteAsset(assetId, churchId, user.sub, req.profile);
    return { success: true };
  }

  @Delete('*path')
  @RequirePermissions('media:library:delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete a file from storage',
    description: 'Deletes a file by its storage path.',
  })
  /**
   * Deletes a file from Supabase Storage.
   * @param path - Storage path of the file to delete (URL-encoded)
   * @returns Object with success status
   */
  async deleteFile(
    @Param('path') path: string | string[],
    @Request() req: AuthenticatedRequest,
  ): Promise<{ success: boolean }> {
    const decodedPath = Array.isArray(path) ? path.join('/') : path;
    await this.mediaService.deleteFile(
      decodedPath,
      req.profile?.church_id ?? '',
      req.user?.sub,
      req.profile,
    );
    return { success: true };
  }
}
