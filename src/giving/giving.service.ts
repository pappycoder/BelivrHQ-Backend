import { ConfigService } from '@nestjs/config';
import { givingReceiptEmail } from '../company-email/company-email.templates';
import { applyAdjustment, record } from './services/payment-lifecycle';
import type { PaymentAdjustment } from './services/payment-lifecycle';
import type { PaymentVerifyResult } from './services/payment-gateway.interface';
import { parseGivingDate } from './giving-date';
import { PaymentAccountsService } from './services/payment-accounts.service';
/**
 * @file giving.service.ts
 * @description Business logic for giving categories, transactions, and receipts.
 *
 * Handles category CRUD, digital payment initialization/verification,
 * cash/bank recording, webhook processing, and PDF receipt generation.
 * Supports multiple payment gateways via the PaymentGatewayProvider interface.
 *
 * @module giving/giving.service
 * @since 1.0.0
 */

import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
  Inject,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLoggingService } from '../common/services/audit-logging.service';
import { BranchScopeService, ViewerScope } from '../common/services/branch-scope.service';
import { NotificationsService } from '../notifications/notifications.service';
import { IntegrationAlertService } from '../notifications/integration-alert.service';
import {
  PaymentGatewayProvider,
  PAYMENT_GATEWAY_REGISTRY,
} from './services/payment-gateway.interface';
import { ReceiptService, ReceiptTransactionData } from './services/receipt.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { CategoryResponseDto } from './dto/category-response.dto';
import { InitializePaymentDto } from './dto/initialize-payment.dto';
import { RecordCashDto } from './dto/record-cash.dto';
import { TransactionResponseDto } from './dto/transaction-response.dto';
import { ListTransactionsDto } from './dto/list-transactions.dto';
import {
  GivingDashboardChartsQueryDto,
  GivingDashboardChartsResponseDto,
  GivingDashboardCategoryDto,
} from './dto/dashboard-charts.dto';
import {
  TransactionSummaryResponseDto,
  GivingTrendPointDto,
} from './dto/transaction-summary-response.dto';
import { CreateRecurringGivingDto } from './dto/create-recurring-giving.dto';
import { RecurringGivingResponseDto } from './dto/recurring-giving-response.dto';
import { ListRecurringGivingDto } from './dto/list-recurring-giving.dto';
import { randomBytes } from 'crypto';
import { Prisma } from '@prisma/client';

/** Default payment gateway when church config does not specify one */

/**
 * Service for managing giving operations.
 * Provides category management, payment processing, transaction recording,
 * and receipt generation. Supports multiple payment gateways.
 */

@Injectable()
export class GivingService {
  private readonly logger = new Logger(GivingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLoggingService,
    @Inject(PAYMENT_GATEWAY_REGISTRY)
    private readonly gatewayRegistry: Map<string, PaymentGatewayProvider>,
    private readonly receipt: ReceiptService,
    private readonly notifications: NotificationsService,
    private readonly branchScope: BranchScopeService,
    private readonly integrationAlert: IntegrationAlertService,
    private readonly paymentAccounts: PaymentAccountsService,
    private readonly config: ConfigService = new ConfigService(),
  ) {}

  /**
   * Gets the gateway selected by this church. Unconfigured churches cannot charge.
   */
  private async getDefaultGateway(churchId: string): Promise<string> {
    const configured = await this.paymentAccounts.defaultGateway(churchId);
    if (!configured) throw new BadRequestException('Configure a church payment account first');
    return configured;
  }

  private async churchPayment(churchId: string, gatewayName: string) {
    return this.paymentAccounts.current(churchId, gatewayName);
  }

  async paymentOptions(churchId: string) {
    try {
      const payment = await this.churchPayment(churchId, 'paystack');
      return {
        recurringAvailable: payment.provider.isConfigured(),
      };
    } catch {
      return { recurringAvailable: false };
    }
  }

  private categoryName(value: string): string {
    const name = value.trim();
    if (!name) throw new BadRequestException('Category name is required');
    return name;
  }

