/**
 * @file templates.controller.ts
 * @description HTTP endpoints for message template management.
 *
 * Provides REST endpoints for template CRUD with channel and status filtering.
 * Write operations are restricted to church_admin, branch_pastor, and secretary roles.
 * Delete is restricted to church_admin only.
 *
 * @module templates/templates.controller
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
  HttpCode,
  HttpStatus,
  Request,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
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
import { TemplatesService } from './templates.service';
import { CreateTemplateDto } from './dto/create-template.dto';
import { UpdateTemplateDto } from './dto/update-template.dto';
import { ListTemplatesDto } from './dto/list-templates.dto';
import { TemplateResponseDto } from './dto/template-response.dto';

@ApiTags('Templates')
@ApiBearerAuth('supabase-auth')
@UseGuards(JwtAuthGuard)
@Controller('templates')
export class TemplatesController {
  constructor(private readonly templatesService: TemplatesService) {}

  /**
   * Creates a new message template.
   *
   * @param dto - Template creation data (name, content, channel)
   * @param user - Authenticated Supabase user
   * @param req - HTTP request with profile context
   * @returns Created template response
   */
  @Post()
  @RequirePermissions('templates:create')
  @HttpCode(HttpStatus.CREATED)
  @ApiCreateEndpoint('Create a message template')
  async create(
    @Body() dto: CreateTemplateDto,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<TemplateResponseDto> {
    const churchId = req.profile?.church_id || '';
    return this.templatesService.create(dto, churchId, user.sub, req.profile);
  }

  /**
   * Lists message templates with pagination and optional filters.
   *
   * @param query - Query parameters for pagination, channel, status, search
   * @param req - HTTP request with profile context
   * @returns Paginated list of templates
   */
  @Get()
  @RequirePermissions('templates:read')
  @ApiPaginatedResponse(TemplateResponseDto)
  @ApiOperation({ summary: 'List templates', description: 'List message templates with filters.' })
  async findAll(@Query() query: ListTemplatesDto, @Request() req: AuthenticatedRequest) {
    const churchId = req.profile?.church_id || '';
    const result = await this.templatesService.findAll(churchId, query, req.profile);
    return {
      data: result.data,
      meta: {
        total: result.total,
        page: query.page || 1,
        limit: query.limit || 20,
        totalPages: Math.ceil(result.total / (query.limit || 20)),
      },
    };
  }

  /**
   * Publishes a draft template, making it available for use in broadcasts.
   *
   * @param templateId - Template UUID to publish
   * @param user - Authenticated Supabase user
   * @param req - HTTP request with profile context
   * @returns Updated template response with published status
   */
  @Post(':templateId/publish')
  @RequirePermissions('templates:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Publish a template',
    description:
      'Transitions a draft template to published status, making it available for use in broadcasts. Returns 400 if the template is already published or archived.',
  })
  @ApiParam({ name: 'templateId', description: 'Template UUID' })
  @ApiResponse({ status: 200, description: 'Template published successfully' })
  @ApiResponse({
    status: 400,
    description: 'Template is already published or archived',
  })
  @ApiResponse({ status: 404, description: 'Template not found' })
  async publish(
    @Param('templateId') templateId: string,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<TemplateResponseDto> {
    const churchId = req.profile?.church_id || '';
    return this.templatesService.publish(templateId, churchId, user.sub);
  }

  /**
   * Gets a single template by ID.
   *
   * @param templateId - Template UUID
   * @param req - HTTP request with profile context
   * @returns Template response
   */
  @Get(':templateId')
  @RequirePermissions('templates:read')
  @ApiGetEndpoint('Get template by ID')
  @ApiParam({ name: 'templateId', description: 'Template UUID' })
  async findOne(
    @Param('templateId') templateId: string,
    @Request() req: AuthenticatedRequest,
  ): Promise<TemplateResponseDto> {
    const churchId = req.profile?.church_id || '';
    return this.templatesService.findById(templateId, churchId);
  }

  /**
   * Updates a template with partial data.
   *
   * @param templateId - Template UUID to update
   * @param dto - Update data (name, content, channel, status, language)
   * @param user - Authenticated Supabase user
   * @param req - HTTP request with profile context
   * @returns Updated template response
   */
  @Patch(':templateId')
  @RequirePermissions('templates:update')
  @HttpCode(HttpStatus.OK)
  @ApiUpdateEndpoint('Update a template')
  @ApiParam({ name: 'templateId', description: 'Template UUID' })
  async update(
    @Param('templateId') templateId: string,
    @Body() dto: UpdateTemplateDto,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<TemplateResponseDto> {
    const churchId = req.profile?.church_id || '';
    return this.templatesService.update(templateId, dto, churchId, user.sub);
  }

  @Post(':templateId/archive')
  @RequirePermissions('templates:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Archive a template',
    description: 'Sets archived_at: hides the template from active lists until restored.',
  })
  @ApiParam({ name: 'templateId', description: 'Template UUID' })
  @ApiResponse({ status: 200, description: 'Template archived successfully' })
  @ApiResponse({ status: 404, description: 'Template not found' })
  @ApiResponse({ status: 409, description: 'Template is already archived' })
  async archive(
    @Param('templateId') templateId: string,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<TemplateResponseDto> {
    const churchId = req.profile?.church_id || '';
    return this.templatesService.archive(templateId, churchId, user.sub);
  }

  @Post(':templateId/restore')
  @RequirePermissions('templates:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Restore an archived template',
    description: 'Clears archived_at: brings the template back into active lists.',
  })
  @ApiParam({ name: 'templateId', description: 'Template UUID' })
  @ApiResponse({ status: 200, description: 'Template restored successfully' })
  @ApiResponse({ status: 404, description: 'Template not found' })
  @ApiResponse({ status: 409, description: 'Template is not archived' })
  async restore(
    @Param('templateId') templateId: string,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<TemplateResponseDto> {
    const churchId = req.profile?.church_id || '';
    return this.templatesService.restore(templateId, churchId, user.sub);
  }

  /**
   * Deletes a template permanently.
   *
   * @param templateId - Template UUID to delete
   * @param user - Authenticated Supabase user
   * @param req - HTTP request with profile context
   * @returns Success confirmation
   */
  @Delete(':templateId')
  @RequirePermissions('templates:delete')
  @HttpCode(HttpStatus.OK)
  @ApiDeleteEndpoint('Delete a template')
  @ApiParam({ name: 'templateId', description: 'Template UUID' })
  async remove(
    @Param('templateId') templateId: string,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<{ success: boolean }> {
    const churchId = req.profile?.church_id || '';
    await this.templatesService.delete(templateId, churchId, user.sub);
    return { success: true };
  }
}
