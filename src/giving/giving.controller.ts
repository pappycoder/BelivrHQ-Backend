/**
 * @file giving.controller.ts
 * @description HTTP endpoints for giving operations.
 *
 * Provides category CRUD, digital payment initialization/verification,
 * webhook handling, cash/bank recording, transaction queries, and
 * receipt generation.
 *
 * @module giving/giving.controller
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
  UseInterceptors,
  Request,
  Res,
  Headers,
  HttpCode,
  HttpStatus,
  BadRequestException,
  Req,
} from '@nestjs/common';
import { Request as ExpressRequest } from 'express';
import { RawBodyRequest } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiHeader, ApiOkResponse } from '@nestjs/swagger';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { SkipRateLimit } from '../common/guards/rate-limit.guard';
import { CurrentUser, SupabaseUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedRequest } from '../common/decorators/current-user.decorator';
import {
  ApiCreateEndpoint,
  ApiGetEndpoint,
  ApiUpdateEndpoint,
  ApiDeleteEndpoint,
} from '../common/decorators/api-standard-responses.decorator';
import { ApiPaginatedResponse } from '../common/decorators/api-paginated.decorator';
import { GivingDashboardQueryDto } from './dto/dashboard-query.dto';
import {
  GivingDashboardChartsQueryDto,
  GivingDashboardChartsResponseDto,
} from './dto/dashboard-charts.dto';
import { CacheInterceptor, CacheTTL } from '../common/interceptors/cache.interceptor';
import { GivingService } from './giving.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { ListCategoriesDto } from './dto/list-categories.dto';
import { CategoryResponseDto } from './dto/category-response.dto';
import { InitializePaymentDto } from './dto/initialize-payment.dto';
import { RecordCashDto } from './dto/record-cash.dto';
import { TransactionResponseDto } from './dto/transaction-response.dto';
import { TransactionSummaryResponseDto } from './dto/transaction-summary-response.dto';
import { ListTransactionsDto } from './dto/list-transactions.dto';
import { CreateRecurringGivingDto } from './dto/create-recurring-giving.dto';
import { RecurringGivingResponseDto } from './dto/recurring-giving-response.dto';
import { ListRecurringGivingDto } from './dto/list-recurring-giving.dto';

/**
 * Controller for giving operations.
 * Provides endpoints for categories, payments, transactions, and receipts.
 */
@ApiTags('Giving')
@ApiBearerAuth('supabase-auth')
@Controller('giving')
export class GivingController {
  constructor(private readonly givingService: GivingService) {}

  @UseGuards(JwtAuthGuard)
  @Get('payment-options')
  @RequirePermissions('giving:recurring:read')
  async paymentOptions(@Request() req: AuthenticatedRequest) {
    return this.givingService.paymentOptions(req.profile!.church_id);
  }

