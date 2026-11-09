import { RequestContextService } from '../../../src/common/services/request-context.service';
/**
 * @file recurring-giving.service.spec.ts
 * @description Unit tests for recurring giving methods in GivingService.
 *
 * Tests create, list, get, cancel, processCharge, and authorization code capture.
 *
 * @module test/unit/giving/recurring-giving.service.spec
 * @since 1.0.0
 */

import { GivingService } from '../../../src/giving/giving.service';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { AuditLoggingService } from '../../../src/common/services/audit-logging.service';
import { BranchScopeService } from '../../../src/common/services/branch-scope.service';
import { PaymentGatewayProvider } from '../../../src/giving/services/payment-gateway.interface';
import { ReceiptService } from '../../../src/giving/services/receipt.service';
import { NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';

describe('GivingService - Recurring Giving', () => {
  let service: GivingService;
  let prisma: Record<string, unknown> & { $transaction: jest.Mock };
  let audit: { log: jest.Mock };
  let paystack: Record<string, jest.Mock>;
  let gatewayRegistry: Map<string, PaymentGatewayProvider>;
  let receipt: Record<string, jest.Mock>;
  let paymentAccounts: {
    defaultGateway: jest.Mock;
    current: jest.Mock;
    historical: jest.Mock;
  };

  const mockUserId = '11111111-1111-1111-1111-111111111111';
  const mockChurchId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const mockCategoryId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const mockRecurringId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
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

  const mockCategory = {
    id: mockCategoryId,
    church_id: mockChurchId,
    name: 'Tithe',
    description: 'Regular tithe',
    display_order: 1,
    is_recurring: true,
    is_active: true,
    created_at: new Date('2026-07-01T10:00:00.000Z'),
    updated_at: new Date('2026-07-01T10:00:00.000Z'),
  };

  const mockRecurring = {
    id: mockRecurringId,
    church_id: mockChurchId,
    member_id: mockMemberId,
    category_id: mockCategoryId,
    amount: 5000,
    currency: 'NGN',
    frequency: 'monthly',
    payment_reference: null,
    authorization_code: 'AUTH_xxx',
    integration_account_id: 'church-payment-account',
    is_active: true,
    next_charge_date: new Date('2026-08-20T10:00:00.000Z'),
    last_charge_date: null,
    failed_attempt_count: 0,
    created_at: new Date('2026-07-20T10:00:00.000Z'),
    updated_at: new Date('2026-07-20T10:00:00.000Z'),
  };

  beforeEach(() => {
    prisma = createPrismaMock();
    audit = { log: jest.fn().mockResolvedValue(undefined) };

    paystack = {
      isConfigured: jest.fn().mockReturnValue(true),
      initializeTransaction: jest.fn(),
      verifyTransaction: jest
        .fn()
        .mockResolvedValue({ amount: 5000, currency: 'NGN', status: 'success' }),
      validateWebhookSignature: jest.fn().mockReturnValue(true),
      parseWebhookEvent: jest.fn(),
      mapChannelToPaymentMethod: jest.fn().mockReturnValue('card'),
      mapEventToStatus: jest.fn(),
      chargeAuthorization: jest.fn(),
    };

    gatewayRegistry = new Map([['paystack', paystack as unknown as PaymentGatewayProvider]]);

    receipt = {
      generateReceipt: jest.fn().mockResolvedValue(Buffer.from('pdf')),
      getCategoryPrefix: jest.fn().mockReturnValue('TIT'),
      generateReceiptNumber: jest.fn().mockReturnValue('2026/TIT/0001'),
    };

    paymentAccounts = {
      defaultGateway: jest.fn().mockResolvedValue('paystack'),
      current: jest.fn().mockImplementation(async () => ({
        provider: paystack,
        accountId: 'church-payment-account',
      })),
      historical: jest.fn().mockImplementation(async () => paystack),
    };

    service = new GivingService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditLoggingService,
      gatewayRegistry,
      receipt as unknown as ReceiptService,
      {
        createNotification: jest.fn().mockResolvedValue({}),
        broadcastToChurch: jest.fn().mockResolvedValue({ sent: 0 }),
      } as never,
      new BranchScopeService(new RequestContextService()),
      {
        notify: jest.fn().mockResolvedValue(undefined),
      } as never,
      paymentAccounts as never,
    );
  });

  describe('createRecurringGiving', () => {
    it('rejects with setup guidance when the church has no payment provider', async () => {
      paymentAccounts.defaultGateway.mockResolvedValue(null);

      await expect(
        service.createRecurringGiving(
          {
            categoryId: mockCategoryId,
            amount: 5000,
            frequency: 'monthly',
            email: 'test@example.com',
            memberId: mockMemberId,
          },
          mockChurchId,
          mockUserId,
        ),
      ).rejects.toThrow('has no payment provider yet');
      expect(model('recurringGiving').create).not.toHaveBeenCalled();
    });

    it('explains the Paystack requirement when the church pays through another gateway', async () => {
      paymentAccounts.defaultGateway.mockResolvedValue('flutterwave');

      await expect(
        service.createRecurringGiving(
          {
            categoryId: mockCategoryId,
            amount: 5000,
            frequency: 'monthly',
            email: 'test@example.com',
            memberId: mockMemberId,
          },
          mockChurchId,
          mockUserId,
        ),
      ).rejects.toThrow('charge through Paystack');
      expect(model('recurringGiving').create).not.toHaveBeenCalled();
    });

    it('allows a treasurer to create a schedule for a member in their branch', async () => {
      model('givingCategory').findUnique.mockResolvedValue(mockCategory);
      model('member').findFirst.mockResolvedValue({ id: mockMemberId, branch_id: 'lekki' });
      model('recurringGiving').findFirst.mockResolvedValue(null);
      model('recurringGiving').create.mockResolvedValue(mockRecurring);
      await service.createRecurringGiving(
        {
          categoryId: mockCategoryId,
          memberId: mockMemberId,
          amount: 5000,
          frequency: 'monthly',
          email: 'test@example.com',
        },
        mockChurchId,
        mockUserId,
        { church_id: mockChurchId, role: 'treasurer', branch_id: 'lekki' },
      );
      expect(model('recurringGiving').create).toHaveBeenCalled();
    });

    it('rejects a member from another branch', async () => {
      model('givingCategory').findUnique.mockResolvedValue(mockCategory);
      model('member').findFirst.mockResolvedValue({ id: mockMemberId, branch_id: 'hq' });
      await expect(
        service.createRecurringGiving(
          {
            categoryId: mockCategoryId,
            memberId: mockMemberId,
            amount: 5000,
            frequency: 'monthly',
            email: 'test@example.com',
          },
          mockChurchId,
          mockUserId,
          { church_id: mockChurchId, role: 'treasurer', branch_id: 'lekki' },
        ),
      ).rejects.toThrow('Member belongs to another branch');
      expect(model('recurringGiving').create).not.toHaveBeenCalled();
    });

    it('checks the selected branch for an HQ treasurer', async () => {
      model('givingCategory').findUnique.mockResolvedValue(mockCategory);
      model('member').findFirst.mockResolvedValue({ id: mockMemberId, branch_id: 'hq' });
      await expect(
        service.createRecurringGiving(
          {
            branchId: 'lekki',
            categoryId: mockCategoryId,
            memberId: mockMemberId,
            amount: 5000,
            frequency: 'monthly',
            email: 'test@example.com',
          },
          mockChurchId,
          mockUserId,
          { church_id: mockChurchId, role: 'treasurer', is_admin_hq: true },
        ),
      ).rejects.toThrow('Member belongs to another branch');
    });

    it('should create a recurring giving schedule', async () => {
      model('givingCategory').findUnique.mockResolvedValue(mockCategory);
      model('member').findFirst.mockResolvedValue({ id: mockMemberId });
      model('recurringGiving').findFirst.mockResolvedValue(null);
      model('recurringGiving').create.mockResolvedValue(mockRecurring);

      const result = await service.createRecurringGiving(
        {
          categoryId: mockCategoryId,
          amount: 5000,
          frequency: 'monthly',
          email: 'test@example.com',
          memberId: mockMemberId,
        },
        mockChurchId,
        mockUserId,
      );

      expect(result.frequency).toBe('monthly');
      expect(result.amount).toBe(5000);
      expect(result.isActive).toBe(true);
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'recurring_giving', action: 'CREATE' }),
      );
    });

    it('should throw NotFoundException if category not found', async () => {
      model('givingCategory').findUnique.mockResolvedValue(null);

      await expect(
        service.createRecurringGiving(
          {
            categoryId: 'nonexistent',
            amount: 5000,
            frequency: 'monthly',
            email: 'test@example.com',
          },
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
        service.createRecurringGiving(
          {
            categoryId: mockCategoryId,
            amount: 5000,
            frequency: 'monthly',
            email: 'test@example.com',
          },
          mockChurchId,
          mockUserId,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if category does not support recurring', async () => {
      model('givingCategory').findUnique.mockResolvedValue({
        ...mockCategory,
        is_recurring: false,
      });

      await expect(
        service.createRecurringGiving(
          {
            categoryId: mockCategoryId,
            amount: 5000,
            frequency: 'monthly',
            email: 'test@example.com',
          },
          mockChurchId,
          mockUserId,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw ConflictException if active recurring already exists', async () => {
      model('givingCategory').findUnique.mockResolvedValue(mockCategory);
      model('member').findFirst.mockResolvedValue({ id: mockMemberId });
      model('recurringGiving').findFirst.mockResolvedValue(mockRecurring);

      await expect(
        service.createRecurringGiving(
          {
            categoryId: mockCategoryId,
            amount: 5000,
            frequency: 'monthly',
            email: 'test@example.com',
            memberId: mockMemberId,
          },
          mockChurchId,
          mockUserId,
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('should reject a member from another church', async () => {
      model('givingCategory').findUnique.mockResolvedValue(mockCategory);
      model('member').findFirst.mockResolvedValue(null);

      await expect(
        service.createRecurringGiving(
          {
            categoryId: mockCategoryId,
            amount: 5000,
            frequency: 'monthly',
            email: 'test@example.com',
            memberId: mockMemberId,
          },
          mockChurchId,
          mockUserId,
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('listRecurringGiving', () => {
    it('should return paginated recurring givings', async () => {
      model('recurringGiving').findMany.mockResolvedValue([mockRecurring]);
      model('recurringGiving').count.mockResolvedValue(1);
      model('givingCategory').findMany.mockResolvedValue([mockCategory]);

      const result = await service.listRecurringGiving(mockChurchId, {});

      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.data[0].categoryName).toBe('Tithe');
    });

    it('should filter by isActive', async () => {
      model('recurringGiving').findMany.mockResolvedValue([]);
      model('recurringGiving').count.mockResolvedValue(0);
      model('givingCategory').findMany.mockResolvedValue([]);

      await service.listRecurringGiving(mockChurchId, { isActive: false });

      expect(model('recurringGiving').findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ is_active: false }),
        }),
      );
    });
  });

  describe('getRecurringGivingById', () => {
    it.each(['get', 'pause', 'resume', 'cancel'])(
      'blocks cross-branch schedule %s access',
      async (action) => {
        model('recurringGiving').findUnique.mockResolvedValue(mockRecurring);
        model('member').findFirst.mockResolvedValue(null);
        const viewer = { church_id: mockChurchId, role: 'treasurer', branch_id: 'lekki' };
        const call =
          action === 'get'
            ? service.getRecurringGivingById(mockRecurringId, mockChurchId, viewer)
            : action === 'pause'
              ? service.pauseRecurringGiving(mockRecurringId, mockChurchId, mockUserId, viewer)
              : action === 'resume'
                ? service.resumeRecurringGiving(mockRecurringId, mockChurchId, mockUserId, viewer)
                : service.cancelRecurringGiving(mockRecurringId, mockChurchId, mockUserId, viewer);
        await expect(call).rejects.toThrow('Recurring giving not found');
        expect(model('recurringGiving').update).not.toHaveBeenCalled();
      },
    );
    it('should return recurring giving by ID', async () => {
      model('recurringGiving').findUnique.mockResolvedValue(mockRecurring);
      model('givingCategory').findUnique.mockResolvedValue(mockCategory);

      const result = await service.getRecurringGivingById(mockRecurringId, mockChurchId);

      expect(result.id).toBe(mockRecurringId);
      expect(result.categoryName).toBe('Tithe');
    });

    it('should throw NotFoundException if not found', async () => {
      model('recurringGiving').findUnique.mockResolvedValue(null);

      await expect(service.getRecurringGivingById('nonexistent', mockChurchId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException if belongs to another church', async () => {
      model('recurringGiving').findUnique.mockResolvedValue({
        ...mockRecurring,
        church_id: 'other-church',
      });

      await expect(service.getRecurringGivingById(mockRecurringId, mockChurchId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('cancelRecurringGiving', () => {
    it('can permanently cancel a paused schedule', async () => {
      model('recurringGiving').findUnique.mockResolvedValue({
        ...mockRecurring,
        is_active: false,
        paused_at: new Date(),
      });
      model('recurringGiving').update.mockResolvedValue({
        ...mockRecurring,
        is_active: false,
        paused_at: null,
      });
      await service.cancelRecurringGiving(mockRecurringId, mockChurchId, mockUserId);
      expect(model('recurringGiving').update).toHaveBeenCalledWith({
        where: { id: mockRecurringId },
        data: { is_active: false, paused_at: null },
      });
    });
    it('should cancel an active recurring giving', async () => {
      model('recurringGiving').findUnique.mockResolvedValue(mockRecurring);
      model('recurringGiving').update.mockResolvedValue({});

      await service.cancelRecurringGiving(mockRecurringId, mockChurchId, mockUserId);

      expect(model('recurringGiving').update).toHaveBeenCalledWith({
        where: { id: mockRecurringId },
        data: { is_active: false, paused_at: null },
      });
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'recurring_giving', action: 'UPDATE' }),
      );
    });

    it('should throw NotFoundException if not found', async () => {
      model('recurringGiving').findUnique.mockResolvedValue(null);

      await expect(
        service.cancelRecurringGiving('nonexistent', mockChurchId, mockUserId),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException if already cancelled', async () => {
      model('recurringGiving').findUnique.mockResolvedValue({
        ...mockRecurring,
        is_active: false,
      });

      await expect(
        service.cancelRecurringGiving(mockRecurringId, mockChurchId, mockUserId),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('processRecurringCharge', () => {
    it('should process a successful recurring charge', async () => {
      model('recurringGiving').findUnique.mockResolvedValue(mockRecurring);
      paystack.chargeAuthorization.mockResolvedValue({
        success: true,
        reference: 'RCHG123',
        amount: 5000,
        paidAt: '2026-08-20T10:00:00.000Z',
        channel: 'card',
      });
      model('transaction').create.mockResolvedValue({});
      model('recurringGiving').update.mockResolvedValue({});

      const result = await service.processRecurringCharge(mockRecurringId, mockChurchId);

      expect(result).toBe(true);
      expect(paystack.chargeAuthorization).toHaveBeenCalledWith(
        'AUTH_xxx',
        5000,
        'NGN',
        expect.objectContaining({ recurring_giving_id: mockRecurringId }),
      );
    });

    it('should return false if recurring giving not found', async () => {
      model('recurringGiving').findUnique.mockResolvedValue(null);

      const result = await service.processRecurringCharge('nonexistent', mockChurchId);

      expect(result).toBe(false);
    });

    it('should return false if recurring giving is inactive', async () => {
      model('recurringGiving').findUnique.mockResolvedValue({
        ...mockRecurring,
        is_active: false,
      });

      const result = await service.processRecurringCharge(mockRecurringId, mockChurchId);

      expect(result).toBe(false);
    });

    it('should return false if no authorization code', async () => {
      model('recurringGiving').findUnique.mockResolvedValue({
        ...mockRecurring,
        authorization_code: null,
      });

      const result = await service.processRecurringCharge(mockRecurringId, mockChurchId);

      expect(result).toBe(false);
    });

    it('should handle failed charge and increment attempt count', async () => {
      model('recurringGiving').findUnique.mockResolvedValue(mockRecurring);
      paystack.chargeAuthorization.mockResolvedValue({
        success: false,
        reference: 'RCHG456',
        amount: 5000,
      });
      model('transaction').create.mockResolvedValue({});
      model('recurringGiving').update.mockResolvedValue({});

      const result = await service.processRecurringCharge(mockRecurringId, mockChurchId);

      expect(result).toBe(false);
      expect(model('recurringGiving').update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ failed_attempt_count: 1 }),
        }),
      );
    });

    it('should deactivate after 3 consecutive failures', async () => {
      model('recurringGiving').findUnique.mockResolvedValue({
        ...mockRecurring,
        failed_attempt_count: 2,
      });
      paystack.chargeAuthorization.mockRejectedValue(new Error('Network error'));
      model('recurringGiving').update.mockResolvedValue({});

      const result = await service.processRecurringCharge(mockRecurringId, mockChurchId);

      expect(result).toBe(false);
      expect(model('recurringGiving').update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            failed_attempt_count: 3,
            is_active: false,
          }),
        }),
      );
    });
  });

  describe('captureAuthorizationCode (via webhook)', () => {
    it('should capture authorization code on charge.success webhook', async () => {
      paystack.parseWebhookEvent.mockReturnValue({
        event: 'charge.success',
        reference: 'TITHSEED123abc',
        channel: 'card',
        authorizationCode: 'AUTH_captured',
      });
      paystack.mapEventToStatus.mockReturnValue('success');

      const pendingTransaction = {
        id: 'tx-1',
        church_id: mockChurchId,
        member_id: mockMemberId,
        category_id: mockCategoryId,
        amount: 5000,
        currency: 'NGN',
        type: 'digital',
        status: 'pending',
        payment_reference: 'TITHSEED123abc',
        payment_gateway: 'paystack',
        payment_method: null,
        receipt_number: null,
        receipt_url: null,
        notes: null,
        created_at: new Date(),
        updated_at: new Date(),
        category: { name: 'Tithe' },
      };

      model('transaction').findFirst.mockResolvedValue(pendingTransaction);
      model('transaction').findMany.mockResolvedValue([pendingTransaction]);
      model('transaction').findFirstOrThrow.mockResolvedValue(pendingTransaction);
      model('transaction').updateMany.mockImplementation(async () => {
        model('transaction').findFirst.mockResolvedValue({
          ...pendingTransaction,
          status: 'success',
        });
        return { count: 1 };
      });
      prisma.$transaction.mockImplementation((fn: (tx: typeof prisma) => unknown) => fn(prisma));
      paystack.verifyTransaction.mockResolvedValue({
        reference: 'TITHSEED123abc',
        currency: 'NGN',
        amount: 5000,
        status: 'success',
        channel: 'card',
      });

      model('transaction').update.mockResolvedValue({});
      model('recurringGiving').findFirst.mockResolvedValue(mockRecurring);
      model('recurringGiving').update.mockResolvedValue({});

      const result = await service.handleWebhook(
        JSON.stringify({ event: 'charge.success', data: {} }),
        'valid-sig',
        'paystack',
      );

      expect(result.processed).toBe(true);
      expect(model('recurringGiving').update).toHaveBeenCalledWith({
        where: { id: mockRecurringId },
        data: { authorization_code: 'AUTH_captured' },
      });
    });
  });
});
