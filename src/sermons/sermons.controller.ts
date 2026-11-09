/**
 * @file sermons.controller.ts
 * @description HTTP endpoints for sermon management.
 *
 * Provides sermon CRUD with search, filtering, and pagination.
 *
 * @module sermons/sermons.controller
 * @since 1.0.0
 */

import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiParam } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { CurrentUser, SupabaseUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedRequest } from '../common/decorators/current-user.decorator';
import {
  ApiCreateEndpoint,
  ApiGetEndpoint,
  ApiUpdateEndpoint,
  ApiDeleteEndpoint,
} from '../common/decorators/api-standard-responses.decorator';
import { ApiPaginatedResponse } from '../common/decorators/api-paginated.decorator';
import { SermonsService } from './sermons.service';
import { CreateSermonDto } from './dto/create-sermon.dto';
import { UpdateSermonDto } from './dto/update-sermon.dto';
import { ListSermonsDto } from './dto/list-sermons.dto';
import { SermonResponseDto } from './dto/sermon-response.dto';

/**
 * Controller for sermon management.
 */
@ApiTags('Sermons')
@ApiBearerAuth('supabase-auth')
@UseGuards(JwtAuthGuard)
@Controller('sermons')
export class SermonsController {
  constructor(private readonly sermonsService: SermonsService) {}