  private async categoryWrite<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (error) {
      // The database also enforces uniqueness for simultaneous requests.
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'A giving category with this name already exists in this church',
        );
      }
      throw error;
    }
  }

  // ─── CATEGORY CRUD ────────────────────────────────────────────────

  /**
   * Creates a new giving category.
   */
  async createCategory(
    dto: CreateCategoryDto,
    churchId: string,
    userId: string,
    _viewer?: ViewerScope | null,
  ): Promise<CategoryResponseDto> {
    // Categories belong to the church, regardless of the creator’s branch.
    const name = this.categoryName(dto.name);
    const existing = await this.prisma.givingCategory.findFirst({
      where: { church_id: churchId, name: { equals: name, mode: 'insensitive' } },
    });

    if (existing) {
      throw new ConflictException(`Category "${dto.name}" already exists`);
    }

    const category = await this.categoryWrite(() =>
      this.prisma.givingCategory.create({
        data: {
          church_id: churchId,
          branch_id: null,
          name,
          description: dto.description,
          display_order: dto.displayOrder ?? 0,
          is_recurring: dto.isRecurring ?? false,
          is_active: dto.isActive ?? true,
        },
      }),
    );

    await this.audit.log({
      userId,
      churchId,
      entity: 'giving_category',
      action: 'CREATE',
      entityId: category.id,
      newValues: { name: dto.name },
    });

    this.logger.log(`Giving category created: ${category.id} (${dto.name})`);
    return this.mapCategoryToDto(category);
  }

  /**
   * Lists giving categories for a church, ordered by display order.
   * Pagination engages only when a page size is requested; bare calls
   * keep returning every category (legacy consumers rely on that).
   */
  async listCategories(
    churchId: string,
    isActive?: boolean,
    page?: number,
    limit?: number,
    archived?: boolean,
    _branchId?: string,
    _viewer?: ViewerScope | null,
  ): Promise<{ data: CategoryResponseDto[]; total: number }> {
    const where: Prisma.GivingCategoryWhereInput = {
      church_id: churchId,
      archived_at: archived === true ? { not: null } : null,
    };
    if (isActive !== undefined) {
      where.is_active = isActive;
    }

    const categories = await this.prisma.givingCategory.findMany({
      where,
      orderBy: [{ display_order: 'asc' }, { name: 'asc' }],
      ...(limit ? { skip: ((page || 1) - 1) * limit, take: limit } : {}),
    });
    const total = await this.prisma.givingCategory.count({ where });

    return { data: categories.map((c) => this.mapCategoryToDto(c)), total };
  }

  /**
   * Gets a single giving category by ID.
   */
  async getCategoryById(categoryId: string, churchId: string): Promise<CategoryResponseDto> {
    const category = await this.prisma.givingCategory.findUnique({
      where: { id: categoryId },
    });

    if (!category || category.church_id !== churchId) {
      throw new NotFoundException('Giving category not found');
    }

    return this.mapCategoryToDto(category);
  }

  /**
   * Updates a giving category.
   */
  async updateCategory(
    categoryId: string,
    dto: UpdateCategoryDto,
    churchId: string,
    userId: string,
  ): Promise<CategoryResponseDto> {
    const existing = await this.prisma.givingCategory.findUnique({
      where: { id: categoryId },
    });

    if (!existing || existing.church_id !== churchId) {
      throw new NotFoundException('Giving category not found');
    }

    if (existing.archived_at) {
      throw new NotFoundException('Giving category is archived');
    }

    const name = dto.name === undefined ? undefined : this.categoryName(dto.name);
    // Archived categories also reserve their names, so restoration stays unambiguous.
    if (name !== undefined && name !== existing.name) {
      const duplicate = await this.prisma.givingCategory.findFirst({
        where: {
          church_id: churchId,
          name: { equals: name, mode: 'insensitive' },
          id: { not: categoryId },
        },
      });
      if (duplicate) {
        throw new ConflictException(`Category "${dto.name}" already exists`);
      }
    }

    const updateData: Record<string, unknown> = {};
    if (name !== undefined) updateData.name = name;
    if (dto.description !== undefined) updateData.description = dto.description;
    if (dto.displayOrder !== undefined) updateData.display_order = dto.displayOrder;
    if (dto.isRecurring !== undefined) updateData.is_recurring = dto.isRecurring;
    if (dto.isActive !== undefined) updateData.is_active = dto.isActive;

    if (Object.keys(updateData).length === 0) {
      return this.mapCategoryToDto(existing);
    }

    const updated = await this.categoryWrite(() =>
      this.prisma.givingCategory.update({
        where: { id: categoryId },
        data: updateData,
      }),
    );

    await this.audit.log({
      userId,
      churchId,
      entity: 'giving_category',
      action: 'UPDATE',
      entityId: categoryId,
      newValues: updateData,
    });

    return this.mapCategoryToDto(updated);
  }

  /**
   * Soft-deletes a giving category (sets isActive to false).
   */
  async deleteCategory(categoryId: string, churchId: string, userId: string): Promise<void> {
    const existing = await this.prisma.givingCategory.findUnique({
      where: { id: categoryId },
    });

    if (!existing || existing.church_id !== churchId) {
      throw new NotFoundException('Giving category not found');
    }

    await this.prisma.givingCategory.update({
      where: { id: categoryId },
      data: { is_active: false },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'giving_category',
      action: 'DELETE',
      entityId: categoryId,
      oldValues: { isActive: existing.is_active },
      newValues: { isActive: false },
    });

    this.logger.log(`Giving category deactivated: ${categoryId}`);
  }

  /**
   * Archives a giving category by setting archived_at. Archived categories drop
   * out of active lists (listCategories filters archived_at: null). Their names
   * stay reserved and their details stay
   * reachable by ID and they can be restored.
   *
   * @param categoryId - Category UUID
   * @param churchId - Church UUID for tenant scoping
   * @param userId - Acting user ID for audit logging
   * @returns Updated CategoryResponseDto
   * @throws NotFoundException if the category is missing or not in this church
   * @throws ConflictException if the category is already archived
   */
  async archiveCategory(
    categoryId: string,
    churchId: string,
    userId: string,
  ): Promise<CategoryResponseDto> {
    const existing = await this.prisma.givingCategory.findUnique({
      where: { id: categoryId },
    });

    if (!existing || existing.church_id !== churchId) {
      throw new NotFoundException('Giving category not found');
    }

    if (existing.archived_at) {
      throw new ConflictException('Giving category is already archived');
    }

    const updated = await this.prisma.givingCategory.update({
      where: { id: categoryId },
      data: { archived_at: new Date() },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'giving_category',
      action: 'ARCHIVE',
      entityId: categoryId,
      oldValues: { archived_at: existing.archived_at },
      newValues: { archived_at: updated.archived_at },
    });

    this.logger.log(`Giving category archived: ${categoryId}`);
    return this.mapCategoryToDto(updated);
  }

  /**
   * Restores an archived giving category by clearing archived_at.
   *
   * @param categoryId - Category UUID
   * @param churchId - Church UUID for tenant scoping
   * @param userId - Acting user ID for audit logging
   * @returns Updated CategoryResponseDto
   * @throws NotFoundException if the category is missing or not in this church
   * @throws ConflictException if the category is not currently archived
   */
  async restoreCategory(
    categoryId: string,
    churchId: string,
    userId: string,
  ): Promise<CategoryResponseDto> {
    const existing = await this.prisma.givingCategory.findUnique({
      where: { id: categoryId },
    });

    if (!existing || existing.church_id !== churchId) {
      throw new NotFoundException('Giving category not found');
    }

    if (!existing.archived_at) {
      throw new ConflictException('Giving category is not archived');
    }

    const updated = await this.prisma.givingCategory.update({
      where: { id: categoryId },
      data: { archived_at: null },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'giving_category',
      action: 'RESTORE',
      entityId: categoryId,
      oldValues: { archived_at: existing.archived_at },
      newValues: { archived_at: null },
    });

    this.logger.log(`Giving category restored: ${categoryId}`);
    return this.mapCategoryToDto(updated);
  }

  // ─── DIGITAL GIVING ──────────────────────────────────────────────

  /**
   * Initializes a digital payment via the configured gateway.
   *
   * Creates a pending transaction and returns an authorization URL.
   * Gateway is determined by DTO parameter or church config default.
   */
  async initializePayment(
    dto: InitializePaymentDto,
    churchId: string,
    userId: string,
  ): Promise<{
    authorizationUrl: string;
    reference: string;
    transactionId: string;
    gateway: string;
  }> {
    // Resolve which gateway to use
    const gatewayName = dto.gateway || (await this.getDefaultGateway(churchId));
    const paymentAccount = await this.churchPayment(churchId, gatewayName);
    const provider = paymentAccount.provider;

    // Verify category exists
    const category = await this.prisma.givingCategory.findUnique({
      where: { id: dto.categoryId },
    });

    if (!category || category.church_id !== churchId) {
      throw new NotFoundException('Giving category not found');
    }

    if (!category.is_active) {
      throw new BadRequestException('This giving category is no longer active');
    }

    // Verify member belongs to this church if provided
    if (dto.memberId) {
      const member = await this.prisma.member.findFirst({
        where: { id: dto.memberId, church_id: churchId },
        select: { id: true },
      });

      if (!member) {
        throw new NotFoundException('Member not found in this church');
      }
    }

    // Generate unique reference
    const reference = this.generatePaymentReference(category.name);

    // Create pending transaction
    const transaction = await this.prisma.transaction.create({
      data: {
        church_id: churchId,
        branch_id: dto.branchId,
        member_id: dto.memberId,
        category_id: dto.categoryId,
        amount: dto.amount,
        currency: 'NGN',
        type: 'digital',
        status: 'pending',
        payment_reference: reference,
        payment_gateway: gatewayName as 'paystack' | 'flutterwave',
        notes: dto.notes,
        ...(paymentAccount ? { integration_account_id: paymentAccount.accountId } : {}),
        metadata: { payerEmail: dto.email },
      },
    });

    // Initialize payment with the resolved gateway. If the gateway is
    // unreachable/fails, mark the just-created pending transaction as failed
    // (so no orphaned "pending" records accumulate) and notify admins, then
    // rethrow a clean error to the payer.
    const metadata = {
      transaction_id: transaction.id,
      church_id: churchId,
      category_id: dto.categoryId,
    };

    let result: Awaited<ReturnType<PaymentGatewayProvider['initializeTransaction']>>;
    try {
      result = await provider.initializeTransaction(dto.email, dto.amount, reference, metadata);
    } catch (err) {
      await this.prisma.transaction
        .update({
          where: { id: transaction.id },
          data: { status: 'failed' },
        })
        .catch((updateErr) =>
          this.logger.warn(
            `Failed to mark pending transaction ${transaction.id} failed: ${this.msg(updateErr)}`,
          ),
        );

      await this.integrationAlert
        .notify(
          churchId,
          gatewayName,
          `${this.capitalize(gatewayName)} payment init failed`,
          `Could not initialize payment (${reference}) for NGN ${dto.amount}. ${this.msg(err)}`,
          { reference, amount: dto.amount, gateway: gatewayName },
        )
        .catch(() => undefined);

      if (err instanceof BadRequestException || err instanceof ConflictException) throw err;
      if (err instanceof ServiceUnavailableException) throw err;
      this.logger.error(`Payment init error (${gatewayName}): ${this.msg(err)}`);
      throw new ServiceUnavailableException(
        'Payment gateway is temporarily unavailable. Please try again.',
      );
    }

    await this.audit.log({
      userId,
      churchId,
      entity: 'transaction',
      action: 'CREATE',
      entityId: transaction.id,
      newValues: {
        amount: dto.amount,
        categoryId: dto.categoryId,
        reference,
        gateway: gatewayName,
      },
    });

    this.logger.log(`Payment initialized: ${reference} for NGN ${dto.amount} via ${gatewayName}`);

    return {
      authorizationUrl: result.authorizationUrl,
      reference: result.reference,
      transactionId: transaction.id,
      gateway: gatewayName,
    };
  }

  private capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  private msg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  /**
   * Verifies a payment by reference.
   *
   * Routes to the correct gateway provider based on the transaction's
   * payment_gateway field.
   */
  async verifyPayment(reference: string, churchId: string): Promise<TransactionResponseDto> {
    const transaction = await this.prisma.transaction.findFirst({
      where: { payment_reference: reference, church_id: churchId },
      include: { category: true },
    });

    if (!transaction) {
      throw new NotFoundException('Transaction not found');
    }

    await this.reconcilePayment(churchId, reference);
    const updated = await this.prisma.transaction.findFirstOrThrow({
      where: { payment_reference: reference, church_id: churchId },
      include: { category: true },
    });
    return this.mapTransactionToDto(updated);
  }

  /** Browser, webhook and worker share the same verified, locked settlement path. */
  async reconcilePayment(churchId: string, reference: string): Promise<void> {
    const payment = await this.prisma.transaction.findFirst({
      where: { payment_reference: reference, church_id: churchId },
      include: { category: true },
    });
    if (!payment || payment.payment_gateway === 'manual') return;
    const provider = await this.paymentAccounts.historical(
      churchId,
      payment.payment_gateway,
      payment.integration_account_id,
    );
    const verified = await provider.verifyTransaction(reference);
    this.assertPaymentDetails(verified, payment);
    if (verified.status === 'reversed') {
      await this.adjustPayment(churchId, payment.id, {
        id: `charge/${reference}`,
        kind: 'reversal',
        state: 'completed',
        amount: payment.amount,
        currency: payment.currency,
      });
      return;
    }
    if (verified.status === 'pending') return;
    const receiptNumber =
      verified.status === 'success' && !payment.receipt_number
        ? await this.generateReceiptNumber(payment.category?.name ?? '', churchId)
        : payment.receipt_number;
    const changed = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM churches WHERE id = ${churchId} FOR UPDATE`;
      const current = await tx.transaction.findFirstOrThrow({
        where: { id: payment.id, church_id: churchId },
      });
      const access = record(current.lifecycle).access;
      if (current.status === 'reversed' || access === 'revoked' || access === 'review') {
        await tx.transaction.updateMany({
          where: { id: payment.id, church_id: churchId },
          data: {
            provider_transaction_id: verified.providerTransactionId,
            provider_reference: verified.providerReference,
            ...(verified.status === 'success'
              ? {
                  lifecycle: {
                    ...record(current.lifecycle),
                    chargeStatus: 'success',
                  } as Prisma.InputJsonValue,
                }
              : {}),
          },
        });
        return;
      }
      // An old failure cannot overwrite a settled charge. Failed attempts can recover.
      if (current.status === 'success' && verified.status !== 'success') return;
      await tx.transaction.updateMany({
        where: { id: payment.id, church_id: churchId },
        data: {
          status: verified.status === 'success' ? 'success' : 'failed',
          provider_transaction_id: verified.providerTransactionId,
          provider_reference: verified.providerReference,
          ...(verified.status === 'success'
            ? {
                receipt_number: current.receipt_number ?? receiptNumber,
                payment_method: provider.mapChannelToPaymentMethod(verified.channel),
              }
            : {}),
        },
      });
      if (verified.status === 'success')
        await this.settleTicket(tx, churchId, reference, payment.id, payment.amount);
      return current.status !== verified.status;
    });
    if (changed) {
      await this.audit.log({
        userId: 'payment-reconciliation',
        churchId,
        entity: 'transaction',
        action: 'UPDATE',
        entityId: payment.id,
        oldValues: { status: payment.status },
        newValues: { status: verified.status },
      });
      if (verified.status === 'success' && payment.member_id) {
        const profile = await this.prisma.profile.findFirst({
          where: { church_id: churchId, member_id: payment.member_id },
        });
        if (profile)
          await this.notifications
            .createNotification(
              churchId,
              profile.id,
              'giving',
              'Giving Confirmed',
              `Your ${payment.category?.name ?? 'Offering'} of ${payment.currency} ${payment.amount.toLocaleString()} has been received. Receipt: ${receiptNumber ?? ''}`,
              { transactionId: payment.id, receiptNumber },
            )
            .catch(() => this.logger.warn('Payment notification could not be delivered'));
      }
    }
  }

  private assertPaymentDetails(
    verified: PaymentVerifyResult,
    payment: { payment_reference: string | null; amount: number; currency: string },
  ) {
    if (
      verified.reference !== payment.payment_reference ||
      verified.currency !== payment.currency ||
      !Number.isFinite(verified.amount) ||
      verified.amount !== payment.amount
    )
      throw new BadRequestException('Payment amount, currency or reference does not match');
  }

  private async settleTicket(
    tx: Prisma.TransactionClient,
    churchId: string,
    reference: string,
    transactionId: string,
    amount: number,
  ) {
    const registration = await tx.eventRegistration.findFirst({
      where: { church_id: churchId, payment_reference: reference },
    });
    if (!registration || registration.payment_status === 'refunded') return;
    const tier = registration.tier_id
      ? await tx.eventTicketTier.findFirst({
          where: { id: registration.tier_id, event: { church_id: churchId } },
        })
      : null;
    // The unique registration key makes browser callbacks and webhook retries converge.
    const existing = await tx.ticket.findFirst({
      where: { registration_id: registration.id, event: { church_id: churchId } },
    });
    if (existing && ['cancelled', 'refunded'].includes(existing.status)) return;
    await tx.eventRegistration.updateMany({
      where: { id: registration.id, church_id: churchId },
      data: { payment_status: 'paid' },
    });
    const ticket = await tx.ticket.upsert({
      where: { registration_id: registration.id },
      create: {
        event_id: registration.event_id,
        registration_id: registration.id,
        member_id: registration.member_id,
        code: `TKT-${randomBytes(12).toString('hex').toUpperCase()}`,
        status: 'paid',
        tier_name: tier?.name ?? 'General',
        price_paid: amount,
        transaction_id: transactionId,
        payment_reference: reference,
      },
      update: { status: 'paid' },
    });
    await tx.eventRegistration.updateMany({
      where: { id: registration.id, church_id: churchId },
      data: { payment_status: 'paid', ticket_id: ticket.id },
    });
  }

  async reconcileAdjustments(churchId: string, reference: string) {
    const payment = await this.prisma.transaction.findFirst({
      where: { church_id: churchId, payment_reference: reference },
    });
    if (!payment?.provider_transaction_id) return;
    const provider = await this.paymentAccounts.historical(
      churchId,
      payment.payment_gateway,
      payment.integration_account_id,
    );
    const adjustments = await provider.listAdjustments?.({
      reference,
      providerTransactionId: payment.provider_transaction_id,
      providerReference: payment.provider_reference,
      currency: payment.currency,
      createdAt: payment.created_at,
    });
    for (const adjustment of adjustments ?? [])
      await this.adjustPayment(churchId, payment.id, adjustment);
  }

  private async adjustPayment(churchId: string, id: string, adjustment: PaymentAdjustment) {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM churches WHERE id = ${churchId} FOR UPDATE`;
      const payment = await tx.transaction.findFirstOrThrow({ where: { id, church_id: churchId } });
      const lifecycle = applyAdjustment(
        {
          ...record(payment.lifecycle),
          chargeStatus: record(payment.lifecycle).chargeStatus ?? payment.status,
        },
        adjustment,
        payment.amount,
        payment.currency,
      );
      const prior = record(payment.lifecycle);
      const heldTickets = Array.isArray(prior.heldTicketIds)
        ? prior.heldTicketIds.filter((item): item is string => typeof item === 'string')
        : [];
      if (lifecycle.access !== 'clear') {
        const tickets = await tx.ticket.findMany({
          where: { transaction_id: id, event: { church_id: churchId }, status: 'paid' },
          select: { id: true },
        });
        heldTickets.push(...tickets.map((item) => item.id));
      }
      const savedLifecycle = { ...lifecycle, heldTicketIds: [...new Set(heldTickets)] };
      // Held/refunded gifts stay out of successful-giving totals; the original amount is immutable.
      const status = lifecycle.financialReversal
        ? 'reversed'
        : lifecycle.access === 'review'
          ? 'pending'
          : lifecycle.chargeStatus === 'success'
            ? 'success'
            : lifecycle.chargeStatus === 'pending' || lifecycle.chargeStatus === 'failed'
              ? lifecycle.chargeStatus
              : payment.status;
      await tx.transaction.updateMany({
        where: { id, church_id: churchId },
        data: { lifecycle: savedLifecycle as unknown as Prisma.InputJsonValue, status },
      });
      if (lifecycle.access !== 'clear') {
        await tx.eventRegistration.updateMany({
          where: { church_id: churchId, transaction_id: id },
          data: { payment_status: lifecycle.access === 'revoked' ? 'refunded' : 'pending' },
        });
        await tx.ticket.updateMany({
          where: {
            transaction_id: id,
            event: { church_id: churchId },
            status: { in: ['paid', 'reserved'] },
          },
          data: { status: lifecycle.access === 'revoked' ? 'refunded' : 'reserved' },
        });
      } else if (status === 'success' && payment.payment_reference) {
        if (heldTickets.length) {
          await tx.ticket.updateMany({
            where: {
              id: { in: heldTickets },
              transaction_id: id,
              event: { church_id: churchId },
              status: { in: ['reserved', 'refunded'] },
            },
            data: { status: 'paid' },
          });
          await tx.eventRegistration.updateMany({
            where: { church_id: churchId, transaction_id: id, ticket_id: { in: heldTickets } },
            data: { payment_status: 'paid' },
          });
        }
        await this.settleTicket(tx, churchId, payment.payment_reference, id, payment.amount);
      }
    });
  }

  async handleWebhook(
    payload: string,
    signature: string,
    gatewayName: string,
  ): Promise<{ processed: boolean; event?: string; reference?: string }> {
    const parser = this.gatewayRegistry.get(gatewayName);
    if (!parser) throw new BadRequestException('Unknown payment gateway');
    const event = parser.parseWebhookEvent(payload);
    const identity = event.reference
      ? { payment_reference: event.reference }
      : event.providerTransactionId
        ? { provider_transaction_id: event.providerTransactionId }
        : event.providerReference
          ? { provider_reference: event.providerReference }
          : null;
    if (!identity) return { processed: false, event: event.event };
    const candidates = await this.prisma.transaction.findMany({
      where: {
        payment_gateway: gatewayName as 'paystack' | 'flutterwave',
        ...identity,
      },
      take: 20,
    });
    // Provider identifiers are merchant-scoped. Authenticate against the stored historical account.
    const matches = [];
    for (const candidate of candidates) {
      const signer = await this.paymentAccounts.historical(
        candidate.church_id,
        gatewayName,
        candidate.integration_account_id,
      );
      if (signer.validateWebhookSignature(payload, signature)) matches.push(candidate);
    }
    if (matches.length !== 1) {
      if (!candidates.length && !event.adjustment) return { processed: false, event: event.event };
      throw new BadRequestException('Payment callback could not be securely matched');
    }
    const payment = matches[0];
    if (event.adjustment) await this.adjustPayment(payment.church_id, payment.id, event.adjustment);
    else if (event.event.startsWith('charge.')) {
      await this.reconcilePayment(payment.church_id, payment.payment_reference!);
      if (event.event === 'charge.success' && event.authorizationCode && payment.member_id) {
        const settled = await this.prisma.transaction.findFirst({
          where: { id: payment.id, church_id: payment.church_id, status: 'success' },
        });
        if (settled)
          await this.captureAuthorizationCode(
            payment.church_id,
            payment.member_id,
            payment.category_id,
            event.authorizationCode,
            payment.integration_account_id,
          );
      }
    } else return { processed: false, event: event.event };
    return {
      processed: true,
      event: event.event,
      reference: payment.payment_reference ?? undefined,
    };
  }

  // ─── CASH/BANK GIVING ────────────────────────────────────────────

  /**
   * Records a cash or bank transfer giving transaction.
   *
   * Uses the 'manual' gateway since no external payment API is involved.
   */
  private async getGivingCellGroup(groupId: string, churchId: string, viewer?: ViewerScope | null) {
    const scope = this.branchScope.resolveCellGroupScope(viewer);
    const group = await this.prisma.cellGroup.findFirst({
      where: {
        id: groupId,
        church_id: churchId,
        ...(viewer && !viewer.is_admin_hq ? { branch_id: viewer.branch_id ?? '' } : {}),
        ...(!scope.churchOnly && 'leaderId' in scope ? { leader_id: scope.leaderId ?? '' } : {}),
        ...(!scope.churchOnly && scope.branchId ? { branch_id: scope.branchId } : {}),
      },
      select: { id: true, name: true, branch_id: true, archived_at: true, leader_id: true },
    });
    if (!group) throw new NotFoundException('Cell group not found');
    return group;
  }

  async getCellGroupGiving(
    groupId: string,
    churchId: string,
    query: ListTransactionsDto,
    viewer?: ViewerScope | null,
  ) {
    const group = await this.getGivingCellGroup(groupId, churchId, viewer);
    const filters = { ...query, cellGroupId: group.id, branchId: group.branch_id ?? undefined };
    const transactions = await this.listTransactions(churchId, filters, viewer);
    const summary = await this.getTransactionsSummary(
      churchId,
      { cellGroupId: group.id, branchId: group.branch_id ?? undefined },
      viewer,
    );
    const categories = await this.listCategories(
      churchId,
      true,
      1,
      100,
      false,
      group.branch_id ?? undefined,
      viewer,
    );
    return { ...transactions, summary, categories: categories.data };
  }

  private assertGroupGivingOwnership(
    group: { leader_id: string | null },
    viewer?: ViewerScope | null,
  ) {
    const ownOnly =
      (viewer?.permissions?.includes('cell_groups:own:read') ||
        viewer?.permissions?.includes('cell_groups:own:update')) &&
      !viewer.permissions.includes('cell_groups:delete');
    if (ownOnly && (!viewer?.member_id || group.leader_id !== viewer.member_id))
      throw new ForbiddenException('You can only record giving for the cell groups you lead');
  }

  async recordCellGroupGiving(
    groupId: string,
    dto: RecordCashDto,
    churchId: string,
    userId: string,
    viewer?: ViewerScope | null,
  ) {
    const group = await this.getGivingCellGroup(groupId, churchId, viewer);
    this.assertGroupGivingOwnership(group, viewer);
    if (group.archived_at)
      throw new BadRequestException('Cannot record giving for an archived cell group');
    // Cell group recording is a group total, without privileged member/service/event assignment.
    if (dto.memberId || dto.serviceId || dto.eventId)
      throw new BadRequestException('Record a group total without another entity assignment');
    return this.recordCashGiving({ ...dto, cellGroupId: group.id }, churchId, userId, viewer);
  }

  async recordCashGiving(
    dto: RecordCashDto,
    churchId: string,
    userId: string,
    viewer?: ViewerScope | null,
  ): Promise<TransactionResponseDto> {
    let cellGroup:
      | {
          id: string;
          name: string;
          branch_id: string | null;
          archived_at: Date | null;
          leader_id: string | null;
        }
      | undefined;
    if (dto.cellGroupId) {
      if (!viewer?.permissions?.includes('cell_groups:giving:create'))
        throw new ForbiddenException('Cell group giving recording is not permitted');
      if (dto.memberId || dto.serviceId || dto.eventId)
        throw new BadRequestException('Record a group total without another entity assignment');
      cellGroup = await this.getGivingCellGroup(dto.cellGroupId, churchId, viewer);
      this.assertGroupGivingOwnership(cellGroup, viewer);
      if (cellGroup.archived_at)
        throw new BadRequestException('Cannot record giving for an archived cell group');
      const meetingDate = dto.cellGroupMeetingDate;
      if (
        !meetingDate ||
        !/^\d{4}-\d{2}-\d{2}$/.test(meetingDate) ||
        Number.isNaN(Date.parse(meetingDate)) ||
        new Date(meetingDate).toISOString().slice(0, 10) !== meetingDate
      )
        throw new BadRequestException('A valid meeting date is required for group giving');

      if (!cellGroup.branch_id)
        throw new BadRequestException('Assign a branch to the cell group first');
      if (dto.branchId && dto.branchId !== cellGroup.branch_id)
        throw new BadRequestException('Giving must use the cell group branch');
      dto.branchId = cellGroup.branch_id;
    }
    const givingDate = parseGivingDate(
      dto.givingDate ?? dto.cellGroupMeetingDate ?? new Date().toISOString().slice(0, 10),
    );
    const scope = this.branchScope.resolve(viewer);
    if (!scope.churchOnly) {
      if (dto.branchId && dto.branchId !== scope.branchId)
        throw new BadRequestException('Giving must be recorded in your branch');
      dto.branchId = scope.branchId;
    }
    if (viewer && !dto.branchId) throw new BadRequestException('Select a branch for the giving');
    if (dto.branchId) {
      const branch = await this.prisma.branch.findFirst({
        where: { id: dto.branchId, church_id: churchId },
        select: { id: true },
      });
      if (!branch) throw new NotFoundException('Branch not found in this church');
    }
    // Verify category exists
    const category = await this.prisma.givingCategory.findUnique({
      where: { id: dto.categoryId },
    });

    if (!category || category.church_id !== churchId) {
      throw new NotFoundException('Giving category not found');
    }

    if (!category.is_active) {
      throw new BadRequestException('This giving category is no longer active');
    }

    // Verify member belongs to this church if provided
    if (dto.memberId) {
      const member = await this.prisma.member.findFirst({
        where: { id: dto.memberId, church_id: churchId },
        select: { id: true, branch_id: true },
      });

      if (!member) {
        throw new NotFoundException('Member not found in this church');
      }
      if (dto.branchId && member.branch_id !== dto.branchId)
        throw new BadRequestException('Member belongs to another branch');
    }

    // Verify the linked service belongs to this church if provided
    if (dto.serviceId) {
      const service = await this.prisma.service.findFirst({
        where: { id: dto.serviceId, church_id: churchId },
        select: { id: true, branch_id: true },
      });

      if (!service) {
        throw new NotFoundException('Service not found in this church');
      }
      if (dto.branchId && service.branch_id && service.branch_id !== dto.branchId)
        throw new BadRequestException('Service belongs to another branch');
    }

    // Verify the linked event belongs to this church if provided
    if (dto.eventId) {
      const event = await this.prisma.event.findFirst({
        where: { id: dto.eventId, church_id: churchId },
        select: { id: true, branch_id: true },
      });

      if (!event) {
        throw new NotFoundException('Event not found in this church');
      }
      if (dto.branchId && event.branch_id && event.branch_id !== dto.branchId)
        throw new BadRequestException('Event belongs to another branch');
    }

    // Generate receipt number
    const receiptNumber = await this.generateReceiptNumber(category.name, churchId);

    // Create transaction
    const transaction = await this.prisma.transaction
      .create({
        data: {
          church_id: churchId,
          branch_id: dto.branchId,
          member_id: dto.memberId,
          category_id: dto.categoryId,
          service_id: dto.serviceId,
          event_id: dto.eventId,
          giving_date: givingDate,
          amount: dto.amount,
          currency: dto.currency || 'NGN',
          type: dto.type,
          payment_method: dto.type,
          status: 'success', // Cash/bank is immediately confirmed
          payment_gateway: 'manual',
          receipt_number: receiptNumber,
          ...(cellGroup
            ? {
                metadata: {
                  cellGroupId: cellGroup.id,
                  cellGroupName: cellGroup.name,
                  cellGroupMeetingDate: dto.cellGroupMeetingDate!,
                },
              }
            : {}),
          notes: cellGroup
            ? `Combined giving from ${cellGroup.name} for the meeting on ${dto.cellGroupMeetingDate}.${dto.notes ? ` ${dto.notes}` : ''}`
            : dto.notes,
        },
        include: {
          category: true,
          member: { select: { first_name: true, last_name: true } },
          service: { select: { name: true } },
          event: { select: { title: true } },
          branch: { select: { name: true } },
        },
      })
      .catch((error: unknown) => {
        if (
          cellGroup &&
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'P2002'
        )
          throw new ConflictException(
            'Giving has already been recorded for this cell group meeting',
          );
        throw error;
      });

    await this.audit.log({
      userId,
      churchId,
      entity: 'transaction',
      action: 'CREATE',
      entityId: transaction.id,
      newValues: {
        amount: dto.amount,
        type: dto.type,
        categoryId: dto.categoryId,
        cellGroupId: dto.cellGroupId,
        givingDate: givingDate.toISOString().slice(0, 10),
      },
    });

    this.logger.log(`Cash giving recorded: ${receiptNumber} for NGN ${dto.amount}`);

    if (dto.memberId) {
      const memberProfile = await this.prisma.profile.findFirst({
        where: { member_id: dto.memberId, church_id: churchId },
      });
      if (memberProfile) {
        const categoryName = category.name ?? 'Offering';
        await this.notifications
          .createNotification(
            churchId,
            memberProfile.id,
            'giving',
            'Giving Recorded',
            `Your ${categoryName} of ${dto.currency || 'NGN'} ${dto.amount.toLocaleString()} has been recorded. Receipt: ${receiptNumber}`,
            { transactionId: transaction.id, receiptNumber },
          )
          .catch((err) => this.logger.warn(`Notification failed: ${(err as Error).message}`));
      }
    }

    return this.mapTransactionToDto(transaction);
  }

  // ─── TRANSACTION QUERIES ─────────────────────────────────────────

  /**
   * Builds the church-scoped Prisma where clause shared by transaction
   * list and summary queries (branch scope + all list filters).
   *
   * @param churchId - The church tenant scope
   * @param query - List/query DTO filters
   * @param viewer - Optional viewer for branch scoping
   * @param defaultStatus - Status to apply when the query omits one
   *   (used by the summary so totals always mean "successful" by default)
   * @returns A Prisma TransactionWhereInput
   */
  private buildTransactionWhere(
    churchId: string,
    query: ListTransactionsDto,
    viewer?: ViewerScope | null,
    defaultStatus?: string,
  ): Prisma.TransactionWhereInput {
    const where: Prisma.TransactionWhereInput = { church_id: churchId };
    if (query.cellGroupId) where.metadata = { path: ['cellGroupId'], equals: query.cellGroupId };

    // Branch-scope for non-HQ viewers (transactions carry an optional branch_id).
    const scope = this.branchScope.resolve(viewer);
    if (!scope.churchOnly && scope.branchId) {
      where.branch_id = scope.branchId;
    } else if (scope.churchOnly && query.branchId) {
      where.branch_id = query.branchId;
    }

    if (query.categoryId) where.category_id = query.categoryId;
    if (query.memberId) where.member_id = query.memberId;
    if (query.serviceId) where.service_id = query.serviceId;
    if (query.eventId) where.event_id = query.eventId;
    if (query.status) {
      where.status = query.status as Prisma.EnumTransactionStatusFilter;
    } else if (defaultStatus) {
      where.status = defaultStatus as Prisma.EnumTransactionStatusFilter;
    }
    if (query.type) where.type = query.type as Prisma.EnumTransactionTypeFilter;
    if (query.gateway)
      where.payment_gateway = query.gateway as 'paystack' | 'flutterwave' | 'manual';

    if (query.startDate || query.endDate) {
      where.giving_date = {};
      if (query.startDate) where.giving_date.gte = new Date(query.startDate);
      if (query.endDate) where.giving_date.lte = new Date(query.endDate + 'T23:59:59.999Z');
    }

    return where;
  }

  /**
   * Lists transactions with pagination and filters.
   */
  async listTransactions(
    churchId: string,
    query: ListTransactionsDto,
    viewer?: ViewerScope | null,
  ): Promise<{ data: TransactionResponseDto[]; total: number }> {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    const where = this.buildTransactionWhere(churchId, query, viewer);

    const orderBy: Prisma.TransactionOrderByWithRelationInput[] = [];
    if (query.sortBy) {
      orderBy.push({ [query.sortBy]: (query.sortOrder || 'desc') as Prisma.SortOrder });
    } else {
      orderBy.push({ giving_date: 'desc' }, { created_at: 'desc' });
    }

    // Stable ties prevent records sharing a giving date moving across export pages.
    if (query.sortBy !== 'created_at') orderBy.push({ created_at: 'desc' });
    orderBy.push({ id: 'desc' });

    const handleListError = (error: unknown): never => {
      const branchScope = this.branchScope.resolve(viewer);
      this.logger.error(
        `Failed to list giving transactions (church=${churchId}, branch=${branchScope.branchId ?? 'all'}, hq=${branchScope.churchOnly})`,
        error instanceof Error ? error.stack : String(error),
      );
      throw error;
    };

    const items = await this.prisma.transaction
      .findMany({
        where,
        orderBy,
        skip,
        take: limit,
        include: {
          category: true,
          member: { select: { first_name: true, last_name: true } },
          service: { select: { name: true } },
          event: { select: { title: true } },
          branch: { select: { name: true } },
        },
      })
      .catch(handleListError);
    const total = await this.prisma.transaction.count({ where }).catch(handleListError);

    return {
      data: items.map((t) => this.mapTransactionToDto(t)),
      total,
    };
  }

  /** Successful giving chart aggregates, with no donor selectors or records. */
  async getDashboardCharts(
    churchId: string,
    query: GivingDashboardChartsQueryDto,
    viewer?: ViewerScope | null,
  ): Promise<GivingDashboardChartsResponseDto> {
    const start = query.startDate ? new Date(query.startDate) : undefined;
    const end = query.endDate
      ? new Date(
          /^\d{4}-\d{2}-\d{2}$/.test(query.endDate)
            ? `${query.endDate}T23:59:59.999Z`
            : query.endDate,
        )
      : undefined;
    if (
      (start && !Number.isFinite(start.getTime())) ||
      (end && !Number.isFinite(end.getTime())) ||
      (start && end && start > end)
    ) {
      throw new BadRequestException('Choose a valid date range');
    }
    const currency = query.currency ?? 'NGN';
    const where = this.buildTransactionWhere(
      churchId,
      { branchId: query.branchId },
      viewer,
      'success',
    );
    where.currency = currency;
    if (start || end)
      where.giving_date = { ...(start ? { gte: start } : {}), ...(end ? { lte: end } : {}) };
    const rows = await this.prisma.transaction.findMany({
      where,
      select: { amount: true, giving_date: true, category_id: true },
      orderBy: { giving_date: 'asc' },
    });
    const categoryIds = [
      ...new Set(rows.flatMap((row) => (row.category_id ? [row.category_id] : []))),
    ];
    const categories = categoryIds.length
      ? await this.prisma.givingCategory.findMany({
          where: { church_id: churchId, id: { in: categoryIds } },
          select: { id: true, name: true },
        })
      : [];
    const categoryNames = new Map(categories.map((category) => [category.id, category.name]));
    const daily = new Map<string, number>();
    const byCategory = new Map<string | null, GivingDashboardCategoryDto>();
    let total = 0;
    for (const row of rows) {
      total += row.amount;
      const date = row.giving_date.toISOString().slice(0, 10);
      daily.set(date, (daily.get(date) ?? 0) + row.amount);
      const category = byCategory.get(row.category_id) ?? {
        categoryId: row.category_id,
        categoryName: (row.category_id && categoryNames.get(row.category_id)) || 'Uncategorized',
        total: 0,
        count: 0,
      };
      category.total += row.amount;
      category.count++;
      byCategory.set(row.category_id, category);
    }
    return {
      currency,
      total,
      count: rows.length,
      trend: [...daily.entries()].map(([date, amount]) => ({ date, total: amount })),
      byCategory: [...byCategory.values()].sort((a, b) => b.total - a.total),
    };
  }

  /**
   * Returns aggregated giving totals for the dashboard stat cards and
   * trend chart: month-to-date total, all-time total, transaction count,
   * and a 30-day daily trend. Defaults to successful transactions but
   * honors the same category/member/service/event/type/gateway filters as
   * listTransactions (an explicit `status` overrides the success default).
   */
  async getTransactionsSummary(
    churchId: string,
    query: ListTransactionsDto,
    viewer?: ViewerScope | null,
  ): Promise<TransactionSummaryResponseDto> {
    const now = new Date();

    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    const trendStart = new Date(now);
    trendStart.setUTCHours(0, 0, 0, 0);
    trendStart.setUTCDate(trendStart.getUTCDate() - 29);

    const trendEnd = new Date(now);
    trendEnd.setUTCHours(23, 59, 59, 999);

    const where = this.buildTransactionWhere(churchId, query, viewer, 'success');

    const [monthAgg, allTimeAgg, trendRows] = await Promise.all([
      this.prisma.transaction.aggregate({
        where: { ...where, giving_date: { gte: monthStart } },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.transaction.aggregate({
        where,
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.transaction.findMany({
        where: { ...where, giving_date: { gte: trendStart, lte: trendEnd } },
        select: { amount: true, giving_date: true },
        orderBy: { giving_date: 'asc' },
      }),
    ]);

    const dailyTotals = new Map<string, number>();
    for (let i = 0; i < 30; i++) {
      const day = new Date(trendStart);
      day.setUTCDate(day.getUTCDate() + i);
      dailyTotals.set(day.toISOString().slice(0, 10), 0);
    }
    for (const row of trendRows) {
      const key = new Date(row.giving_date).toISOString().slice(0, 10);
      dailyTotals.set(key, (dailyTotals.get(key) ?? 0) + row.amount);
    }

    const trend: GivingTrendPointDto[] = Array.from(dailyTotals, ([date, total]) => ({
      date,
      total,
    }));

    return {
      monthTotal: monthAgg._sum.amount ?? 0,
      monthCount: monthAgg._count?._all ?? 0,
      allTimeTotal: allTimeAgg._sum.amount ?? 0,
      count: allTimeAgg._count._all ?? 0,
      trend,
    };
  }

  /**
   * Gets a single transaction by ID.
   */
  async getTransactionById(
    transactionId: string,
    churchId: string,
    viewer?: ViewerScope | null,
  ): Promise<TransactionResponseDto> {
    const transaction = await this.prisma.transaction.findUnique({
      where: { id: transactionId },
      include: {
        category: true,
        member: { select: { first_name: true, last_name: true } },
        service: { select: { name: true } },
        event: { select: { title: true } },
      },
    });

    if (!transaction || transaction.church_id !== churchId) {
      throw new NotFoundException('Transaction not found');
    }

    if (!this.branchScope.isVisible(viewer, transaction.branch_id)) {
      throw new NotFoundException('Transaction not found');
    }

    return this.mapTransactionToDto(transaction);
  }

  // ─── RECURRING GIVING ───────────────────────────────────────────

  /**
   * Creates a recurring giving schedule.
   *
   * The category must have is_recurring enabled. The authorization code
   * is captured from the first successful payment via webhook.
   */
  async createRecurringGiving(
    dto: CreateRecurringGivingDto,
    churchId: string,
    userId: string,
    viewer?: ViewerScope | null,
  ): Promise<RecurringGivingResponseDto> {
    // Recurring schedules charge cards automatically, which needs an enabled
    // church payment account (Paystack is the only auto-charge provider).
    // Fail with guidance instead of the bare "not configured" gateway errors.
    const defaultProvider = await this.paymentAccounts.defaultGateway(churchId);
    if (!defaultProvider) {
      throw new BadRequestException(
        'Recurring gifts need automatic card charges, but this church has no payment provider yet. Add and enable a Paystack account under Settings → Integrations → Payments, then create the schedule.',
      );
    }
    if (defaultProvider !== 'paystack') {
      throw new BadRequestException(
        `Recurring gifts currently charge through Paystack, but this church pays through ${defaultProvider}. Add a Paystack account under Settings → Integrations → Payments before creating a schedule.`,
      );
    }
    await this.churchPayment(churchId, 'paystack');
    const category = await this.prisma.givingCategory.findUnique({
      where: { id: dto.categoryId },
    });

    if (!category || category.church_id !== churchId) {
      throw new NotFoundException('Giving category not found');
    }

    if (!category.is_active) {
      throw new BadRequestException('This giving category is no longer active');
    }

    if (!category.is_recurring) {
      throw new BadRequestException(
        'This category does not support recurring giving. Enable recurring in the category settings.',
      );
    }

    // Resolve the member this recurring giving belongs to
    let targetMemberId: string | null = dto.memberId ?? null;

    if (!targetMemberId) {
      const profile = await this.prisma.profile.findUnique({
        where: { user_id: userId },
        select: { member_id: true },
      });
      targetMemberId = profile?.member_id || null;
    }

    if (!targetMemberId) {
      throw new BadRequestException('memberId is required, or link a member to your profile first');
    }

    // Verify the member belongs to this church
    const member = await this.prisma.member.findFirst({
      where: { id: targetMemberId, church_id: churchId },
      select: { id: true, branch_id: true },
    });

    if (!member) {
      throw new NotFoundException('Member not found in this church');
    }

    const scope = this.branchScope.resolve(viewer);
    const branchId = scope.churchOnly ? dto.branchId : scope.branchId;
    if (branchId && member.branch_id !== branchId)
      throw new BadRequestException('Member belongs to another branch');

    // Check for existing active recurring giving for this member+category
    const existing = await this.prisma.recurringGiving.findFirst({
      where: {
        church_id: churchId,
        member_id: targetMemberId,
        category_id: dto.categoryId,
        is_active: true,
      },
    });

    if (existing) {
      throw new ConflictException(
        'An active recurring giving already exists for this member and category',
      );
    }

    const nextChargeDate = this.calculateNextChargeDate(dto.frequency);

    const recurring = await this.prisma.recurringGiving.create({
      data: {
        church_id: churchId,
        member_id: targetMemberId,
        category_id: dto.categoryId,
        amount: dto.amount,
        currency: 'NGN',
        frequency: dto.frequency,
        is_active: true,
        next_charge_date: nextChargeDate,
      },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'recurring_giving',
      action: 'CREATE',
      entityId: recurring.id,
      newValues: {
        categoryId: dto.categoryId,
        amount: dto.amount,
        frequency: dto.frequency,
      },
    });

    this.logger.log(`Recurring giving created: ${recurring.id} (${dto.frequency})`);

    return this.mapRecurringGivingToDto(recurring, category.name);
  }

  /**
   * Lists recurring giving schedules for a church.
   */
  async listRecurringGiving(
    churchId: string,
    query: ListRecurringGivingDto,
    viewer?: ViewerScope | null,
  ): Promise<{ data: RecurringGivingResponseDto[]; total: number }> {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    const where: Prisma.RecurringGivingWhereInput = { church_id: churchId };
    const scope = this.branchScope.resolve(viewer);
    if (!scope.churchOnly) {
      where.member = { is: { branch_id: scope.branchId || '' } };
    } else if (query.branchId) {
      where.member = { is: { branch_id: query.branchId } };
    }
    if (query.isActive !== undefined) {
      where.is_active = query.isActive;
    }

    const items = await this.prisma.recurringGiving.findMany({
      where,
      orderBy: { created_at: 'desc' },
      skip,
      take: limit,
      include: {
        member: { select: { first_name: true, last_name: true } },
      },
    });
    const total = await this.prisma.recurringGiving.count({ where });

    // Batch-fetch category names
    const categoryIds = [...new Set(items.map((r) => r.category_id))];
    const categories = await this.prisma.givingCategory.findMany({
      where: { id: { in: categoryIds } },
      select: { id: true, name: true },
    });
    const categoryMap = new Map(categories.map((c) => [c.id, c.name]));

    return {
      data: items.map((r) =>
        this.mapRecurringGivingToDto(
          r,
          categoryMap.get(r.category_id) || '',
          r.member ? `${r.member.first_name} ${r.member.last_name}` : undefined,
        ),
      ),
      total,
    };
  }

  /**
   * Gets a single recurring giving by ID.
   */
  private async assertRecurringBranch(
    memberId: string,
    churchId: string,
    viewer?: ViewerScope | null,
  ): Promise<void> {
    const scope = this.branchScope.resolve(viewer);
    if (scope.churchOnly) return;
    const member = await this.prisma.member.findFirst({
      where: { id: memberId, church_id: churchId, branch_id: scope.branchId },
      select: { id: true },
    });
    if (!member) throw new NotFoundException('Recurring giving not found');
  }

  async getRecurringGivingById(
    id: string,
    churchId: string,
    viewer?: ViewerScope | null,
  ): Promise<RecurringGivingResponseDto> {
    const recurring = await this.prisma.recurringGiving.findUnique({
      where: { id },
    });

    if (!recurring || recurring.church_id !== churchId) {
      throw new NotFoundException('Recurring giving not found');
    }
    await this.assertRecurringBranch(recurring.member_id, churchId, viewer);

    const category = await this.prisma.givingCategory.findUnique({
      where: { id: recurring.category_id },
      select: { name: true },
    });

    return this.mapRecurringGivingToDto(recurring, category?.name || '');
  }

  /**
   * Cancels a recurring giving schedule (soft-cancel).
   */
  async cancelRecurringGiving(
    id: string,
    churchId: string,
    userId: string,
    viewer?: ViewerScope | null,
  ): Promise<void> {
    const recurring = await this.prisma.recurringGiving.findUnique({
      where: { id },
    });

    if (!recurring || recurring.church_id !== churchId) {
      throw new NotFoundException('Recurring giving not found');
    }
    await this.assertRecurringBranch(recurring.member_id, churchId, viewer);

    if (!recurring.is_active && !recurring.paused_at) {
      throw new BadRequestException('Recurring giving is already cancelled');
    }

    await this.prisma.recurringGiving.update({
      where: { id },
      data: { is_active: false, paused_at: null },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'recurring_giving',
      action: 'UPDATE',
      entityId: id,
      oldValues: { isActive: recurring.is_active, pausedAt: recurring.paused_at },
      newValues: { isActive: false, pausedAt: null },
    });

    this.logger.log(`Recurring giving cancelled: ${id}`);
  }

  /**
   * Pauses a recurring giving schedule.
   *
   * Sets `is_active = false` and records `paused_at`. No further charges
   * until the schedule is resumed.
   *
   * @throws NotFoundException  Schedule not found or doesn't belong to the church.
   * @throws BadRequestException Schedule is already paused or cancelled.
   */
  async pauseRecurringGiving(
    id: string,
    churchId: string,
    userId: string,
    viewer?: ViewerScope | null,
  ): Promise<void> {
    const recurring = await this.prisma.recurringGiving.findUnique({
      where: { id },
    });

    if (!recurring || recurring.church_id !== churchId) {
      throw new NotFoundException('Recurring giving not found');
    }
    await this.assertRecurringBranch(recurring.member_id, churchId, viewer);

    if (!recurring.is_active) {
      throw new BadRequestException('Recurring giving is already paused or cancelled');
    }

    await this.prisma.recurringGiving.update({
      where: { id },
      data: {
        is_active: false,
        paused_at: new Date(),
      },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'recurring_giving',
      action: 'UPDATE',
      entityId: id,
      oldValues: { isActive: true, pausedAt: null },
      newValues: { isActive: false, pausedAt: new Date().toISOString() },
    });

    this.logger.log(`Recurring giving paused: ${id}`);
  }

  /**
   * Resumes a previously paused recurring giving schedule.
   *
   * Sets `is_active = true` and clears `paused_at`.
   *
   * @throws NotFoundException  Schedule not found or doesn't belong to the church.
   * @throws BadRequestException Schedule is not paused (active or fully cancelled).
   */
  async resumeRecurringGiving(
    id: string,
    churchId: string,
    userId: string,
    viewer?: ViewerScope | null,
  ): Promise<void> {
    const recurring = await this.prisma.recurringGiving.findUnique({
      where: { id },
    });

    if (!recurring || recurring.church_id !== churchId) {
      throw new NotFoundException('Recurring giving not found');
    }
    await this.assertRecurringBranch(recurring.member_id, churchId, viewer);

    if (recurring.is_active) {
      throw new BadRequestException('Recurring giving is not paused');
    }

    if (recurring.paused_at === null) {
      throw new BadRequestException(
        'Recurring giving is fully cancelled and cannot be resumed. Create a new schedule instead.',
      );
    }

    await this.prisma.recurringGiving.update({
      where: { id },
      data: {
        is_active: true,
        paused_at: null,
      },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'recurring_giving',
      action: 'UPDATE',
      entityId: id,
      oldValues: { isActive: false },
      newValues: { isActive: true, pausedAt: null },
    });

    this.logger.log(`Recurring giving resumed: ${id}`);
  }

  /**
   * Processes a recurring giving charge.
   *
   * Charges the member's saved authorization via the configured gateway,
   * creates a Transaction record, and updates the schedule.
   *
   * @returns Whether the charge was successful
   */
  async processRecurringCharge(recurringGivingId: string, churchId: string): Promise<boolean> {
    const recurring = await this.prisma.recurringGiving.findUnique({
      where: { id: recurringGivingId },
    });

    if (!recurring || recurring.church_id !== churchId) {
      this.logger.warn(`Recurring giving not found: ${recurringGivingId}`);
      return false;
    }

    if (!recurring.is_active) {
      this.logger.log(`Recurring giving ${recurringGivingId} is inactive, skipping`);
      return false;
    }

    if (!recurring.authorization_code) {
      this.logger.warn(`Recurring giving ${recurringGivingId} has no authorization code, skipping`);
      return false;
    }

    // Resolve gateway (default to paystack for recurring)
    let currentPayment: Awaited<ReturnType<PaymentAccountsService['current']>> | undefined;
    try {
      currentPayment = await this.churchPayment(churchId, 'paystack');
    } catch {
      this.logger.warn('Recurring charge skipped: Paystack is not enabled for this church');
      return false;
    }
    if (
      currentPayment &&
      (currentPayment.accountId ?? null) !== (recurring.integration_account_id ?? null)
    ) {
      this.logger.warn(
        'Recurring authorization needs renewed consent for the selected merchant account',
      );
      return false;
    }
    const provider = currentPayment?.provider;
    if (!provider || !provider.isConfigured() || !provider.chargeAuthorization) {
      this.logger.error('Paystack gateway not available for recurring charge');
      return false;
    }

    try {
      const result = await provider.chargeAuthorization(
        recurring.authorization_code,
        recurring.amount,
        recurring.currency,
        {
          recurring_giving_id: recurring.id,
          church_id: churchId,
          category_id: recurring.category_id,
        },
      );

      // Create transaction record
      const receiptNumber = await this.generateReceiptNumber('Recurring', churchId);

      await this.prisma.transaction.create({
        data: {
          church_id: churchId,
          member_id: recurring.member_id,
          category_id: recurring.category_id,
          amount: recurring.amount,
          currency: recurring.currency,
          type: 'digital',
          status: result.success ? 'success' : 'failed',
          payment_reference: result.reference,
          ...(currentPayment ? { integration_account_id: currentPayment.accountId } : {}),
          payment_gateway: 'paystack',
          payment_method: 'card',
          receipt_number: receiptNumber,
          metadata: {
            recurring_giving_id: recurring.id,
            is_recurring_charge: true,
          },
        },
      });

      // Update recurring schedule
      const nextChargeDate = this.calculateNextChargeDate(
        recurring.frequency as 'weekly' | 'monthly' | 'quarterly',
      );

      await this.prisma.recurringGiving.update({
        where: { id: recurringGivingId },
        data: {
          last_charge_date: new Date(),
          next_charge_date: result.success ? nextChargeDate : recurring.next_charge_date,
          failed_attempt_count: result.success ? 0 : recurring.failed_attempt_count + 1,
          is_active: result.success || recurring.failed_attempt_count + 1 < 3,
        },
      });

      await this.audit.log({
        userId: 'system',
        churchId,
        entity: 'recurring_giving',
        action: 'UPDATE',
        entityId: recurringGivingId,
        newValues: {
          chargeSuccess: result.success,
          reference: result.reference,
          nextChargeDate: result.success ? nextChargeDate : undefined,
        },
      });

      this.logger.log(
        `Recurring charge ${result.success ? 'succeeded' : 'failed'}: ${recurringGivingId} (${result.reference})`,
      );

      return result.success;
    } catch (error) {
      this.logger.error(
        `Recurring charge error for ${recurringGivingId}: ${error instanceof Error ? error.message : String(error)}`,
      );

      // Increment failed attempt count
      const newFailedCount = recurring.failed_attempt_count + 1;
      await this.prisma.recurringGiving.update({
        where: { id: recurringGivingId },
        data: {
          failed_attempt_count: newFailedCount,
          is_active: newFailedCount < 3,
        },
      });

      return false;
    }
  }

  /**
   * Calculates the next charge date based on frequency.
   */
  private calculateNextChargeDate(frequency: 'weekly' | 'monthly' | 'quarterly'): Date {
    const now = new Date();
    switch (frequency) {
      case 'weekly':
        now.setDate(now.getDate() + 7);
        break;
      case 'monthly':
        now.setMonth(now.getMonth() + 1);
        break;
      case 'quarterly':
        now.setMonth(now.getMonth() + 3);
        break;
    }
    return now;
  }

  /**
   * Maps a Prisma RecurringGiving to the response DTO.
   */
  private mapRecurringGivingToDto(
    recurring: {
      id: string;
      church_id: string;
      member_id: string;
      category_id: string;
      amount: number;
      currency: string;
      frequency: string;
      is_active: boolean;
      next_charge_date: Date | null;
      last_charge_date: Date | null;
      failed_attempt_count: number;
      created_at: Date;
      updated_at: Date;
    },
    categoryName: string,
    memberName?: string,
  ): RecurringGivingResponseDto {
    return {
      id: recurring.id,
      churchId: recurring.church_id,
      memberId: recurring.member_id,
      memberName,
      categoryId: recurring.category_id,
      categoryName,
      amount: recurring.amount,
      currency: recurring.currency,
      frequency: recurring.frequency,
      isActive: recurring.is_active,
      nextChargeDate: recurring.next_charge_date?.toISOString(),
      lastChargeDate: recurring.last_charge_date?.toISOString(),
      failedAttemptCount: recurring.failed_attempt_count,
      createdAt: recurring.created_at.toISOString(),
      updatedAt: recurring.updated_at.toISOString(),
    };
  }

  // ─── RECEIPTS ─────────────────────────────────────────────────────

  /**
   * Generates a PDF receipt for a transaction.
   */
  async generateReceipt(
    transactionId: string,
    churchId: string,
    viewer?: ViewerScope | null,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const transaction = await this.prisma.transaction.findUnique({
      where: { id: transactionId },
      include: { category: true, branch: true, service: true, event: true },
    });

    if (!transaction || transaction.church_id !== churchId) {
      throw new NotFoundException('Transaction not found');
    }

    if (!this.branchScope.isVisible(viewer, transaction.branch_id)) {
      throw new NotFoundException('Transaction not found');
    }

    if (transaction.status !== 'success') {
      throw new BadRequestException('Receipts can only be generated for successful transactions');
    }

    // Get church details
    const church = await this.prisma.church.findUnique({
      where: { id: churchId },
      select: { name: true, address: true, logo_url: true },
    });

    // Get member name if available
    let memberName: string | undefined;
    let memberEmail: string | undefined;
    if (transaction.member_id) {
      const member = await this.prisma.member.findUnique({
        where: { id: transaction.member_id, church_id: churchId },
        select: { first_name: true, last_name: true, email: true },
      });
      if (member) {
        memberName = `${member.first_name} ${member.last_name}`;
        memberEmail = member.email || undefined;
      }
    }

    const receiptData: ReceiptTransactionData = {
      id: transaction.id,
      receiptNumber: transaction.receipt_number || 'Not assigned',
      amount: transaction.amount,
      currency: transaction.currency,
      categoryName: transaction.category?.name ?? '',
      paymentMethod:
        transaction.payment_method ||
        (transaction.type === 'digital' ? 'Not recorded' : transaction.type),
      paymentReference: transaction.payment_reference || undefined,
      paymentGateway: transaction.payment_gateway,
      createdAt: transaction.created_at,
      givingDate: transaction.giving_date ?? transaction.created_at,
      branchName: transaction.branch?.name || undefined,
      source:
        transaction.metadata &&
        typeof transaction.metadata === 'object' &&
        !Array.isArray(transaction.metadata) &&
        typeof transaction.metadata.cellGroupName === 'string'
          ? `Cell group: ${transaction.metadata.cellGroupName}${typeof transaction.metadata.cellGroupMeetingDate === 'string' ? ` (meeting ${transaction.metadata.cellGroupMeetingDate})` : ''}`
          : transaction.service?.name
            ? `Service: ${transaction.service.name}`
            : transaction.event?.title
              ? `Event: ${transaction.event.title}`
              : transaction.member_id
                ? 'Member giving'
                : 'General giving',
      notes: transaction.notes || undefined,
      churchName: church?.name || 'Church',
      churchId,
      churchLogoUrl: church?.logo_url || undefined,
      churchAddress: church?.address || undefined,
      memberName,
      memberEmail,
    };

    const buffer = await this.receipt.generateReceipt(receiptData);
    const reference = (transaction.receipt_number || transaction.id)
      .replace(/[^a-zA-Z0-9_.-]+/g, '-')
      .slice(0, 120);
    const filename = `receipt-${reference}.pdf`;

    return { buffer, filename };
  }

  /**
   * Sends a receipt for a transaction via WhatsApp or email.
   *
   * @param transactionId - The transaction ID
   * @param churchId - The church ID for tenant isolation
   * @param channel - 'whatsapp' or 'email'
   * @returns Success status message
   *
   * @throws NotFoundException Transaction not found
   * @throws BadRequestException Transaction not successful or no recipient
   */
  async sendReceipt(
    transactionId: string,
    churchId: string,
    channel: 'whatsapp' | 'email',
    viewer?: ViewerScope | null,
  ): Promise<{ success: boolean; message: string }> {
    const transaction = await this.prisma.transaction.findUnique({
      where: { id: transactionId },
      include: { category: true, church: { select: { name: true } } },
    });

    if (!transaction || transaction.church_id !== churchId) {
      throw new NotFoundException('Transaction not found');
    }

    if (!this.branchScope.isVisible(viewer, transaction.branch_id)) {
      throw new NotFoundException('Transaction not found');
    }

    if (transaction.status !== 'success') {
      throw new BadRequestException('Receipts can only be sent for successful transactions');
    }

    if (channel === 'whatsapp') {
      throw new BadRequestException(
        'WhatsApp PDF delivery is unavailable. Download or email the receipt.',
      );
    }

    if (!transaction.member_id) {
      throw new BadRequestException('No member associated with this transaction');
    }

    const member = await this.prisma.member.findUnique({
      where: { id: transaction.member_id, church_id: churchId },
      select: { first_name: true, last_name: true, email: true, phone: true },
    });

    if (!member) {
      throw new BadRequestException('Member not found');
    }

    const { buffer, filename } = await this.generateReceipt(transactionId, churchId, viewer);

    // Email channel
    const email = member.email;
    if (!email) {
      throw new BadRequestException('Member has no email on file');
    }

    const content = givingReceiptEmail(
      {
        churchName: transaction.church.name,
        firstName: member.first_name,
        categoryName: transaction.category?.name || 'Giving',
        amount: transaction.amount,
        currency: transaction.currency,
        receiptNumber: transaction.receipt_number || 'Not assigned',
      },
      this.config.getOrThrow<string>('WEB_URL'),
    );
    await this.notifications.sendEmailWithAttachment(
      email,
      content.subject,
      content.html,
      buffer,
      filename,
      churchId,
      content.text,
    );

    await this.audit.log({
      userId: transaction.member_id,
      churchId,
      entity: 'transaction',
      action: 'UPDATE',
      entityId: transactionId,
      newValues: { receiptSentVia: 'email', sentAt: new Date().toISOString() },
    });

    return { success: true, message: 'Receipt sent via email' };
  }

  // ─── HELPERS ──────────────────────────────────────────────────────

  /**
   * Captures an authorization code from a successful payment and stores it
   * on the matching RecurringGiving record for future automated charges.
   */
  private async captureAuthorizationCode(
    churchId: string,
    memberId: string,
    categoryId: string | null,
    authorizationCode: string,
    accountId?: string | null,
  ): Promise<void> {
    if (!categoryId) return;

    try {
      const existing = await this.prisma.recurringGiving.findFirst({
        where: {
          church_id: churchId,
          member_id: memberId,
          category_id: categoryId,
          is_active: true,
        },
      });

      if (existing) {
        await this.prisma.recurringGiving.update({
          where: { id: existing.id },
          data: {
            authorization_code: authorizationCode,
            ...(accountId !== undefined ? { integration_account_id: accountId } : {}),
          },
        });
        this.logger.log(`Authorization code captured for recurring giving ${existing.id}`);
      }
    } catch (error) {
      this.logger.warn(
        `Failed to capture authorization code: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Generates a unique payment reference.
   */
  private generatePaymentReference(categoryName: string): string {
    const prefix = categoryName.substring(0, 3).toUpperCase();
    const timestamp = Date.now();
    const random = randomBytes(4).toString('hex');
    return `${prefix}SEED${timestamp}${random}`;
  }

  /**
   * Gets the next sequential receipt number for a category in a church.
   */
  private async generateReceiptNumber(categoryName: string, churchId: string): Promise<string> {
    const prefix = this.receipt.getCategoryPrefix(categoryName);
    const year = new Date().getFullYear();

    // Count existing receipts for this category + year
    const count = await this.prisma.transaction.count({
      where: {
        church_id: churchId,
        category: { name: categoryName },
        receipt_number: { not: null },
        created_at: {
          gte: new Date(`${year}-01-01`),
          lte: new Date(`${year}-12-31T23:59:59.999Z`),
        },
      },
    });

    return this.receipt.generateReceiptNumber(prefix, count + 1);
  }

  /**
   * Maps a Prisma GivingCategory to the response DTO.
   */
  private mapCategoryToDto(category: {
    id: string;
    church_id: string;
    name: string;
    description: string | null;
    display_order: number;
    is_recurring: boolean;
    is_active: boolean;
    archived_at: Date | null;
    created_at: Date;
    updated_at: Date;
  }): CategoryResponseDto {
    return {
      categoryId: category.id,
      churchId: category.church_id,
      name: category.name,
      description: category.description || undefined,
      displayOrder: category.display_order,
      isRecurring: category.is_recurring,
      isActive: category.is_active,
      archivedAt: category.archived_at?.toISOString(),
      createdAt: category.created_at.toISOString(),
      updatedAt: category.updated_at.toISOString(),
    };
  }

  /**
   * Maps a Prisma Transaction to the response DTO.
   */
  private mapTransactionToDto(transaction: {
    id: string;
    church_id: string;
    branch_id: string | null;
    branch?: { name: string } | null;
    member_id: string | null;
    category_id: string | null;
    service_id?: string | null;
    event_id?: string | null;
    metadata?: Prisma.JsonValue;
    lifecycle?: Prisma.JsonValue;
    amount: number;
    currency: string;
    type: string;
    status: string;
    payment_reference: string | null;
    payment_gateway: string;
    payment_method: string | null;
    receipt_number: string | null;
    receipt_url: string | null;
    notes: string | null;
    giving_date?: Date;
    created_at: Date;
    updated_at: Date;
    category: { name: string } | null;
    member?: { first_name: string; last_name: string } | null;
    service?: { name: string } | null;
    event?: { title: string } | null;
  }): TransactionResponseDto {
    const metadata =
      transaction.metadata &&
      typeof transaction.metadata === 'object' &&
      !Array.isArray(transaction.metadata)
        ? transaction.metadata
        : {};
    const groupName =
      typeof metadata.cellGroupName === 'string' ? metadata.cellGroupName : undefined;
    const meetingDate =
      typeof metadata.cellGroupMeetingDate === 'string' ? metadata.cellGroupMeetingDate : undefined;
    return {
      givingType: typeof metadata.cellGroupId === 'string' ? 'cell_group' : 'normal',
      title: groupName ? `${groupName}: Meeting Giving` : undefined,
      description: groupName
        ? `Combined giving from ${groupName}${meetingDate ? ` for the meeting on ${meetingDate}` : ''}.`
        : undefined,
      transactionId: transaction.id,
      cellGroupId:
        transaction.metadata &&
        typeof transaction.metadata === 'object' &&
        !Array.isArray(transaction.metadata) &&
        typeof transaction.metadata.cellGroupId === 'string'
          ? transaction.metadata.cellGroupId
          : undefined,
      cellGroupName:
        transaction.metadata &&
        typeof transaction.metadata === 'object' &&
        !Array.isArray(transaction.metadata) &&
        typeof transaction.metadata.cellGroupName === 'string'
          ? transaction.metadata.cellGroupName
          : undefined,
      cellGroupMeetingDate:
        transaction.metadata &&
        typeof transaction.metadata === 'object' &&
        !Array.isArray(transaction.metadata) &&
        typeof transaction.metadata.cellGroupMeetingDate === 'string'
          ? transaction.metadata.cellGroupMeetingDate
          : undefined,
      churchId: transaction.church_id,
      branchId: transaction.branch_id || undefined,
      branchName: transaction.branch?.name || undefined,
      memberId: transaction.member_id || undefined,
      memberName: transaction.member
        ? `${transaction.member.first_name} ${transaction.member.last_name}`
        : undefined,
      serviceId: transaction.service_id || undefined,
      serviceName: transaction.service?.name || undefined,
      eventId: transaction.event_id || undefined,
      eventName: transaction.event?.title || undefined,
      categoryId: transaction.category_id ?? '',
      categoryName: transaction.category?.name ?? '',
      amount: transaction.amount,
      currency: transaction.currency,
      type: transaction.type,
      status: transaction.status,
      paymentReview: record(transaction.lifecycle).access === 'review',
      refundedAmount: Number(record(transaction.lifecycle).refundedAmount ?? 0),
      paymentReference: transaction.payment_reference || undefined,
      paymentGateway: transaction.payment_gateway,
      paymentMethod: transaction.payment_method || undefined,
      receiptNumber: transaction.receipt_number || undefined,
      receiptUrl: transaction.receipt_url || undefined,
      notes: transaction.notes || undefined,
      givingDate: (transaction.giving_date ?? transaction.created_at).toISOString().slice(0, 10),
      createdAt: transaction.created_at.toISOString(),
      updatedAt: transaction.updated_at.toISOString(),
    };
  }
}
