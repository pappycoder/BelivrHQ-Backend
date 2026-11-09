import { ConfigService } from '@nestjs/config';
import { RequestContextService } from '../../../src/common/services/request-context.service';
/**
 * @file giving.service.spec.ts
 * @description Unit tests for GivingService.
 *
 * Tests category CRUD, digital payment initialization/verification,
 * webhook handling, cash/bank recording, transaction queries, and
 * receipt generation. Supports multiple payment gateways.
 *
 * @module test/unit/giving/giving.service.spec
 * @since 1.0.0
 */

import { GivingService } from '../../../src/giving/giving.service';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { AuditLoggingService } from '../../../src/common/services/audit-logging.service';
import { BranchScopeService } from '../../../src/common/services/branch-scope.service';
import { PaymentGatewayProvider } from '../../../src/giving/services/payment-gateway.interface';
import { ReceiptService } from '../../../src/giving/services/receipt.service';
import {
  NotFoundException,
  ConflictException,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';

describe('GivingService', () => {
  let service: GivingService;
  let prisma: Record<string, unknown> & { $transaction: jest.Mock };
  let audit: { log: jest.Mock };
  let paystack: Record<string, jest.Mock>;
  let flutterwave: Record<string, jest.Mock>;
  let gatewayRegistry: Map<string, PaymentGatewayProvider>;
  let receipt: Record<string, jest.Mock>;
  let receiptEmail: jest.Mock;
  let integrationAlert: { notify: jest.Mock };

  const mockUserId = '11111111-1111-1111-1111-111111111111';
  const mockChurchId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const mockCategoryId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const mockTransactionId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  const mockBranchId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  const mockMemberId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

  function createPrismaMock() {
    const models: Record<string, Record<string, jest.Mock>> = {};
    const $transactionMock = jest.fn();

    const handler: ProxyHandler<Record<string, unknown>> = {
      get(_target, prop: string) {
        if (prop === '$transaction') return $transactionMock;
        if (prop === '$queryRaw') return jest.fn().mockResolvedValue([]);
        if (!models[prop]) {
          models[prop] = {
            findMany: jest.fn(),
            findUnique: jest.fn(),
            findFirst: jest.fn(),
            findFirstOrThrow: jest.fn(),
            updateMany: jest.fn(),
            upsert: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
            delete: jest.fn(),
            count: jest.fn(),
          };
        }
        return models[prop];
      },
    };

    return new Proxy(
      { $transaction: $transactionMock } as Record<string, unknown>,
      handler,
    ) as Record<string, unknown> & { $transaction: jest.Mock };
  }

  function model(name: string): Record<string, jest.Mock> {
    return prisma[name] as Record<string, jest.Mock>;
  }

  function createGatewayMock(): Record<string, jest.Mock> {
    return {
      isConfigured: jest.fn().mockReturnValue(true),
      initializeTransaction: jest.fn(),
      verifyTransaction: jest.fn().mockResolvedValue({
        reference: 'TITHSEED123abc',
        amount: 10000,
        currency: 'NGN',
        status: 'success',
      }),
      validateWebhookSignature: jest.fn().mockReturnValue(true),
      parseWebhookEvent: jest.fn().mockReturnValue({ event: '', reference: '' }),
      mapChannelToPaymentMethod: jest.fn().mockReturnValue('card'),
      mapEventToStatus: jest.fn(),
    };
  }

  const mockCategory = {
    id: mockCategoryId,
    church_id: mockChurchId,
    name: 'Tithe',
    description: 'Regular tithe',
    display_order: 1,
    is_recurring: true,
    is_active: true,
    archived_at: null,
    created_at: new Date('2026-07-01T10:00:00.000Z'),
    updated_at: new Date('2026-07-01T10:00:00.000Z'),
  };

  const mockTransaction = {
    id: mockTransactionId,
    church_id: mockChurchId,
    branch_id: mockBranchId,
    member_id: mockMemberId,
    category_id: mockCategoryId,
    amount: 10000,
    currency: 'NGN',
    type: 'digital',
    status: 'success',
    payment_reference: 'TITHSEED123abc',
    payment_gateway: 'paystack',
    payment_method: 'card',
    receipt_number: '2026/TIT/0001',
    receipt_url: null,
    notes: null,
    created_at: new Date('2026-07-20T10:00:00.000Z'),
    updated_at: new Date('2026-07-20T10:00:00.000Z'),
    category: { name: 'Tithe' },
  };

  beforeEach(() => {
    prisma = createPrismaMock();
    audit = { log: jest.fn().mockResolvedValue(undefined) };

    paystack = createGatewayMock();
    flutterwave = createGatewayMock();

    gatewayRegistry = new Map([
      ['paystack', paystack as unknown as PaymentGatewayProvider],
      ['flutterwave', flutterwave as unknown as PaymentGatewayProvider],
    ]);

    receipt = {
      generateReceipt: jest.fn().mockResolvedValue(Buffer.from('pdf')),
      getCategoryPrefix: jest.fn().mockReturnValue('TIT'),
      generateReceiptNumber: jest.fn().mockReturnValue('2026/TIT/0001'),
    };

    service = new GivingService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditLoggingService,
      gatewayRegistry,
      receipt as unknown as ReceiptService,
      {
        createNotification: jest.fn().mockResolvedValue({}),
        sendEmailWithAttachment: (receiptEmail = jest.fn().mockResolvedValue(undefined)),
        broadcastToChurch: jest.fn().mockResolvedValue({ sent: 0 }),
      } as never,
      new BranchScopeService(new RequestContextService()),
      (integrationAlert = { notify: jest.fn().mockResolvedValue(undefined) }) as never,
      {
        defaultGateway: jest.fn().mockResolvedValue('paystack'),
        current: jest.fn(async (_churchId: string, name: string) => {
          const provider = gatewayRegistry.get(name);
          if (!provider || !provider.isConfigured())
            throw new BadRequestException('Payment gateway is not configured');
          return { provider, accountId: 'church-payment-account' };
        }),
        historical: jest.fn(async (_churchId: string, name: string) => gatewayRegistry.get(name)),
      } as never,
      new ConfigService({ WEB_URL: 'https://churchos.example' }),
    );
  });

  // ─── CATEGORY CRUD ────────────────────────────────────────────────

  describe('getDashboardCharts', () => {
    it.each([
      [true, 'branch-a', 'branch-b', 'branch-b'],
      [true, 'branch-a', undefined, undefined],
      [false, 'branch-a', 'branch-b', 'branch-a'],
      [false, undefined, 'branch-b', '00000000-0000-0000-0000-000000000000'],
    ])(
      'pins successful giving to church, currency and scope for HQ=%s own=%s requested=%s',
      async (hq, own, requested, expected) => {
        model('transaction').findMany.mockResolvedValue([]);
        const result = await service.getDashboardCharts(
          mockChurchId,
          { branchId: requested as string | undefined },
          {
            church_id: mockChurchId,
            role: 'church_admin',
            is_admin_hq: hq as boolean,
            branch_id: own as string | undefined,
          },
        );
        expect(model('transaction').findMany).toHaveBeenCalledWith({
          where: {
            church_id: mockChurchId,
            status: 'success',
            currency: 'NGN',
            ...(expected ? { branch_id: expected } : {}),
          },
          select: { amount: true, giving_date: true, category_id: true },
          orderBy: { giving_date: 'asc' },
        });
        expect(result).toEqual({ currency: 'NGN', total: 0, count: 0, trend: [], byCategory: [] });
        expect(model('givingCategory').findMany).not.toHaveBeenCalled();
      },
    );

    it('uses selected currency, inclusive dates, and tenant-scoped category names without donor data', async () => {
      model('transaction').findMany.mockResolvedValue([
        { amount: 10, giving_date: new Date('2026-10-27T22:00:00Z'), category_id: 'cat-a' },
        { amount: 20, giving_date: new Date('2026-10-27T23:59:59Z'), category_id: 'cat-a' },
        { amount: 5, giving_date: new Date('2026-10-28T12:00:00Z'), category_id: null },
      ]);
      model('givingCategory').findMany.mockResolvedValue([{ id: 'cat-a', name: 'Offering' }]);
      const result = await service.getDashboardCharts(mockChurchId, {
        currency: 'USD',
        startDate: '2026-10-27',
        endDate: '2026-10-28',
      });
      expect(model('transaction').findMany.mock.calls[0][0].where).toEqual({
        church_id: mockChurchId,
        status: 'success',
        currency: 'USD',
        giving_date: {
          gte: new Date('2026-10-27T00:00:00Z'),
          lte: new Date('2026-10-28T23:59:59.999Z'),
        },
      });
      expect(model('givingCategory').findMany.mock.calls[0][0].where).toEqual({
        church_id: mockChurchId,
        id: { in: ['cat-a'] },
      });
      expect(result).toEqual({
        currency: 'USD',
        total: 35,
        count: 3,
        trend: [
          { date: '2026-10-27', total: 30 },
          { date: '2026-10-28', total: 5 },
        ],
        byCategory: [
          { categoryId: 'cat-a', categoryName: 'Offering', total: 30, count: 2 },
          { categoryId: null, categoryName: 'Uncategorized', total: 5, count: 1 },
        ],
      });
    });

    it.each([
      { startDate: '2026-10-29', endDate: '2026-10-28' },
      { startDate: 'invalid' },
      { endDate: 'invalid' },
    ])('rejects invalid date bounds without querying records: %j', async (query) => {
      await expect(service.getDashboardCharts(mockChurchId, query)).rejects.toThrow(
        BadRequestException,
      );
      expect(model('transaction').findMany).not.toHaveBeenCalled();
    });
  });

  describe('createCategory', () => {
    it('creates a shared category from a branch and trims its name', async () => {
      model('givingCategory').findFirst.mockResolvedValue(null);
      model('givingCategory').create.mockResolvedValue(mockCategory);
      await service.createCategory(
        { name: '  Tithe  ', branchId: mockBranchId },
        mockChurchId,
        mockUserId,
        { church_id: mockChurchId, branch_id: mockBranchId, is_admin_hq: false } as never,
      );
      expect(model('givingCategory').create).toHaveBeenCalledWith({
        data: expect.objectContaining({ name: 'Tithe', branch_id: null, church_id: mockChurchId }),
      });
    });

    it('returns a conflict when simultaneous creates hit the database constraint', async () => {
      model('givingCategory').findFirst.mockResolvedValue(null);
      model('givingCategory').create.mockRejectedValue({ code: 'P2002' });
      await expect(
        service.createCategory({ name: 'Tithe' }, mockChurchId, mockUserId),
      ).rejects.toThrow(ConflictException);
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('rejects a blank category name', async () => {
      await expect(
        service.createCategory({ name: '  ' }, mockChurchId, mockUserId),
      ).rejects.toThrow(BadRequestException);
      expect(model('givingCategory').create).not.toHaveBeenCalled();
    });

    it('persists an explicitly inactive category', async () => {
      model('givingCategory').findFirst.mockResolvedValue(null);
      model('givingCategory').create.mockResolvedValue({ ...mockCategory, is_active: false });
      const result = await service.createCategory(
        { name: 'Special offering', isActive: false },
        mockChurchId,
        mockUserId,
      );
      expect(model('givingCategory').create).toHaveBeenCalledWith({
        data: expect.objectContaining({ is_active: false }),
      });
      expect(result.isActive).toBe(false);
    });

    it('should create a new category', async () => {
      model('givingCategory').findFirst.mockResolvedValue(null);
      model('givingCategory').create.mockResolvedValue(mockCategory);

      const result = await service.createCategory(
        { name: 'Tithe', description: 'Regular tithe' },
        mockChurchId,
        mockUserId,
      );

      expect(result.name).toBe('Tithe');
      expect(result.categoryId).toBe(mockCategoryId);
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'giving_category', action: 'CREATE' }),
      );
    });

    it('should throw ConflictException if category name exists', async () => {
      model('givingCategory').findFirst.mockResolvedValue(mockCategory);

      await expect(
        service.createCategory({ name: 'Tithe' }, mockChurchId, mockUserId),
      ).rejects.toThrow(ConflictException);
    });

    it('reserves archived names across the church without case sensitivity', async () => {
      model('givingCategory').findFirst.mockResolvedValue(null);
      model('givingCategory').create.mockResolvedValue(mockCategory);

      await service.createCategory({ name: 'Tithe' }, mockChurchId, mockUserId);

      expect(model('givingCategory').findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            church_id: mockChurchId,
            name: { equals: 'Tithe', mode: 'insensitive' },
          }),
        }),
      );
    });
  });

  describe('listCategories', () => {
    it('lists church-wide categories even for branch staff and branch filters', async () => {
      model('givingCategory').findMany.mockResolvedValue([mockCategory]);
      model('givingCategory').count.mockResolvedValue(1);
      await service.listCategories(
        mockChurchId,
        undefined,
        undefined,
        undefined,
        false,
        mockBranchId,
        { branch_id: mockBranchId, is_admin_hq: false } as never,
      );
      expect(model('givingCategory').findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { church_id: mockChurchId, archived_at: null },
        }),
      );
    });

    it('should return all categories with total when unpaginated', async () => {
      model('givingCategory').findMany.mockResolvedValue([mockCategory]);
      model('givingCategory').count.mockResolvedValue(1);

      const result = await service.listCategories(mockChurchId);

      expect(result.data).toHaveLength(1);
      expect(result.data[0].name).toBe('Tithe');
      expect(result.total).toBe(1);
    });

    it('should not pass skip/take when no page size is requested', async () => {
      model('givingCategory').findMany.mockResolvedValue([]);
      model('givingCategory').count.mockResolvedValue(0);

      await service.listCategories(mockChurchId);

      const arg = model('givingCategory').findMany.mock.calls[0][0];
      expect(arg.skip).toBeUndefined();
      expect(arg.take).toBeUndefined();
    });

    it('should filter by isActive', async () => {
      model('givingCategory').findMany.mockResolvedValue([]);
      model('givingCategory').count.mockResolvedValue(0);

      await service.listCategories(mockChurchId, true);

      expect(model('givingCategory').findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ is_active: true }),
        }),
      );
    });

    it('should paginate when a page size is provided', async () => {
      model('givingCategory').findMany.mockResolvedValue([]);
      model('givingCategory').count.mockResolvedValue(12);

      const result = await service.listCategories(mockChurchId, undefined, 2, 10);

      expect(model('givingCategory').findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ display_order: 'asc' }, { name: 'asc' }],
          skip: 10,
          take: 10,
        }),
      );
      expect(result.total).toBe(12);
    });

    it('should default to excluding archived categories (archived_at null)', async () => {
      model('givingCategory').findMany.mockResolvedValue([]);
      model('givingCategory').count.mockResolvedValue(0);

      await service.listCategories(mockChurchId);

      expect(model('givingCategory').findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ archived_at: null }),
        }),
      );
    });

    it('should list only archived categories when archived=true and map archivedAt', async () => {
      const archived = { ...mockCategory, archived_at: new Date('2026-08-01T00:00:00.000Z') };
      model('givingCategory').findMany.mockResolvedValue([archived]);
      model('givingCategory').count.mockResolvedValue(1);

      const result = await service.listCategories(
        mockChurchId,
        undefined,
        undefined,
        undefined,
        true,
      );

      expect(model('givingCategory').findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ archived_at: { not: null } }),
        }),
      );
      expect(result.data[0].archivedAt).toBe('2026-08-01T00:00:00.000Z');
    });
  });

  describe('getCategoryById', () => {
    it('should return category by ID', async () => {
      model('givingCategory').findUnique.mockResolvedValue(mockCategory);

      const result = await service.getCategoryById(mockCategoryId, mockChurchId);

      expect(result.name).toBe('Tithe');
    });

    it('should throw NotFoundException if not found', async () => {
      model('givingCategory').findUnique.mockResolvedValue(null);

      await expect(service.getCategoryById('nonexistent', mockChurchId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException if belongs to another church', async () => {
      model('givingCategory').findUnique.mockResolvedValue({
        ...mockCategory,
        church_id: 'other-church',
      });

      await expect(service.getCategoryById(mockCategoryId, mockChurchId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('updateCategory', () => {
    it('rejects blank rename requests', async () => {
      model('givingCategory').findUnique.mockResolvedValue(mockCategory);
      await expect(
        service.updateCategory(mockCategoryId, { name: '  ' }, mockChurchId, mockUserId),
      ).rejects.toThrow(BadRequestException);
    });

    it('translates concurrent rename collisions into a conflict', async () => {
      model('givingCategory').findUnique.mockResolvedValue(mockCategory);
      model('givingCategory').findFirst.mockResolvedValue(null);
      model('givingCategory').update.mockRejectedValue({ code: 'P2002' });
      await expect(
        service.updateCategory(mockCategoryId, { name: ' Offering ' }, mockChurchId, mockUserId),
      ).rejects.toThrow(ConflictException);
    });

    it('should update category fields', async () => {
      model('givingCategory').findUnique.mockResolvedValueOnce(mockCategory);
      model('givingCategory').update.mockResolvedValue({
        ...mockCategory,
        name: 'Updated Tithe',
      });

      const result = await service.updateCategory(
        mockCategoryId,
        { name: 'Updated Tithe' },
        mockChurchId,
        mockUserId,
      );

      expect(result.name).toBe('Updated Tithe');
    });

    it('should throw NotFoundException if not found', async () => {
      model('givingCategory').findUnique.mockResolvedValue(null);

      await expect(
        service.updateCategory(mockCategoryId, { name: 'X' }, mockChurchId, mockUserId),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ConflictException if new name conflicts', async () => {
      model('givingCategory').findUnique.mockResolvedValueOnce(mockCategory);
      model('givingCategory').findFirst.mockResolvedValueOnce({ id: 'other', name: 'Offering' });

      await expect(
        service.updateCategory(mockCategoryId, { name: 'Offering' }, mockChurchId, mockUserId),
      ).rejects.toThrow(ConflictException);
    });

    it('should return existing if no fields provided', async () => {
      model('givingCategory').findUnique.mockResolvedValue(mockCategory);

      const result = await service.updateCategory(mockCategoryId, {}, mockChurchId, mockUserId);

      expect(result.name).toBe('Tithe');
      expect(model('givingCategory').update).not.toHaveBeenCalled();
    });

    it('checks renamed categories against archived names too', async () => {
      model('givingCategory').findUnique.mockResolvedValueOnce(mockCategory);
      model('givingCategory').findFirst.mockResolvedValueOnce(null);
      model('givingCategory').update.mockResolvedValue({ ...mockCategory, name: 'Offering' });

      await service.updateCategory(mockCategoryId, { name: 'Offering' }, mockChurchId, mockUserId);

      expect(model('givingCategory').findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            church_id: mockChurchId,
            name: { equals: 'Offering', mode: 'insensitive' },
            id: { not: mockCategoryId },
          },
        }),
      );
    });

    it('should throw NotFoundException when updating an archived category', async () => {
      model('givingCategory').findUnique.mockResolvedValue({
        ...mockCategory,
        archived_at: new Date('2026-08-01T00:00:00.000Z'),
      });

      await expect(
        service.updateCategory(mockCategoryId, { name: 'X' }, mockChurchId, mockUserId),
      ).rejects.toThrow(NotFoundException);
      expect(model('givingCategory').update).not.toHaveBeenCalled();
    });
  });

  describe('deleteCategory', () => {
    it('should soft-delete category', async () => {
      model('givingCategory').findUnique.mockResolvedValue(mockCategory);
      model('givingCategory').update.mockResolvedValue({});

      await service.deleteCategory(mockCategoryId, mockChurchId, mockUserId);

      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'giving_category', action: 'DELETE' }),
      );
    });

    it('should throw NotFoundException if not found', async () => {
      model('givingCategory').findUnique.mockResolvedValue(null);

      await expect(
        service.deleteCategory(mockCategoryId, mockChurchId, mockUserId),
      ).rejects.toThrow(NotFoundException);
    });

    it('should still deactivate (purge path) an archived category', async () => {
      model('givingCategory').findUnique.mockResolvedValue({
        ...mockCategory,
        archived_at: new Date('2026-08-01T00:00:00.000Z'),
      });
      model('givingCategory').update.mockResolvedValue({});

      await service.deleteCategory(mockCategoryId, mockChurchId, mockUserId);

      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'giving_category', action: 'DELETE' }),
      );
    });
  });

  describe('archiveCategory', () => {
    it('should archive a category and audit ARCHIVE', async () => {
      model('givingCategory').findUnique.mockResolvedValue(mockCategory);
      const archived = { ...mockCategory, archived_at: new Date('2026-08-01T00:00:00.000Z') };
      model('givingCategory').update.mockResolvedValue(archived);

      const result = await service.archiveCategory(mockCategoryId, mockChurchId, mockUserId);

      expect(model('givingCategory').update).toHaveBeenCalledWith({
        where: { id: mockCategoryId },
        data: { archived_at: expect.any(Date) },
      });
      expect(result.archivedAt).toBe('2026-08-01T00:00:00.000Z');
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'giving_category', action: 'ARCHIVE' }),
      );
    });

    it('should throw ConflictException when already archived', async () => {
      model('givingCategory').findUnique.mockResolvedValue({
        ...mockCategory,
        archived_at: new Date('2026-08-01T00:00:00.000Z'),
      });

      await expect(
        service.archiveCategory(mockCategoryId, mockChurchId, mockUserId),
      ).rejects.toThrow(ConflictException);
    });

    it('should throw NotFoundException when missing or foreign-church', async () => {
      model('givingCategory').findUnique.mockResolvedValue(null);

      await expect(
        service.archiveCategory('nonexistent', mockChurchId, mockUserId),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('restoreCategory', () => {
    it('should restore an archived category and audit RESTORE', async () => {
      model('givingCategory').findUnique.mockResolvedValue({
        ...mockCategory,
        archived_at: new Date('2026-08-01T00:00:00.000Z'),
      });
      model('givingCategory').update.mockResolvedValue(mockCategory);

      const result = await service.restoreCategory(mockCategoryId, mockChurchId, mockUserId);

      expect(model('givingCategory').update).toHaveBeenCalledWith({
        where: { id: mockCategoryId },
        data: { archived_at: null },
      });
      expect(result.archivedAt).toBeUndefined();
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'giving_category', action: 'RESTORE' }),
      );
    });

    it('should throw ConflictException when not archived', async () => {
      model('givingCategory').findUnique.mockResolvedValue(mockCategory);

      await expect(
        service.restoreCategory(mockCategoryId, mockChurchId, mockUserId),
      ).rejects.toThrow(ConflictException);
    });

    it('should throw NotFoundException when missing', async () => {
      model('givingCategory').findUnique.mockResolvedValue(null);

      await expect(
        service.restoreCategory('nonexistent', mockChurchId, mockUserId),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ─── DIGITAL GIVING (PAYSTACK) ────────────────────────────────────

  describe('initializePayment (paystack)', () => {
    it('should initialize a payment via paystack', async () => {
      model('givingCategory').findUnique.mockResolvedValue(mockCategory);
      model('church').findUnique.mockResolvedValue({
        id: mockChurchId,
        config: { default_payment_gateway: 'paystack' },
      });
      model('transaction').create.mockResolvedValue({
        ...mockTransaction,
        status: 'pending',
      });
      paystack.initializeTransaction.mockResolvedValue({
        authorizationUrl: 'https://checkout.paystack.com/abc',
        accessCode: 'abc',
        reference: 'TITHSEED123abc',
      });

      const result = await service.initializePayment(
        { categoryId: mockCategoryId, amount: 10000, email: 'test@example.com' },
        mockChurchId,
        mockUserId,
      );

      expect(result.authorizationUrl).toBe('https://checkout.paystack.com/abc');
      expect(result.gateway).toBe('paystack');
    });

    it('should use gateway from DTO when provided', async () => {
      model('givingCategory').findUnique.mockResolvedValue(mockCategory);
      model('transaction').create.mockResolvedValue({
        ...mockTransaction,
        payment_gateway: 'flutterwave',
        status: 'pending',
      });
      flutterwave.initializeTransaction.mockResolvedValue({
        authorizationUrl: 'https://checkout.flutterwave.com/abc',
        reference: 'TITHSEED123abc',
      });

      const result = await service.initializePayment(
        {
          categoryId: mockCategoryId,
          amount: 10000,
          email: 'test@example.com',
          gateway: 'flutterwave',
        },
        mockChurchId,
        mockUserId,
      );

      expect(result.authorizationUrl).toBe('https://checkout.flutterwave.com/abc');
      expect(result.gateway).toBe('flutterwave');
    });

    it('should throw NotFoundException if category not found', async () => {
      model('givingCategory').findUnique.mockResolvedValue(null);

      await expect(
        service.initializePayment(
          { categoryId: 'nonexistent', amount: 10000, email: 'test@example.com' },
          mockChurchId,
          mockUserId,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException if category is inactive', async () => {
      model('givingCategory').findUnique.mockResolvedValue({
        ...mockCategory,
        is_active: false,
      });

      await expect(
        service.initializePayment(
          { categoryId: mockCategoryId, amount: 10000, email: 'test@example.com' },
          mockChurchId,
          mockUserId,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if gateway not configured', async () => {
      paystack.isConfigured.mockReturnValue(false);

      await expect(
        service.initializePayment(
          {
            categoryId: mockCategoryId,
            amount: 10000,
            email: 'test@example.com',
            gateway: 'paystack',
          },
          mockChurchId,
          mockUserId,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should mark the pending transaction failed and alert when the gateway init throws', async () => {
      model('givingCategory').findUnique.mockResolvedValue(mockCategory);
      model('church').findUnique.mockResolvedValue({
        id: mockChurchId,
        config: { default_payment_gateway: 'paystack' },
      });
      model('transaction').create.mockResolvedValue({
        ...mockTransaction,
        id: mockTransactionId,
        status: 'pending',
      });
      model('transaction').update.mockResolvedValue({ ...mockTransaction, status: 'failed' });
      paystack.initializeTransaction.mockRejectedValue(new Error('socket hang up'));

      await expect(
        service.initializePayment(
          { categoryId: mockCategoryId, amount: 10000, email: 'test@example.com' },
          mockChurchId,
          mockUserId,
        ),
      ).rejects.toThrow(ServiceUnavailableException);

      expect(model('transaction').update).toHaveBeenCalledWith({
        where: { id: mockTransactionId },
        data: { status: 'failed' },
      });
      expect(integrationAlert.notify).toHaveBeenCalledWith(
        mockChurchId,
        'paystack',
        expect.stringContaining('Paystack payment init failed'),
        expect.stringContaining('Could not initialize payment'),
        expect.objectContaining({ gateway: 'paystack', reference: expect.any(String) }),
      );
    });

    it('should rethrow a provider ServiceUnavailableException without re-wrapping', async () => {
      model('givingCategory').findUnique.mockResolvedValue(mockCategory);
      model('church').findUnique.mockResolvedValue({
        id: mockChurchId,
        config: { default_payment_gateway: 'paystack' },
      });
      model('transaction').create.mockResolvedValue({
        ...mockTransaction,
        id: mockTransactionId,
        status: 'pending',
      });
      model('transaction').update.mockResolvedValue({ ...mockTransaction, status: 'failed' });
      paystack.initializeTransaction.mockRejectedValue(new ServiceUnavailableException('down'));

      await expect(
        service.initializePayment(
          { categoryId: mockCategoryId, amount: 10000, email: 'test@example.com' },
          mockChurchId,
          mockUserId,
        ),
      ).rejects.toThrow(ServiceUnavailableException);
    });
  });

  function setupPaymentLedger() {
    prisma.$transaction.mockImplementation((callback: (tx: typeof prisma) => unknown) =>
      callback(prisma),
    );
    model('transaction').findFirstOrThrow.mockImplementation(() =>
      model('transaction').findFirst(),
    );
    model('transaction').findMany.mockImplementation(async () => {
      const payment = await model('transaction').findFirst();
      return payment ? [payment] : [];
    });
    model('transaction').updateMany.mockImplementation(async ({ data }) => {
      const previous = await model('transaction').findFirst();
      model('transaction').findFirst.mockResolvedValue({ ...previous, ...data });
      return { count: 1 };
    });
  }
  describe('verifyPayment', () => {
    beforeEach(setupPaymentLedger);
    it('should return existing successful transaction', async () => {
      model('transaction').findFirst.mockResolvedValue(mockTransaction);

      const result = await service.verifyPayment('TITHSEED123abc', mockChurchId);

      expect(result.status).toBe('success');
      expect(paystack.verifyTransaction).toHaveBeenCalled();
    });

    it('should verify pending transaction with correct gateway', async () => {
      const pendingTransaction = { ...mockTransaction, status: 'pending' };
      model('transaction').findFirst.mockResolvedValue(pendingTransaction);
      paystack.verifyTransaction.mockResolvedValue({
        reference: 'TITHSEED123abc',
        amount: 10000,
        currency: 'NGN',
        status: 'success',
        paidAt: '2026-07-20T10:00:00.000Z',
        channel: 'card',
        customerEmail: 'test@example.com',
      });
      model('transaction').update.mockResolvedValue({
        ...mockTransaction,
        status: 'success',
      });

      const result = await service.verifyPayment('TITHSEED123abc', mockChurchId);

      expect(result.status).toBe('success');
      expect(paystack.verifyTransaction).toHaveBeenCalledWith('TITHSEED123abc');
    });

    it('should verify with flutterwave when transaction gateway is flutterwave', async () => {
      const pendingTransaction = {
        ...mockTransaction,
        status: 'pending',
        payment_gateway: 'flutterwave',
      };
      model('transaction').findFirst.mockResolvedValue(pendingTransaction);
      flutterwave.verifyTransaction.mockResolvedValue({
        reference: 'TITHSEED123abc',
        amount: 10000,
        currency: 'NGN',
        status: 'success',
        paidAt: '2026-07-20T10:00:00.000Z',
        channel: 'card',
        customerEmail: 'test@example.com',
      });
      model('transaction').update.mockResolvedValue({
        ...mockTransaction,
        status: 'success',
      });

      const result = await service.verifyPayment('TITHSEED123abc', mockChurchId);

      expect(result.status).toBe('success');
      expect(flutterwave.verifyTransaction).toHaveBeenCalledWith('TITHSEED123abc');
      expect(paystack.verifyTransaction).not.toHaveBeenCalled();
    });

    it('should throw NotFoundException if transaction not found', async () => {
      model('transaction').findFirst.mockResolvedValue(null);

      await expect(service.verifyPayment('nonexistent', mockChurchId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ─── WEBHOOK HANDLING ────────────────────────────────────────────

  describe('handleWebhook', () => {
    beforeEach(setupPaymentLedger);
    it('should process charge.success event from paystack', async () => {
      paystack.parseWebhookEvent.mockReturnValue({
        event: 'charge.success',
        reference: 'TITHSEED123abc',
        channel: 'card',
      });
      paystack.mapEventToStatus.mockReturnValue('success');

      const pendingTransaction = { ...mockTransaction, status: 'pending' };
      model('transaction').findFirst.mockResolvedValue(pendingTransaction);
      model('transaction').update.mockResolvedValue({
        ...mockTransaction,
        status: 'success',
      });

      const result = await service.handleWebhook(
        JSON.stringify({ event: 'charge.success', data: {} }),
        'valid-signature',
        'paystack',
      );

      expect(result.processed).toBe(true);
    });

    it('should process charge.completed event from flutterwave', async () => {
      flutterwave.parseWebhookEvent.mockReturnValue({
        event: 'charge.completed',
        reference: 'TITHSEED123abc',
        channel: 'card',
      });
      flutterwave.mapEventToStatus.mockReturnValue('success');

      const pendingTransaction = {
        ...mockTransaction,
        status: 'pending',
        payment_gateway: 'flutterwave',
      };
      model('transaction').findFirst.mockResolvedValue(pendingTransaction);
      model('transaction').update.mockResolvedValue({
        ...mockTransaction,
        status: 'success',
      });

      const result = await service.handleWebhook(
        JSON.stringify({ event: 'charge.completed', data: {} }),
        'valid-signature',
        'flutterwave',
      );

      expect(result.processed).toBe(true);
    });

    it('should reject invalid webhook signature', async () => {
      paystack.parseWebhookEvent.mockReturnValue({
        event: 'charge.success',
        reference: 'TITHSEED123abc',
      });
      paystack.validateWebhookSignature.mockReturnValue(false);
      model('transaction').findFirst.mockResolvedValue({
        ...mockTransaction,
        integration_account_id: 'church-payment-account',
      });

      await expect(service.handleWebhook('{}', 'invalid-signature', 'paystack')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should skip non-charge events', async () => {
      paystack.parseWebhookEvent.mockReturnValue({
        event: 'invoice.created',
        reference: '',
      });

      const result = await service.handleWebhook(
        JSON.stringify({ event: 'invoice.created', data: {} }),
        'sig',
        'paystack',
      );

      expect(result.processed).toBe(false);
    });

    it('should be idempotent for terminal states', async () => {
      paystack.parseWebhookEvent.mockReturnValue({
        event: 'charge.success',
        reference: 'TITHSEED123abc',
        channel: 'card',
      });
      paystack.mapEventToStatus.mockReturnValue('success');

      model('transaction').findFirst.mockResolvedValue(mockTransaction);

      const result = await service.handleWebhook(
        JSON.stringify({ event: 'charge.success', data: {} }),
        'sig',
        'paystack',
      );

      expect(result.processed).toBe(true);
      expect(model('transaction').update).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException for unknown gateway', async () => {
      await expect(service.handleWebhook('{}', 'sig', 'unknown')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ─── CASH/BANK GIVING ────────────────────────────────────────────

  describe('recordCashGiving', () => {
    const groupId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const leader = {
      church_id: mockChurchId,
      role: 'cell_leader',
      branch_id: mockBranchId,
      member_id: mockMemberId,
      permissions: ['cell_groups:own:read', 'cell_groups:giving:create'],
    };
    const group = {
      id: groupId,
      name: 'Lekki Fellowship',
      leader_id: mockMemberId,
      branch_id: mockBranchId,
      archived_at: null,
    };

    it('records one combined meeting total in the shared transaction ledger', async () => {
      model('cellGroup').findFirst.mockResolvedValue(group);
      model('branch').findFirst.mockResolvedValue({ id: mockBranchId });
      model('givingCategory').findUnique.mockResolvedValue(mockCategory);
      model('transaction').count.mockResolvedValue(0);
      model('transaction').create.mockResolvedValue({
        ...mockTransaction,
        metadata: {
          cellGroupId: groupId,
          cellGroupName: group.name,
          cellGroupMeetingDate: '2026-10-11',
        },
      });
      const result = await service.recordCellGroupGiving(
        groupId,
        {
          categoryId: mockCategoryId,
          amount: 10000,
          type: 'cash',
          cellGroupMeetingDate: '2026-10-11',
        },
        mockChurchId,
        mockUserId,
        leader,
      );
      expect(model('cellGroup').findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ leader_id: mockMemberId, branch_id: mockBranchId }),
        }),
      );
      expect(model('transaction').create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            branch_id: mockBranchId,
            amount: 10000,
            status: 'success',
            metadata: {
              cellGroupId: groupId,
              cellGroupName: group.name,
              cellGroupMeetingDate: '2026-10-11',
            },
          }),
        }),
      );
      expect(result.cellGroupMeetingDate).toBe('2026-10-11');
      expect(result.cellGroupName).toBe(group.name);
    });

    it.each([false, true])(
      'blocks another leader group even with HQ=%s on both giving paths',
      async (hq) => {
        model('cellGroup').findFirst.mockResolvedValue({ ...group, leader_id: 'another-leader' });
        const input = {
          cellGroupId: groupId,
          categoryId: mockCategoryId,
          amount: 1000,
          type: 'cash' as const,
          cellGroupMeetingDate: '2026-10-11',
        };
        const viewer = { ...leader, is_admin_hq: hq };
        await expect(
          service.recordCellGroupGiving(groupId, input, mockChurchId, mockUserId, viewer),
        ).rejects.toThrow('You can only record giving');
        await expect(
          service.recordCashGiving(input, mockChurchId, mockUserId, viewer),
        ).rejects.toThrow('You can only record giving');
        expect(model('transaction').create).not.toHaveBeenCalled();
      },
    );

    it('cannot record against another leader group', async () => {
      model('cellGroup').findFirst.mockResolvedValue(null);
      await expect(
        service.recordCellGroupGiving(
          groupId,
          {
            categoryId: mockCategoryId,
            amount: 10000,
            type: 'cash',
            cellGroupMeetingDate: '2026-10-11',
          },
          mockChurchId,
          mockUserId,
          leader,
        ),
      ).rejects.toThrow('Cell group not found');
      expect(model('transaction').create).not.toHaveBeenCalled();
    });

    it('requires a real meeting date', async () => {
      model('cellGroup').findFirst.mockResolvedValue(group);
      await expect(
        service.recordCellGroupGiving(
          groupId,
          {
            categoryId: mockCategoryId,
            amount: 10000,
            type: 'cash',
            cellGroupMeetingDate: '2026-02-30',
          },
          mockChurchId,
          mockUserId,
          leader,
        ),
      ).rejects.toThrow('A valid meeting date');
      expect(model('transaction').create).not.toHaveBeenCalled();
    });

    it('rejects individual member assignment for a meeting total', async () => {
      model('cellGroup').findFirst.mockResolvedValue(group);
      await expect(
        service.recordCellGroupGiving(
          groupId,
          {
            categoryId: mockCategoryId,
            amount: 10000,
            type: 'cash',
            memberId: mockMemberId,
            cellGroupMeetingDate: '2026-10-11',
          },
          mockChurchId,
          mockUserId,
          leader,
        ),
      ).rejects.toThrow('Record a group total');
      await expect(
        service.recordCashGiving(
          {
            categoryId: mockCategoryId,
            amount: 10000,
            type: 'cash',
            cellGroupId: groupId,
            memberId: mockMemberId,
            cellGroupMeetingDate: '2026-10-11',
          },
          mockChurchId,
          mockUserId,
          leader,
        ),
      ).rejects.toThrow('Record a group total');
      expect(model('transaction').create).not.toHaveBeenCalled();
    });

    it('converts a concurrent duplicate into a clear meeting conflict', async () => {
      model('cellGroup').findFirst.mockResolvedValue(group);
      model('branch').findFirst.mockResolvedValue({ id: mockBranchId });
      model('givingCategory').findUnique.mockResolvedValue(mockCategory);
      model('transaction').count.mockResolvedValue(0);
      model('transaction').create.mockRejectedValue({ code: 'P2002' });
      await expect(
        service.recordCellGroupGiving(
          groupId,
          {
            categoryId: mockCategoryId,
            amount: 10000,
            type: 'cash',
            cellGroupMeetingDate: '2026-10-11',
          },
          mockChurchId,
          mockUserId,
          leader,
        ),
      ).rejects.toThrow('Giving has already been recorded');
    });

    it('does not let a treasurer record group giving through the general endpoint', async () => {
      await expect(
        service.recordCashGiving(
          {
            categoryId: mockCategoryId,
            amount: 10000,
            type: 'cash',
            cellGroupId: groupId,
            cellGroupMeetingDate: '2026-10-11',
          },
          mockChurchId,
          mockUserId,
          {
            ...leader,
            role: 'treasurer',
            permissions: ['giving:records:create', 'cell_groups:giving:read'],
          },
        ),
      ).rejects.toThrow('Cell group giving recording is not permitted');
      expect(model('transaction').create).not.toHaveBeenCalled();
    });
    it('saves the branch of the recording treasurer when the payload omits it', async () => {
      model('branch').findFirst.mockResolvedValue({ id: mockBranchId });
      model('givingCategory').findUnique.mockResolvedValue(mockCategory);
      model('transaction').count.mockResolvedValue(0);
      model('transaction').create.mockResolvedValue({
        ...mockTransaction,
        branch_id: mockBranchId,
      });
      await service.recordCashGiving(
        { categoryId: mockCategoryId, amount: 5000, type: 'cash' },
        mockChurchId,
        mockUserId,
        { church_id: mockChurchId, role: 'treasurer', branch_id: mockBranchId },
      );
      expect(model('transaction').create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ branch_id: mockBranchId, status: 'success' }),
        }),
      );
    });

    it('requires HQ recorders to choose a branch', async () => {
      await expect(
        service.recordCashGiving(
          { categoryId: mockCategoryId, amount: 5000, type: 'cash' },
          mockChurchId,
          mockUserId,
          { church_id: mockChurchId, role: 'treasurer', is_admin_hq: true },
        ),
      ).rejects.toThrow('Select a branch');
      expect(model('transaction').create).not.toHaveBeenCalled();
    });

    it('rejects recording outside the treasurer branch', async () => {
      await expect(
        service.recordCashGiving(
          { categoryId: mockCategoryId, amount: 5000, type: 'cash', branchId: 'other' },
          mockChurchId,
          mockUserId,
          { church_id: mockChurchId, role: 'treasurer', branch_id: mockBranchId },
        ),
      ).rejects.toThrow('Giving must be recorded in your branch');
      expect(model('transaction').create).not.toHaveBeenCalled();
    });

    it('should record cash giving with manual gateway', async () => {
      model('givingCategory').findUnique.mockResolvedValue(mockCategory);
      model('transaction').count.mockResolvedValue(0);
      model('transaction').create.mockResolvedValue({
        ...mockTransaction,
        type: 'cash',
        status: 'success',
        payment_gateway: 'manual',
      });

      const result = await service.recordCashGiving(
        { categoryId: mockCategoryId, amount: 5000, type: 'cash' },
        mockChurchId,
        mockUserId,
      );

      expect(result.status).toBe('success');
      expect(result.type).toBe('cash');
    });

    it('should record bank transfer giving', async () => {
      model('givingCategory').findUnique.mockResolvedValue(mockCategory);
      model('transaction').count.mockResolvedValue(0);
      model('transaction').create.mockResolvedValue({
        ...mockTransaction,
        type: 'bank_transfer',
        status: 'success',
        payment_gateway: 'manual',
      });

      const result = await service.recordCashGiving(
        { categoryId: mockCategoryId, amount: 25000, type: 'bank_transfer' },
        mockChurchId,
        mockUserId,
      );

      expect(result.status).toBe('success');
    });

    it('should throw NotFoundException if category not found', async () => {
      model('givingCategory').findUnique.mockResolvedValue(null);

      await expect(
        service.recordCashGiving(
          { categoryId: 'nonexistent', amount: 1000, type: 'cash' },
          mockChurchId,
          mockUserId,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException if category is inactive', async () => {
      model('givingCategory').findUnique.mockResolvedValue({
        ...mockCategory,
        is_active: false,
      });

      await expect(
        service.recordCashGiving(
          { categoryId: mockCategoryId, amount: 1000, type: 'cash' },
          mockChurchId,
          mockUserId,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should persist service/event linkage when provided', async () => {
      const serviceId = 'f1f1f1f1-f1f1-f1f1-f1f1-f1f1f1f1f1f1';
      const eventId = 'e2e2e2e2-e2e2-e2e2-e2e2-e2e2e2e2e2e2';
      model('givingCategory').findUnique.mockResolvedValue(mockCategory);
      model('service').findFirst.mockResolvedValue({ id: serviceId });
      model('event').findFirst.mockResolvedValue({ id: eventId });
      model('transaction').count.mockResolvedValue(0);
      model('transaction').create.mockResolvedValue(mockTransaction);

      await service.recordCashGiving(
        {
          categoryId: mockCategoryId,
          amount: 5000,
          type: 'cash',
          serviceId,
          eventId,
        },
        mockChurchId,
        mockUserId,
      );

      expect(model('transaction').create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ service_id: serviceId, event_id: eventId }),
        }),
      );
    });

    it('should reject a linked service from another church', async () => {
      model('givingCategory').findUnique.mockResolvedValue(mockCategory);
      model('service').findFirst.mockResolvedValue(null);

      await expect(
        service.recordCashGiving(
          {
            categoryId: mockCategoryId,
            amount: 5000,
            type: 'cash',
            serviceId: 'f1f1f1f1-f1f1-f1f1-f1f1-f1f1f1f1f1f1',
          },
          mockChurchId,
          mockUserId,
        ),
      ).rejects.toThrow(NotFoundException);
      expect(model('transaction').create).not.toHaveBeenCalled();
    });
  });

  // ─── TRANSACTION QUERIES ─────────────────────────────────────────

  describe('listTransactions', () => {
    it('should return paginated transactions', async () => {
      model('transaction').findMany.mockResolvedValue([mockTransaction]);
      model('transaction').count.mockResolvedValue(1);

      const result = await service.listTransactions(mockChurchId, {});

      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
    });

    it('should scope a non-HQ viewer to their own branch', async () => {
      model('transaction').findMany.mockResolvedValue([]);
      model('transaction').count.mockResolvedValue(0);

      await service.listTransactions(
        mockChurchId,
        {},
        {
          church_id: mockChurchId,
          branch_id: 'branch-a',
          role: 'treasurer',
          is_admin_hq: false,
        },
      );

      expect(model('transaction').findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ branch_id: 'branch-a' }),
        }),
      );
    });

    it('should NOT branch-scope an admin-hq viewer', async () => {
      model('transaction').findMany.mockResolvedValue([]);
      model('transaction').count.mockResolvedValue(0);

      await service.listTransactions(
        mockChurchId,
        {},
        {
          church_id: mockChurchId,
          branch_id: 'branch-b',
          role: 'church_admin',
          is_admin_hq: true,
        },
      );

      const call = model('transaction').findMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
      };
      expect(call.where.branch_id).toBeUndefined();
    });

    it('should map member/service/event display names from includes', async () => {
      model('transaction').findMany.mockResolvedValue([
        {
          ...mockTransaction,
          member: { first_name: 'Chioma', last_name: 'Eze' },
          service: { name: 'Sunday First Service' },
          event: null,
        },
      ]);
      model('transaction').count.mockResolvedValue(1);

      const result = await service.listTransactions(mockChurchId, {});

      expect(result.data[0].memberName).toBe('Chioma Eze');
      expect(result.data[0].serviceName).toBe('Sunday First Service');
      expect(result.data[0].eventName).toBeUndefined();
    });

    it('should filter by linked service', async () => {
      model('transaction').findMany.mockResolvedValue([]);
      model('transaction').count.mockResolvedValue(0);
      const serviceId = 'f1f1f1f1-f1f1-f1f1-f1f1-f1f1f1f1f1f1';

      await service.listTransactions(mockChurchId, { serviceId });

      expect(model('transaction').findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ church_id: mockChurchId, service_id: serviceId }),
        }),
      );
    });

    it('should apply category filter', async () => {
      model('transaction').findMany.mockResolvedValue([]);
      model('transaction').count.mockResolvedValue(0);

      await service.listTransactions(mockChurchId, { categoryId: mockCategoryId });

      expect(model('transaction').findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ category_id: mockCategoryId }),
        }),
      );
    });

    it('should apply gateway filter', async () => {
      model('transaction').findMany.mockResolvedValue([]);
      model('transaction').count.mockResolvedValue(0);

      await service.listTransactions(mockChurchId, { gateway: 'flutterwave' });

      expect(model('transaction').findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ payment_gateway: 'flutterwave' }),
        }),
      );
    });

    it('should apply custom pagination', async () => {
      model('transaction').findMany.mockResolvedValue([]);
      model('transaction').count.mockResolvedValue(0);

      await service.listTransactions(mockChurchId, { page: 2, limit: 5 });

      expect(model('transaction').findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 5, take: 5 }),
      );
    });
  });

  describe('getTransactionsSummary', () => {
    const stubSummaryAggregates = (monthTotal: number, allTimeTotal: number, count: number) => {
      (model('transaction') as unknown as { aggregate: jest.Mock }).aggregate
        .mockResolvedValueOnce({ _sum: { amount: monthTotal }, _count: { _all: 2 } })
        .mockResolvedValueOnce({ _sum: { amount: allTimeTotal }, _count: { _all: count } });
    };

    const summaryWhereCalls = () => {
      const calls = [
        ...(model('transaction').aggregate as jest.Mock).mock.calls,
        ...model('transaction').findMany.mock.calls,
      ] as [Record<string, unknown>][];
      return calls.map((c) => c[0].where as Record<string, unknown>);
    };

    beforeEach(() => {
      (model('transaction') as unknown as { aggregate: jest.Mock }).aggregate = jest
        .fn()
        .mockResolvedValue({ _sum: { amount: 0 }, _count: { _all: 0 } });
    });

    it('should return month/all-time totals, count, and a 30-day zero-filled trend', async () => {
      stubSummaryAggregates(1500, 5000, 42);
      // Day-relative to the rolling 30-day window so the assertions hold on
      // any date: the gifts sit 10 days back (index 19), the window's first
      // day (index 0) must read zero.
      const midDay = new Date();
      midDay.setUTCHours(9, 0, 0, 0);
      midDay.setUTCDate(midDay.getUTCDate() - 10);
      const midKey = midDay.toISOString().slice(0, 10);
      const lateGift = new Date(midDay);
      lateGift.setUTCHours(18, 0, 0, 0);
      model('transaction').findMany.mockResolvedValue([
        { amount: 1000, giving_date: midDay },
        { amount: 500, giving_date: lateGift },
      ]);

      const result = await service.getTransactionsSummary(mockChurchId, {});

      expect(result.monthTotal).toBe(1500);
      expect(result.monthCount).toBe(2);
      expect(result.allTimeTotal).toBe(5000);
      expect(result.count).toBe(42);
      expect(result.trend).toHaveLength(30);
      expect(result.trend[0].total).toBe(0);
      expect(result.trend.find((p) => p.date === midKey)).toEqual({
        date: midKey,
        total: 1500,
      });
    });

    it('should default the status filter to success across all three queries', async () => {
      stubSummaryAggregates(0, 0, 0);
      model('transaction').findMany.mockResolvedValue([]);

      await service.getTransactionsSummary(mockChurchId, {});

      const wheres = summaryWhereCalls();
      expect(wheres).toHaveLength(3);
      for (const where of wheres) {
        expect(where.status).toBe('success');
        expect(where.church_id).toBe(mockChurchId);
      }
    });

    it('should honor an explicit status override', async () => {
      stubSummaryAggregates(0, 0, 0);
      model('transaction').findMany.mockResolvedValue([]);

      await service.getTransactionsSummary(mockChurchId, { status: 'failed' });

      for (const { status } of summaryWhereCalls()) {
        expect(status).toBe('failed');
      }
    });

    it('should propagate list filters into the aggregate where clauses', async () => {
      stubSummaryAggregates(0, 0, 0);
      model('transaction').findMany.mockResolvedValue([]);

      await service.getTransactionsSummary(mockChurchId, { categoryId: mockCategoryId });

      for (const where of summaryWhereCalls()) {
        expect(where.category_id).toBe(mockCategoryId);
      }
    });

    it('should scope the month window to the current calendar month', async () => {
      stubSummaryAggregates(0, 0, 0);
      model('transaction').findMany.mockResolvedValue([]);

      await service.getTransactionsSummary(mockChurchId, {});

      const monthWhere = (model('transaction').aggregate as jest.Mock).mock.calls[0][0].where as {
        giving_date: { gte: Date };
      };
      // The window must track the actual calendar month, not a frozen date —
      // an earlier hardcoded value broke the moment the month rolled over.
      const now = new Date();
      expect(monthWhere.giving_date.gte.toISOString()).toBe(
        new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
      );
    });

    it('should branch-scope a non-HQ viewer in every query', async () => {
      stubSummaryAggregates(0, 0, 0);
      model('transaction').findMany.mockResolvedValue([]);

      await service.getTransactionsSummary(
        mockChurchId,
        {},
        {
          church_id: mockChurchId,
          branch_id: 'branch-a',
          role: 'treasurer',
          is_admin_hq: false,
        },
      );

      for (const { branch_id } of summaryWhereCalls()) {
        expect(branch_id).toBe('branch-a');
      }
    });
  });

  describe('getTransactionById', () => {
    it('should return transaction by ID', async () => {
      model('transaction').findUnique.mockResolvedValue(mockTransaction);

      const result = await service.getTransactionById(mockTransactionId, mockChurchId);

      expect(result.transactionId).toBe(mockTransactionId);
    });

    it('should throw NotFoundException if not found', async () => {
      model('transaction').findUnique.mockResolvedValue(null);

      await expect(service.getTransactionById('nonexistent', mockChurchId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException if belongs to another church', async () => {
      model('transaction').findUnique.mockResolvedValue({
        ...mockTransaction,
        church_id: 'other-church',
      });

      await expect(service.getTransactionById(mockTransactionId, mockChurchId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ─── RECEIPTS ─────────────────────────────────────────────────────

  describe('generateReceipt', () => {
    it('passes saved dates, branch/source details and real references to the receipt', async () => {
      const recorded = new Date('2026-10-23T16:30:00Z');
      const given = new Date('2026-10-01T00:00:00Z');
      model('transaction').findUnique.mockResolvedValue({
        ...mockTransaction,
        giving_date: given,
        created_at: recorded,
        payment_method: null,
        type: 'bank_transfer',
        branch: { name: 'West Branch' },
        service: { name: 'Sunday Service' },
        notes: 'October giving',
        payment_reference: 'BANK-REFERENCE',
      });
      model('church').findUnique.mockResolvedValue({ name: 'Grace Church', address: 'Lagos' });
      model('member').findUnique.mockResolvedValue({
        first_name: 'Ada',
        last_name: 'Okafor',
        email: 'ada@example.org',
      });
      const result = await service.generateReceipt(mockTransactionId, mockChurchId);
      expect(result.filename).toBe('receipt-2026-TIT-0001.pdf');
      expect(receipt.generateReceipt).toHaveBeenCalledWith(
        expect.objectContaining({
          givingDate: given,
          createdAt: recorded,
          branchName: 'West Branch',
          source: 'Service: Sunday Service',
          memberName: 'Ada Okafor',
          paymentMethod: 'bank_transfer',
          paymentReference: 'BANK-REFERENCE',
          notes: 'October giving',
        }),
      );
      expect(model('member').findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: mockMemberId, church_id: mockChurchId } }),
      );
    });
    it('does not label a group collection as an anonymous donor', async () => {
      model('transaction').findUnique.mockResolvedValue({
        ...mockTransaction,
        member_id: null,
        metadata: { cellGroupName: 'Hope Group', cellGroupMeetingDate: '2026-10-01' },
      });
      model('church').findUnique.mockResolvedValue({ name: 'Grace Church' });
      await service.generateReceipt(mockTransactionId, mockChurchId);
      expect(receipt.generateReceipt).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'Cell group: Hope Group (meeting 2026-10-01)' }),
      );
    });
    it('does not claim a PDF was sent over WhatsApp when media delivery is unavailable', async () => {
      model('transaction').findUnique.mockResolvedValue(mockTransaction);
      await expect(
        service.sendReceipt(mockTransactionId, mockChurchId, 'whatsapp'),
      ).rejects.toThrow('WhatsApp PDF delivery is unavailable');
    });

    it('should generate a PDF receipt', async () => {
      model('transaction').findUnique.mockResolvedValue(mockTransaction);
      model('church').findUnique.mockResolvedValue({
        id: mockChurchId,
        name: 'Grace Community Church',
        address: '12 Allen Avenue',
        logo_url: 'https://storage.example.com/logo.webp',
      });
      model('member').findUnique.mockResolvedValue({
        id: mockMemberId,
        first_name: 'Adebayo',
        last_name: 'Ogundimu',
        email: 'adebayo@example.com',
      });

      const result = await service.generateReceipt(mockTransactionId, mockChurchId);

      expect(result.buffer).toBeInstanceOf(Buffer);
      expect(result.filename).toContain('receipt-');
      expect(receipt.generateReceipt).toHaveBeenCalledWith(
        expect.objectContaining({
          churchId: mockChurchId,
          churchName: 'Grace Community Church',
          churchLogoUrl: 'https://storage.example.com/logo.webp',
        }),
      );
    });

    it('should throw NotFoundException if transaction not found', async () => {
      model('transaction').findUnique.mockResolvedValue(null);

      await expect(service.generateReceipt('nonexistent', mockChurchId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw BadRequestException for non-successful transaction', async () => {
      model('transaction').findUnique.mockResolvedValue({
        ...mockTransaction,
        status: 'pending',
      });

      await expect(service.generateReceipt(mockTransactionId, mockChurchId)).rejects.toThrow(
        BadRequestException,
      );
    });
  });
  it('sends a church-branded receipt email and plain text with the original PDF attachment', async () => {
    model('transaction').findUnique.mockResolvedValue({
      ...mockTransaction,
      church: { name: 'Grace Church' },
    });
    model('member').findUnique.mockResolvedValue({ first_name: 'Ada', email: 'ada@example.org' });
    const buffer = Buffer.from('receipt-pdf');
    jest.spyOn(service, 'generateReceipt').mockResolvedValue({ buffer, filename: 'receipt.pdf' });
    await service.sendReceipt(mockTransactionId, mockChurchId, 'email');
    expect(receiptEmail).toHaveBeenCalledWith(
      'ada@example.org',
      'Your receipt from Grace Church',
      expect.stringContaining('https://churchos.example/brand/churchos-logo.png'),
      buffer,
      'receipt.pdf',
      mockChurchId,
      expect.stringContaining('Receipt number: 2026/TIT/0001'),
    );
    expect(model('transaction').findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        include: { category: true, church: { select: { name: true } } },
      }),
    );
  });
});