  /**
   * Create a new sermon record.
   */
  @Post()
  @RequirePermissions('sermons:new:create')
  @ApiCreateEndpoint('Create a sermon', 'Creates a new sermon record for the church.')
  async createSermon(
    @Body() dto: CreateSermonDto,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<SermonResponseDto> {
    const churchId = req.profile?.church_id || '';
    return this.sermonsService.createSermon(dto, churchId, user.sub, req.profile);
  }

  /**
   * List bookmarked sermons (defined before :sermonId to avoid route conflicts).
   */
  @Get('bookmarks/me')
  @ApiOperation({
    summary: 'List my bookmarked sermons',
    description: 'Returns all sermons bookmarked by the authenticated member.',
  })
  async listMyBookmarks(
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<SermonResponseDto[]> {
    const churchId = req.profile?.church_id || '';
    return this.sermonsService.listBookmarks(user.sub, churchId);
  }

  /**
   * List sermons with pagination and filters.
   */
  @Get()
  @RequirePermissions('sermons:list:read')
  @ApiPaginatedResponse(SermonResponseDto)
  @ApiOperation({
    summary: 'List sermons',
    description: 'List church sermons with search, filtering, and pagination.',
  })
  async listSermons(
    @Query() dto: ListSermonsDto,
    @Request() req: AuthenticatedRequest,
  ): Promise<{ data: SermonResponseDto[]; total: number }> {
    const churchId = req.profile?.church_id || '';
    return this.sermonsService.listSermons(dto, churchId, req.profile);
  }

  /**
   * List distinct series with counts (must be before :sermonId).
   */
  @Get('series')
  @RequirePermissions('sermons:series:read')
  @ApiOperation({
    summary: 'List sermon series',
    description: 'Returns distinct series names with sermon counts for the church.',
  })
  async listSeries(
    @Request() req: AuthenticatedRequest,
  ): Promise<{ name: string; count: number; lastDate: string }[]> {
    const churchId = req.profile?.church_id || '';
    return this.sermonsService.listSeries(churchId, req.profile);
  }

  /**
   * List distinct speakers with counts (must be before :sermonId).
   */
  @Get('speakers')
  @RequirePermissions('sermons:speakers:read')
  @ApiOperation({
    summary: 'List sermon speakers',
    description: 'Returns distinct speakers with sermon counts for the church.',
  })
  async listSpeakers(
    @Request() req: AuthenticatedRequest,
  ): Promise<{ name: string; count: number; lastDate: string }[]> {
    const churchId = req.profile?.church_id || '';
    return this.sermonsService.listSpeakers(churchId, req.profile);
  }

  /** Form suggestions are available to authors without opening aggregate reports. */
  @Get('new/options')
  @RequirePermissions('sermons:new:create')
  @ApiOperation({ summary: 'List speaker and series suggestions for a new sermon' })
  async newSermonOptions(@Request() req: AuthenticatedRequest) {
    return this.sermonsService.formOptions(req.profile?.church_id || '', req.profile);
  }

  @Get('edit/options')
  @RequirePermissions('sermons:update')
  @ApiOperation({ summary: 'List speaker and series suggestions for sermon editing' })
  async editSermonOptions(@Request() req: AuthenticatedRequest) {
    return this.sermonsService.formOptions(req.profile?.church_id || '', req.profile);
  }

  /**
   * Get a single sermon by ID.
   */
  @Get(':sermonId')
  @RequirePermissions('sermons:list:read')
  @ApiGetEndpoint('Get sermon details')
  @ApiParam({ name: 'sermonId', description: 'Sermon UUID' })
  async getSermon(
    @Param('sermonId') sermonId: string,
    @Request() req: AuthenticatedRequest,
  ): Promise<SermonResponseDto> {
    const churchId = req.profile?.church_id || '';
    return this.sermonsService.getSermon(sermonId, churchId, req.profile);
  }

  /**
   * Update a sermon.
   */
  @Patch(':sermonId')
  @RequirePermissions('sermons:update')
  @ApiUpdateEndpoint('Update sermon details')
  @ApiParam({ name: 'sermonId', description: 'Sermon UUID' })
  async updateSermon(
    @Param('sermonId') sermonId: string,
    @Body() dto: UpdateSermonDto,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<SermonResponseDto> {
    const churchId = req.profile?.church_id || '';
    return this.sermonsService.updateSermon(sermonId, dto, churchId, user.sub, req.profile);
  }

  /**
   * Delete a sermon.
   */
  @Delete(':sermonId')
  @RequirePermissions('sermons:delete')
  @ApiDeleteEndpoint('Delete a sermon')
  @ApiParam({ name: 'sermonId', description: 'Sermon UUID' })
  async deleteSermon(
    @Param('sermonId') sermonId: string,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<void> {
    const churchId = req.profile?.church_id || '';
    return this.sermonsService.deleteSermon(sermonId, churchId, user.sub, req.profile);
  }

  /**
   * Archive a sermon.
   */
  @Post(':sermonId/archive')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('sermons:update')
  @ApiUpdateEndpoint('Archive a sermon')
  @ApiParam({ name: 'sermonId', description: 'Sermon UUID' })
  async archiveSermon(
    @Param('sermonId') sermonId: string,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<SermonResponseDto> {
    const churchId = req.profile?.church_id || '';
    return this.sermonsService.archiveSermon(sermonId, churchId, user.sub, req.profile);
  }

  /**
   * Restore an archived sermon.
   */
  @Post(':sermonId/restore')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('sermons:update')
  @ApiUpdateEndpoint('Restore an archived sermon')
  @ApiParam({ name: 'sermonId', description: 'Sermon UUID' })
  async restoreSermon(
    @Param('sermonId') sermonId: string,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<SermonResponseDto> {
    const churchId = req.profile?.church_id || '';
    return this.sermonsService.restoreSermon(sermonId, churchId, user.sub, req.profile);
  }

  // ─── BOOKMARKS ──────────────────────────────────────────────────

  /**
   * Bookmark a sermon.
   */
  @Post(':sermonId/bookmark')
  @HttpCode(HttpStatus.CREATED)
  @ApiParam({ name: 'sermonId', description: 'Sermon UUID' })
  @ApiOperation({
    summary: 'Bookmark a sermon',
    description: 'Adds a bookmark for the authenticated member.',
  })
  async addBookmark(
    @Param('sermonId') sermonId: string,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<{ bookmarked: boolean }> {
    const churchId = req.profile?.church_id || '';
    return this.sermonsService.addBookmark(sermonId, user.sub, churchId);
  }

  /**
   * Remove a sermon bookmark.
   */
  @Delete(':sermonId/bookmark')
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'sermonId', description: 'Sermon UUID' })
  @ApiOperation({
    summary: 'Remove sermon bookmark',
    description: 'Removes a bookmark for the authenticated member.',
  })
  async removeBookmark(
    @Param('sermonId') sermonId: string,
    @CurrentUser() user: SupabaseUser,
  ): Promise<{ bookmarked: boolean }> {
    return this.sermonsService.removeBookmark(sermonId, user.sub);
  }

  /**
   * Check if a sermon is bookmarked.
   */
  @Get(':sermonId/bookmark')
  @ApiParam({ name: 'sermonId', description: 'Sermon UUID' })
  @ApiOperation({
    summary: 'Check if sermon is bookmarked',
    description: 'Returns whether the authenticated member has bookmarked this sermon.',
  })
  async checkBookmark(
    @Param('sermonId') sermonId: string,
    @CurrentUser() user: SupabaseUser,
  ): Promise<{ bookmarked: boolean }> {
    return this.sermonsService.isBookmarked(sermonId, user.sub);
  }
}
