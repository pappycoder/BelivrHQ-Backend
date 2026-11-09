import { ImportVisitorDto } from './dto/import-visitor.dto';
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
  UseInterceptors,
  Request,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiOkResponse } from '@nestjs/swagger';
import { VisitorsService } from './visitors.service';
import { CreateVisitorDto } from './dto/create-visitor.dto';
import { UpdateVisitorDto } from './dto/update-visitor.dto';
import { ConvertVisitorDto } from './dto/convert-visitor.dto';
import { ListVisitorsDto } from './dto/list-visitors.dto';
import { VisitorResponseDto } from './dto/visitor-response.dto';
import { VisitorSummaryResponseDto } from './dto/visitor-summary-response.dto';
import { CacheInterceptor, CacheTTL } from '../common/interceptors/cache.interceptor';
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

@ApiTags('Visitors')
@ApiBearerAuth('supabase-auth')
@UseGuards(JwtAuthGuard)
@Controller('visitors')
export class VisitorsController {
  constructor(private readonly visitorsService: VisitorsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('visitors:new:create')
  @ApiCreateEndpoint('Register a new visitor', 'Registers a new visitor for follow-up.')
  async create(
    @Body() dto: CreateVisitorDto,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<VisitorResponseDto> {
    const churchId = req.profile?.church_id || '';
    return this.visitorsService.create(dto, churchId, user.id, req.profile);
  }

  @Post('bulk-import')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('visitors:new:create')
  @ApiOperation({
    summary: 'Bulk import visitors',
    description: 'Validate or import up to 100 visitors per batch with per-row errors.',
  })
  async bulkImport(
    @Body() body: { visitors: ImportVisitorDto[]; dryRun?: boolean },
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.visitorsService.bulkImport(
      body.visitors,
      req.profile?.church_id || '',
      user.id,
      body.dryRun ?? false,
      req.profile,
    );
  }

  @Get()
  @RequirePermissions('visitors:list:read')
  @ApiPaginatedResponse(VisitorResponseDto)
  @ApiOperation({
    summary: 'List visitors',
    description: 'List visitors with pagination, search, and filters.',
  })
  async findAll(@Query() query: ListVisitorsDto, @Request() req: AuthenticatedRequest) {
    const churchId = req.profile?.church_id || '';
    const result = await this.visitorsService.findAll(churchId, query, req.profile);
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

  @Get('stats')
  @UseInterceptors(CacheInterceptor)
  @CacheTTL(300)
  @RequirePermissions('visitors:list:read')
  @ApiOkResponse({ type: VisitorSummaryResponseDto })
  @ApiOperation({
    summary: 'Visitor summary',
    description:
      'Returns total, new-this-month, in-follow-up, and converted visitor counts in one request.',
  })
  async getVisitorsSummary(
    @Request() req: AuthenticatedRequest,
  ): Promise<VisitorSummaryResponseDto> {
    const churchId = req.profile?.church_id || '';
    return this.visitorsService.getVisitorsSummary(churchId, req.profile);
  }

  @Get(':visitorId')
  @RequirePermissions('visitors:list:read')
  @ApiGetEndpoint('Get a visitor by ID', 'Retrieves a single visitor by its UUID.')
  async findOne(
    @Param('visitorId') visitorId: string,
    @Request() req: AuthenticatedRequest,
  ): Promise<VisitorResponseDto> {
    const churchId = req.profile?.church_id || '';
    return this.visitorsService.findOne(visitorId, churchId);
  }

  @Patch(':visitorId')
  @RequirePermissions('visitors:list:update')
  @ApiUpdateEndpoint('Update a visitor', 'Updates a visitor with partial data.')
  async update(
    @Param('visitorId') visitorId: string,
    @Body() dto: UpdateVisitorDto,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<VisitorResponseDto> {
    const churchId = req.profile?.church_id || '';
    return this.visitorsService.update(visitorId, dto, churchId, user.id);
  }

  @Post(':visitorId/convert')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('visitors:followup:update')
  @ApiOperation({
    summary: 'Convert visitor to member',
    description:
      'Creates a new member record from the visitor (carrying gender and custom fields) and marks them as converted.',
  })
  async convert(
    @Param('visitorId') visitorId: string,
    @Body() dto: ConvertVisitorDto,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<{ visitor: VisitorResponseDto; memberId: string }> {
    const churchId = req.profile?.church_id || '';
    return this.visitorsService.convertToMember(visitorId, dto, churchId, user.id);
  }

  @Post(':visitorId/archive')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('visitors:list:update')
  @ApiOperation({
    summary: 'Archive a visitor',
    description: 'Sets archived_at: hides the visitor from active lists until restored.',
  })
  async archive(
    @Param('visitorId') visitorId: string,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<VisitorResponseDto> {
    const churchId = req.profile?.church_id || '';
    return this.visitorsService.archive(visitorId, churchId, user.id);
  }

  @Post(':visitorId/restore')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('visitors:list:update')
  @ApiOperation({
    summary: 'Restore an archived visitor',
    description: 'Clears archived_at: brings the visitor back into active lists.',
  })
  async restore(
    @Param('visitorId') visitorId: string,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<VisitorResponseDto> {
    const churchId = req.profile?.church_id || '';
    return this.visitorsService.restore(visitorId, churchId, user.id);
  }

  @Delete(':visitorId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('visitors:list:delete')
  @ApiDeleteEndpoint('Delete a visitor', 'Permanently deletes a visitor record.')
  async remove(
    @Param('visitorId') visitorId: string,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<void> {
    const churchId = req.profile?.church_id || '';
    await this.visitorsService.remove(visitorId, churchId, user.id);
  }
}