  @UseGuards(JwtAuthGuard)
  @Get('cell-groups/:groupId')
  @RequirePermissions('cell_groups:giving:read')
  async getCellGroupGiving(
    @Param('groupId') groupId: string,
    @Query() query: ListTransactionsDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.givingService.getCellGroupGiving(
      groupId,
      req.profile?.church_id || '',
      query,
      req.profile,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('cell-groups/:groupId')
  @RequirePermissions('cell_groups:giving:create')
  @HttpCode(HttpStatus.CREATED)
  async recordCellGroupGiving(
    @Param('groupId') groupId: string,
    @Body() dto: RecordCashDto,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.givingService.recordCellGroupGiving(
      groupId,
      dto,
      req.profile?.church_id || '',
      user.sub,
      req.profile,
    );
  }

  // ─── CATEGORIES ───────────────────────────────────────────────────

  /**
   * Create a new giving category.
   */
  @UseGuards(JwtAuthGuard)
  @Post('categories')
  @RequirePermissions('giving:categories:create')
  @ApiCreateEndpoint('Create a giving category', 'Creates a new giving category for the church.')
  async createCategory(
    @Body() dto: CreateCategoryDto,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<CategoryResponseDto> {
    const churchId = req.profile?.church_id || '';
    return this.givingService.createCategory(dto, churchId, user.sub, req.profile);
  }

  /**
   * List all giving categories.
   */
  @UseGuards(JwtAuthGuard)
  @Get('categories')
  @RequirePermissions('giving:categories:read')
  @ApiPaginatedResponse(CategoryResponseDto)
  @ApiOperation({
    summary: 'List giving categories',
    description: 'Retrieves all giving categories for the church, ordered by display order.',
  })
  async listCategories(@Query() query: ListCategoriesDto, @Request() req: AuthenticatedRequest) {
    const churchId = req.profile?.church_id || '';
    const result = await this.givingService.listCategories(
      churchId,
      query.isActive,
      query.page,
      query.limit,
      query.archived,
      query.branchId,
      req.profile,
    );
    // Without a limit all rows are returned; report that as a single page.
    const effectiveLimit = query.limit || result.total || 1;
    return {
      data: result.data,
      meta: {
        total: result.total,
        page: query.page || 1,
        limit: effectiveLimit,
        totalPages: Math.ceil(result.total / effectiveLimit),
      },
    };
  }

  /**
   * Get a single giving category.
   */
  @UseGuards(JwtAuthGuard)
  @Get('categories/:categoryId')
  @RequirePermissions('giving:categories:read')
  @ApiGetEndpoint('Get a giving category', 'Retrieves a single giving category by ID.')
  async getCategory(
    @Param('categoryId') categoryId: string,
    @Request() req: AuthenticatedRequest,
  ): Promise<CategoryResponseDto> {
    const churchId = req.profile?.church_id || '';
    return this.givingService.getCategoryById(categoryId, churchId);
  }

  /**
   * Update a giving category.
   */
  @UseGuards(JwtAuthGuard)
  @Patch('categories/:categoryId')
  @RequirePermissions('giving:categories:update')
  @ApiUpdateEndpoint('Update a giving category', 'Updates a giving category with partial data.')
  async updateCategory(
    @Param('categoryId') categoryId: string,
    @Body() dto: UpdateCategoryDto,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<CategoryResponseDto> {
    const churchId = req.profile?.church_id || '';
    return this.givingService.updateCategory(categoryId, dto, churchId, user.sub);
  }

  /**
   * Soft-delete a giving category.
   */
  @UseGuards(JwtAuthGuard)
  @Delete('categories/:categoryId')
  @RequirePermissions('giving:categories:delete')
  @ApiDeleteEndpoint('Delete a giving category', 'Deactivates a giving category.')
  async deleteCategory(
    @Param('categoryId') categoryId: string,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<{ success: boolean }> {
    const churchId = req.profile?.church_id || '';
    await this.givingService.deleteCategory(categoryId, churchId, user.sub);
    return { success: true };
  }

  /**
   * Archive a giving category.
   */
  @UseGuards(JwtAuthGuard)
  @Post('categories/:categoryId/archive')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('giving:categories:update')
  @ApiUpdateEndpoint('Archive a giving category', 'Archives a giving category.')
  async archiveCategory(
    @Param('categoryId') categoryId: string,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<CategoryResponseDto> {
    const churchId = req.profile?.church_id || '';
    return this.givingService.archiveCategory(categoryId, churchId, user.sub);
  }

  /**
   * Restore an archived giving category.
   */
  @UseGuards(JwtAuthGuard)
  @Post('categories/:categoryId/restore')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('giving:categories:update')
  @ApiUpdateEndpoint('Restore a giving category', 'Restores an archived giving category.')
  async restoreCategory(
    @Param('categoryId') categoryId: string,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<CategoryResponseDto> {
    const churchId = req.profile?.church_id || '';
    return this.givingService.restoreCategory(categoryId, churchId, user.sub);
  }

  // ─── DIGITAL GIVING ──────────────────────────────────────────────

  /**
   * Initialize a Paystack payment.
   */
  @UseGuards(JwtAuthGuard)
  @Post('initialize')
  @HttpCode(HttpStatus.CREATED)
  @ApiCreateEndpoint(
    'Initialize a digital payment',
    'Creates a pending transaction and returns a payment authorization URL. Supports multiple gateways (Paystack, Flutterwave).',
  )
  async initializePayment(
    @Body() dto: InitializePaymentDto,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ) {
    const churchId = req.profile?.church_id || '';
    return this.givingService.initializePayment(dto, churchId, user.sub);
  }

  /**
   * Verify a payment by reference.
   */
  @UseGuards(JwtAuthGuard)
  @Get('verify/:reference')
  @ApiGetEndpoint(
    'Verify a payment',
    'Checks the status of a payment with Paystack and updates the transaction.',
  )
  async verifyPayment(
    @Param('reference') reference: string,
    @Request() req: AuthenticatedRequest,
  ): Promise<TransactionResponseDto> {
    const churchId = req.profile?.church_id || '';
    return this.givingService.verifyPayment(reference, churchId);
  }

  // ─── WEBHOOK ──────────────────────────────────────────────────────

  /**
   * Paystack webhook handler.
   *
   * This endpoint is NOT authenticated — it verifies the Paystack signature.
   */
  @Post('webhook/paystack')
  @SkipRateLimit()
  @HttpCode(HttpStatus.OK)
  @ApiHeader({ name: 'x-paystack-signature', description: 'Paystack webhook signature' })
  @ApiOperation({
    summary: 'Paystack webhook',
    description: 'Receives and processes Paystack webhook events.',
  })
  async handlePaystackWebhook(
    @Headers('x-paystack-signature') signature: string,
    @Req() request: RawBodyRequest<ExpressRequest>,
  ) {
    const rawBody = this.getRawBody(request);
    return this.givingService.handleWebhook(rawBody, signature || '', 'paystack');
  }

  /**
   * Flutterwave webhook handler.
   *
   * This endpoint is NOT authenticated — it verifies the Flutterwave signature.
   */
  @Post('webhook/flutterwave')
  @SkipRateLimit()
  @HttpCode(HttpStatus.OK)
  @ApiHeader({ name: 'verif-hash', description: 'Flutterwave webhook signature' })
  @ApiOperation({
    summary: 'Flutterwave webhook',
    description: 'Receives and processes Flutterwave webhook events.',
  })
  async handleFlutterwaveWebhook(
    @Headers('verif-hash') signature: string,
    @Req() request: RawBodyRequest<ExpressRequest>,
  ) {
    const rawBody = this.getRawBody(request);
    return this.givingService.handleWebhook(
      rawBody,
      String(request.headers['flutterwave-signature'] ?? signature ?? ''),
      'flutterwave',
    );
  }

  /** Returns the exact provider-signed payload captured by Nest's Express adapter. */
  private getRawBody(request: RawBodyRequest<ExpressRequest>): string {
    if (!request.rawBody) {
      throw new BadRequestException('Missing raw webhook payload');
    }
    return request.rawBody.toString('utf8');
  }

  // ─── CASH/BANK GIVING ────────────────────────────────────────────

  /**
   * Record cash or bank transfer giving.
   */
  @UseGuards(JwtAuthGuard)
  @Post('cash')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('giving:records:create')
  @ApiCreateEndpoint(
    'Record cash/bank giving',
    'Records an offline cash or bank transfer giving transaction with auto-generated receipt number.',
  )
  async recordCashGiving(
    @Body() dto: RecordCashDto,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<TransactionResponseDto> {
    const churchId = req.profile?.church_id || '';
    return this.givingService.recordCashGiving(dto, churchId, user.sub, req.profile);
  }

  // ─── RECURRING GIVING ────────────────────────────────────────────

  /**
   * Create a recurring giving schedule.
   */
  @UseGuards(JwtAuthGuard)
  @Post('recurring')
  @RequirePermissions('giving:recurring:create')
  @HttpCode(HttpStatus.CREATED)
  @ApiCreateEndpoint(
    'Create recurring giving',
    'Sets up an automated recurring charge schedule for a giving category.',
  )
  async createRecurringGiving(
    @Body() dto: CreateRecurringGivingDto,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<RecurringGivingResponseDto> {
    const churchId = req.profile?.church_id || '';
    return this.givingService.createRecurringGiving(dto, churchId, user.sub, req.profile);
  }

  /**
   * List recurring giving schedules.
   */
  @UseGuards(JwtAuthGuard)
  @Get('recurring')
  @RequirePermissions('giving:recurring:read')
  @ApiPaginatedResponse(RecurringGivingResponseDto)
  @ApiOperation({
    summary: 'List recurring givings',
    description: 'Retrieves paginated recurring giving schedules for the church.',
  })
  async listRecurringGiving(
    @Query() query: ListRecurringGivingDto,
    @Request() req: AuthenticatedRequest,
  ) {
    const churchId = req.profile?.church_id || '';
    const result = await this.givingService.listRecurringGiving(churchId, query, req.profile);
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
   * Get a single recurring giving by ID.
   */
  @UseGuards(JwtAuthGuard)
  @Get('recurring/:id')
  @RequirePermissions('giving:recurring:read')
  @ApiGetEndpoint('Get recurring giving', 'Retrieves a single recurring giving schedule by ID.')
  async getRecurringGiving(
    @Param('id') id: string,
    @Request() req: AuthenticatedRequest,
  ): Promise<RecurringGivingResponseDto> {
    const churchId = req.profile?.church_id || '';
    return this.givingService.getRecurringGivingById(id, churchId, req.profile);
  }

  /**
   * Cancel a recurring giving schedule.
   */
  @UseGuards(JwtAuthGuard)
  @Patch('recurring/:id/cancel')
  @RequirePermissions('giving:recurring:update')
  @ApiOperation({
    summary: 'Cancel recurring giving',
    description: 'Soft-cancels a recurring giving schedule. No further charges will be made.',
  })
  async cancelRecurringGiving(
    @Param('id') id: string,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<{ success: boolean }> {
    const churchId = req.profile?.church_id || '';
    await this.givingService.cancelRecurringGiving(id, churchId, user.sub, req.profile);
    return { success: true };
  }

  @UseGuards(JwtAuthGuard)
  @Patch('recurring/:id/pause')
  @RequirePermissions('giving:recurring:update')
  @ApiOperation({
    summary: 'Pause recurring giving',
    description:
      'Temporarily pauses a recurring giving schedule. No further charges will be made until resumed.',
  })
  async pauseRecurringGiving(
    @Param('id') id: string,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<{ success: boolean }> {
    const churchId = req.profile?.church_id || '';
    await this.givingService.pauseRecurringGiving(id, churchId, user.sub, req.profile);
    return { success: true };
  }

  @UseGuards(JwtAuthGuard)
  @Patch('recurring/:id/resume')
  @RequirePermissions('giving:recurring:update')
  @ApiOperation({
    summary: 'Resume recurring giving',
    description: 'Resumes a previously paused recurring giving schedule.',
  })
  async resumeRecurringGiving(
    @Param('id') id: string,
    @CurrentUser() user: SupabaseUser,
    @Request() req: AuthenticatedRequest,
  ): Promise<{ success: boolean }> {
    const churchId = req.profile?.church_id || '';
    await this.givingService.resumeRecurringGiving(id, churchId, user.sub, req.profile);
    return { success: true };
  }

  // ─── TRANSACTIONS ────────────────────────────────────────────────

  /**
   * List transactions with pagination and filters.
   */
  @UseGuards(JwtAuthGuard)
  @Get('transactions')
  @RequirePermissions('giving:records:read')
  @ApiPaginatedResponse(TransactionResponseDto)
  @ApiOperation({
    summary: 'List transactions',
    description: 'Retrieves a paginated list of giving transactions with optional filters.',
  })
  async listTransactions(
    @Query() query: ListTransactionsDto,
    @Request() req: AuthenticatedRequest,
  ) {
    const churchId = req.profile?.church_id || '';
    const result = await this.givingService.listTransactions(churchId, query, req.profile);
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
   * Return aggregated giving totals (month, all-time, count, 30-day trend).
   */
  @UseGuards(JwtAuthGuard)
  @Get('dashboard')
  @RequirePermissions('giving:dashboard:read')
  @UseInterceptors(CacheInterceptor)
  @CacheTTL(60)
  @ApiOkResponse({ type: TransactionSummaryResponseDto })
  @ApiOperation({
    summary: 'Read aggregate giving dashboard without individual transaction access',
  })
  async getDashboard(
    @Query() query: GivingDashboardQueryDto,
    @Request() req: AuthenticatedRequest,
  ): Promise<TransactionSummaryResponseDto> {
    return this.givingService.getTransactionsSummary(
      req.profile?.church_id || '',
      query,
      req.profile,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Get('dashboard/charts')
  @RequirePermissions('giving:dashboard:read')
  @UseInterceptors(CacheInterceptor)
  @CacheTTL(60)
  @ApiOkResponse({ type: GivingDashboardChartsResponseDto })
  @ApiOperation({ summary: 'Read scoped giving charts without individual donor data' })
  async getDashboardCharts(
    @Query() query: GivingDashboardChartsQueryDto,
    @Request() req: AuthenticatedRequest,
  ): Promise<GivingDashboardChartsResponseDto> {
    return this.givingService.getDashboardCharts(req.profile?.church_id || '', query, req.profile);
  }

  @UseGuards(JwtAuthGuard)
  @Get('transactions/summary')
  @RequirePermissions('giving:records:read')
  @UseInterceptors(CacheInterceptor)
  @CacheTTL(300)
  @ApiOkResponse({ type: TransactionSummaryResponseDto })
  @ApiOperation({
    summary: 'Giving summary',
    description:
      'Returns month-to-date and all-time totals, a successful-transaction count, and a 30-day trend.',
  })
  async getTransactionsSummary(
    @Query() query: ListTransactionsDto,
    @Request() req: AuthenticatedRequest,
  ): Promise<TransactionSummaryResponseDto> {
    const churchId = req.profile?.church_id || '';
    return this.givingService.getTransactionsSummary(churchId, query, req.profile);
  }

  /**
   * Get a single transaction by ID.
   */
  @UseGuards(JwtAuthGuard)
  @Get('transactions/:transactionId')
  @RequirePermissions('giving:records:read')
  @ApiGetEndpoint('Get transaction details', 'Retrieves a single giving transaction by ID.')
  async getTransaction(
    @Param('transactionId') transactionId: string,
    @Request() req: AuthenticatedRequest,
  ): Promise<TransactionResponseDto> {
    const churchId = req.profile?.church_id || '';
    return this.givingService.getTransactionById(transactionId, churchId, req.profile);
  }

  /**
   * Download a PDF receipt for a transaction.
   */
  @UseGuards(JwtAuthGuard)
  @Get('transactions/:transactionId/receipt')
  @RequirePermissions('giving:records:read')
  @ApiOperation({
    summary: 'Download receipt',
    description: 'Generates and downloads a PDF receipt for a successful transaction.',
  })
  async downloadReceipt(
    @Param('transactionId') transactionId: string,
    @Request() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const churchId = req.profile?.church_id || '';
    const { buffer, filename } = await this.givingService.generateReceipt(
      transactionId,
      churchId,
      req.profile,
    );

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': buffer.length,
    });
    res.send(buffer);
  }

  @UseGuards(JwtAuthGuard)
  @Post('transactions/:transactionId/send-receipt')
  @RequirePermissions('giving:records:read')
  @ApiOperation({
    summary: 'Send receipt',
    description: 'Sends a receipt for a transaction via WhatsApp or email.',
  })
  async sendReceipt(
    @Param('transactionId') transactionId: string,
    @Body('channel') channel: 'whatsapp' | 'email',
    @Request() req: AuthenticatedRequest,
  ): Promise<{ success: boolean; message: string }> {
    const churchId = req.profile?.church_id || '';
    return this.givingService.sendReceipt(transactionId, churchId, channel, req.profile);
  }
}
