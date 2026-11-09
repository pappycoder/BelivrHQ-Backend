import { RequestContextService } from '../../../src/common/services/request-context.service';
/**
 * @file assets.service.spec.ts
 * @description Unit tests for AssetsService.
 *
 * Tests asset categories, asset register, maintenance, depreciation,
 * loans, QR codes, and scan workflows.
 *
 * @module test/unit/assets/assets.service.spec
 * @since 1.0.0
 */

import { AssetsService } from '../../../src/assets/assets.service';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { AuditLoggingService } from '../../../src/common/services/audit-logging.service';
import { createPrismaMock } from '../../helpers/prisma-mock.helper';
import { BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import {
  AssetCondition,
  AssetStatus,
  DepreciationMethod,
  MaintenanceStatus,
  AssetLoanStatus,
} from '@prisma/client';

describe('AssetsService', () => {
  let service: AssetsService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let audit: { log: jest.Mock };

  const mockChurchId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const mockUserId = '11111111-1111-1111-1111-111111111111';
  const mockCategoryId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const mockAssetId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  const mockMemberId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

  const mockCategory = {
    id: mockCategoryId,
    church_id: mockChurchId,
    name: 'Sound Equipment',
    description: 'Audio devices',
    created_at: new Date('2026-07-20T10:00:00.000Z'),
    updated_at: new Date('2026-07-20T10:00:00.000Z'),
  };

  const mockAsset = {
    id: mockAssetId,
    church_id: mockChurchId,
    asset_tag: 'AUD-001',
    name: 'Yamaha Mixer',
    description: '16-channel mixer',
    category_id: mockCategoryId,
    serial_number: 'SN123',
    brand: 'Yamaha',
    model: 'MG16XU',
    department_id: null,
    branch_id: null,
    custodian_id: null,
    condition: AssetCondition.good,
    status: AssetStatus.active,
    purchase_date: new Date('2023-01-15'),
    purchase_price: 250000,
    salvage_value: 0,
    useful_life_years: 5,
    depreciation_method: DepreciationMethod.straight_line,
    current_value: 250000,
    location: 'Main Sanctuary',
    qr_code: `BELIVRHQ:ASSET:${mockAssetId}`,
    notes: null,
    created_at: new Date('2026-07-20T10:00:00.000Z'),
    updated_at: new Date('2026-07-20T10:00:00.000Z'),
    category: mockCategory,
    branch: null,
    department: null,
    custodian: null,
  };

  beforeEach(() => {
    prisma = createPrismaMock();
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    service = new AssetsService(
      prisma as unknown as PrismaService,
      new RequestContextService(),
      audit as unknown as AuditLoggingService,
    );
  });

  describe('operational worklists', () => {
    it('scopes both loan rows and counts to the tenant and branch', async () => {
      const context = { branchWhere: jest.fn().mockReturnValue({ branch_id: 'branch-a' }) };
      const scoped = new AssetsService(
        prisma as unknown as PrismaService,
        context as unknown as RequestContextService,
        audit as unknown as AuditLoggingService,
      );
      prisma.assetLoan.findMany.mockResolvedValue([]);
      prisma.assetLoan.count.mockResolvedValue(35);
      const result = await scoped.listLoanWorklist(mockChurchId, {
        page: 2,
        limit: 15,
        search: 'Mixer',
      });
      const rowArgs = prisma.assetLoan.findMany.mock.calls[0][0];
      expect(rowArgs.where.asset).toMatchObject({ church_id: mockChurchId, branch_id: 'branch-a' });
      expect(rowArgs.where.asset.OR).toContainEqual({
        name: { contains: 'Mixer', mode: 'insensitive' },
      });
      expect(rowArgs.skip).toBe(15);
      expect(rowArgs.take).toBe(15);
      expect(prisma.assetLoan.count).toHaveBeenCalledWith({ where: rowArgs.where });
      expect(result.meta).toEqual({ page: 2, limit: 15, total: 35, totalPages: 3 });
    });

    it('returns maintenance jobs and archived-equipment context rather than asset rows', async () => {
      const stamp = new Date('2026-10-27T12:00:00Z');
      prisma.assetMaintenance.findMany.mockResolvedValue([
        {
          id: 'job-a',
          asset_id: mockAssetId,
          type: 'Repair',
          status: 'scheduled',
          scheduled_date: stamp,
          created_at: stamp,
          updated_at: stamp,
          asset: { name: 'Mixer', asset_tag: 'AUD-001', archived_at: stamp },
        },
      ]);
      prisma.assetMaintenance.count.mockResolvedValue(1);
      const result = await service.listMaintenanceWorklist(mockChurchId, {});
      expect(result.data[0]).toMatchObject({
        id: 'job-a',
        assetId: mockAssetId,
        type: 'Repair',
        assetName: 'Mixer',
        assetTag: 'AUD-001',
        assetArchived: true,
        scheduledDate: stamp.toISOString(),
      });
      const rows = prisma.assetMaintenance.findMany.mock.calls[0][0];
      expect(rows.where.asset.church_id).toBe(mockChurchId);
      expect(prisma.assetMaintenance.count).toHaveBeenCalledWith({ where: rows.where });
    });

    it('finds overdue outstanding loans without including returned records', async () => {
      prisma.assetLoan.findMany.mockResolvedValue([]);
      prisma.assetLoan.count.mockResolvedValue(0);
      await service.listLoanWorklist(mockChurchId, { status: 'overdue' });
      const where = prisma.assetLoan.findMany.mock.calls[0][0].where;
      expect(where.OR).toEqual([
        { status: 'overdue' },
        { status: 'borrowed', expected_return_date: { lt: expect.any(Date) } },
      ]);
      expect(prisma.assetLoan.count).toHaveBeenCalledWith({ where });
    });

    it('rejects status filters belonging to the other worklist', async () => {
      await expect(
        service.listMaintenanceWorklist(mockChurchId, { status: 'returned' }),
      ).rejects.toThrow(BadRequestException);
      await expect(service.listLoanWorklist(mockChurchId, { status: 'completed' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('propagates a failed worklist read instead of returning an empty collection', async () => {
      prisma.assetLoan.findMany.mockRejectedValue(new Error('Database unavailable'));
      prisma.assetLoan.count.mockResolvedValue(0);
      await expect(service.listLoanWorklist(mockChurchId, {})).rejects.toThrow(
        'Database unavailable',
      );
    });
  });

  describe('createCategory', () => {
    it('should create an asset category', async () => {
      prisma.assetCategory.findUnique.mockResolvedValue(null);
      prisma.assetCategory.create.mockResolvedValue(mockCategory);

      const result = await service.createCategory(
        mockChurchId,
        { name: 'Sound Equipment', description: 'Audio devices' },
        mockUserId,
      );

      expect(result.name).toBe('Sound Equipment');
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'asset_category', action: 'CREATE' }),
      );
    });

    it('should throw BadRequestException if category name exists', async () => {
      prisma.assetCategory.findUnique.mockResolvedValue(mockCategory);

      await expect(
        service.createCategory(mockChurchId, { name: 'Sound Equipment' }, mockUserId),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('listCategories', () => {
    it('should return categories ordered by name', async () => {
      prisma.assetCategory.findMany.mockResolvedValue([mockCategory]);

      const result = await service.listCategories(mockChurchId);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(mockCategoryId);
    });

    it('should exclude archived categories from the default (active-only) list', async () => {
      prisma.assetCategory.findMany.mockResolvedValue([]);

      await service.listCategories(mockChurchId);

      expect(prisma.assetCategory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ church_id: mockChurchId, archived_at: null }),
        }),
      );
    });

    it('should list archived categories only when archived is true', async () => {
      prisma.assetCategory.findMany.mockResolvedValue([
        { ...mockCategory, archived_at: new Date('2026-07-25T10:00:00.000Z') },
      ]);

      const result = await service.listCategories(mockChurchId, true);

      expect(prisma.assetCategory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ archived_at: { not: null } }),
        }),
      );
      expect(result[0].archivedAt).toBeDefined();
    });
  });

  describe('archiveCategory', () => {
    it('should archive a category and audit the ARCHIVE action', async () => {
      prisma.assetCategory.findFirst.mockResolvedValue(mockCategory);
      prisma.assetCategory.update.mockResolvedValue({
        ...mockCategory,
        archived_at: new Date('2026-07-25T10:00:00.000Z'),
      });

      const result = await service.archiveCategory(mockChurchId, mockCategoryId, mockUserId);

      expect(result.archivedAt).toBeDefined();
      expect(prisma.assetCategory.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: mockCategoryId },
          data: expect.objectContaining({ archived_at: expect.any(Date) }),
        }),
      );
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'asset_category', action: 'ARCHIVE' }),
      );
    });

    it('should throw NotFoundException if category is missing or not in this church', async () => {
      prisma.assetCategory.findFirst.mockResolvedValue(null);

      await expect(
        service.archiveCategory(mockChurchId, mockCategoryId, mockUserId),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ConflictException if category is already archived', async () => {
      prisma.assetCategory.findFirst.mockResolvedValue({
        ...mockCategory,
        archived_at: new Date('2026-07-25T10:00:00.000Z'),
      });

      await expect(
        service.archiveCategory(mockChurchId, mockCategoryId, mockUserId),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('restoreCategory', () => {
    it('should restore an archived category and audit the RESTORE action', async () => {
      prisma.assetCategory.findFirst.mockResolvedValue({
        ...mockCategory,
        archived_at: new Date('2026-07-25T10:00:00.000Z'),
      });
      prisma.assetCategory.update.mockResolvedValue(mockCategory);

      const result = await service.restoreCategory(mockChurchId, mockCategoryId, mockUserId);

      expect(result.archivedAt).toBeUndefined();
      expect(prisma.assetCategory.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: mockCategoryId },
          data: expect.objectContaining({ archived_at: null }),
        }),
      );
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'asset_category', action: 'RESTORE' }),
      );
    });

    it('should throw NotFoundException if category is missing or not in this church', async () => {
      prisma.assetCategory.findFirst.mockResolvedValue(null);

      await expect(
        service.restoreCategory(mockChurchId, mockCategoryId, mockUserId),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ConflictException if category is not archived', async () => {
      prisma.assetCategory.findFirst.mockResolvedValue(mockCategory);

      await expect(
        service.restoreCategory(mockChurchId, mockCategoryId, mockUserId),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('createAsset', () => {
    it('should create an asset and generate QR code with asset ID', async () => {
      prisma.asset.findUnique.mockResolvedValue(null);
      prisma.assetCategory.findFirst.mockResolvedValue(mockCategory);
      prisma.asset.create
        .mockResolvedValueOnce({
          ...mockAsset,
          qr_code: null,
          image_url: 'https://img.example/mixer.jpg',
        })
        .mockResolvedValueOnce({
          ...mockAsset,
          image_url: 'https://img.example/mixer.jpg',
        });
      prisma.asset.update.mockResolvedValue({
        ...mockAsset,
        image_url: 'https://img.example/mixer.jpg',
      });

      const result = await service.createAsset(
        mockChurchId,
        {
          assetTag: 'AUD-001',
          name: 'Yamaha Mixer',
          categoryId: mockCategoryId,
          purchasePrice: 250000,
          usefulLifeYears: 5,
          imageUrl: 'https://img.example/mixer.jpg',
        },
        mockUserId,
      );

      expect(result.assetTag).toBe('AUD-001');
      expect(result.imageUrl).toBe('https://img.example/mixer.jpg');
      expect(result.qrCode).toBe(`BELIVRHQ:ASSET:${mockAssetId}`);
      expect(prisma.asset.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            image_url: 'https://img.example/mixer.jpg',
          }),
        }),
      );
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'asset', action: 'CREATE' }),
      );
    });

    it('should throw BadRequestException if asset tag exists', async () => {
      prisma.asset.findUnique.mockResolvedValue(mockAsset);

      await expect(
        service.createAsset(mockChurchId, { assetTag: 'AUD-001', name: 'Duplicate' }, mockUserId),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('listAssets', () => {
    it('should return paginated assets', async () => {
      prisma.asset.findMany.mockResolvedValue([mockAsset]);
      prisma.asset.count.mockResolvedValue(1);

      const result = await service.listAssets(mockChurchId, {});

      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.items[0].categoryName).toBe('Sound Equipment');
    });

    it('should apply status filter', async () => {
      prisma.asset.findMany.mockResolvedValue([]);
      prisma.asset.count.mockResolvedValue(0);

      await service.listAssets(mockChurchId, { status: AssetStatus.active });

      expect(prisma.asset.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: AssetStatus.active }),
        }),
      );
    });
  });

  describe('getAssetsSummary', () => {
    it('should return count and valuation totals from a single aggregate', async () => {
      prisma.asset.aggregate.mockResolvedValue({
        _count: { _all: 42 },
        _sum: { purchase_price: 12500000, current_value: 9800000 },
      });

      const result = await service.getAssetsSummary(mockChurchId);

      expect(result).toEqual({
        totalAssets: 42,
        totalPurchaseValue: 12500000,
        totalCurrentValue: 9800000,
      });
      expect(prisma.asset.aggregate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { church_id: mockChurchId, archived_at: null },
          _count: { _all: true },
          _sum: { purchase_price: true, current_value: true },
        }),
      );
    });

    it('should default null sums and counts to zero', async () => {
      prisma.asset.aggregate.mockResolvedValue({
        _count: { _all: 0 },
        _sum: { purchase_price: null, current_value: null },
      });

      const result = await service.getAssetsSummary(mockChurchId);

      expect(result).toEqual({
        totalAssets: 0,
        totalPurchaseValue: 0,
        totalCurrentValue: 0,
      });
    });
  });

  describe('getAsset', () => {
    it('should return asset by ID', async () => {
      prisma.asset.findFirst.mockResolvedValue(mockAsset);

      const result = await service.getAsset(mockChurchId, mockAssetId);

      expect(result.id).toBe(mockAssetId);
    });

    it('should throw NotFoundException if asset not found', async () => {
      prisma.asset.findFirst.mockResolvedValue(null);

      await expect(service.getAsset(mockChurchId, mockAssetId)).rejects.toThrow(NotFoundException);
    });
  });

  describe('deleteAsset', () => {
    it('should mark asset as disposed and clear QR code', async () => {
      prisma.asset.findFirst.mockResolvedValue(mockAsset);
      prisma.asset.update.mockResolvedValue({
        ...mockAsset,
        status: AssetStatus.disposed,
        qr_code: null,
      });

      await service.deleteAsset(mockChurchId, mockAssetId, mockUserId);

      expect(prisma.asset.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: AssetStatus.disposed,
            qr_code: null,
          }),
        }),
      );
    });
  });

  describe('generateQrCode', () => {
    it('should return BELIVRHQ:ASSET prefixed data', async () => {
      prisma.asset.findFirst.mockResolvedValue(mockAsset);
      prisma.asset.update.mockResolvedValue(mockAsset);

      const result = await service.generateQrCode(mockChurchId, mockAssetId);

      expect(result.qrData).toBe(`BELIVRHQ:ASSET:${mockAssetId}`);
    });
  });

  describe('archiveAsset', () => {
    it('should archive an asset and audit the ARCHIVE action', async () => {
      prisma.asset.findFirst.mockResolvedValue(mockAsset);
      prisma.asset.update.mockResolvedValue({
        ...mockAsset,
        archived_at: new Date('2026-07-25T10:00:00.000Z'),
      });

      const result = await service.archiveAsset(mockChurchId, mockAssetId, mockUserId);

      expect(result.archivedAt).toBeDefined();
      expect(prisma.asset.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: mockAssetId },
          data: expect.objectContaining({ archived_at: expect.any(Date) }),
        }),
      );
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'asset', action: 'ARCHIVE' }),
      );
    });

    it('should throw NotFoundException if asset is missing or not in this church', async () => {
      prisma.asset.findFirst.mockResolvedValue(null);

      await expect(service.archiveAsset(mockChurchId, mockAssetId, mockUserId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw ConflictException if asset is already archived', async () => {
      prisma.asset.findFirst.mockResolvedValue({
        ...mockAsset,
        archived_at: new Date('2026-07-25T10:00:00.000Z'),
      });

      await expect(service.archiveAsset(mockChurchId, mockAssetId, mockUserId)).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('restoreAsset', () => {
    it('should restore an archived asset and audit the RESTORE action', async () => {
      prisma.asset.findFirst.mockResolvedValue({
        ...mockAsset,
        archived_at: new Date('2026-07-25T10:00:00.000Z'),
      });
      prisma.asset.update.mockResolvedValue(mockAsset);

      const result = await service.restoreAsset(mockChurchId, mockAssetId, mockUserId);

      expect(result.archivedAt).toBeUndefined();
      expect(prisma.asset.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: mockAssetId },
          data: expect.objectContaining({ archived_at: null }),
        }),
      );
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'asset', action: 'RESTORE' }),
      );
    });

    it('should throw NotFoundException if asset is missing or not in this church', async () => {
      prisma.asset.findFirst.mockResolvedValue(null);

      await expect(service.restoreAsset(mockChurchId, mockAssetId, mockUserId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw ConflictException if asset is not archived', async () => {
      prisma.asset.findFirst.mockResolvedValue(mockAsset);

      await expect(service.restoreAsset(mockChurchId, mockAssetId, mockUserId)).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('scanAsset', () => {
    it('should find asset by QR code and log scan', async () => {
      prisma.asset.findFirst.mockResolvedValue(mockAsset);
      prisma.assetScanLog.create.mockResolvedValue({
        id: 'scan-1',
        asset_id: mockAssetId,
        scanned_by_id: mockUserId,
        scan_type: 'check',
        metadata: {},
        created_at: new Date(),
      });
      prisma.assetLoan.findFirst.mockResolvedValue(null);
      prisma.assetMaintenance.findFirst.mockResolvedValue(null);

      const result = await service.scanAsset(
        mockChurchId,
        { qrData: `BELIVRHQ:ASSET:${mockAssetId}` },
        mockUserId,
      );

      expect(result.asset.id).toBe(mockAssetId);
      expect(result.scanLog.scanType).toBe('check');
    });

    it('should find asset by asset tag', async () => {
      prisma.asset.findUnique.mockResolvedValue({ id: mockAssetId });
      prisma.asset.findFirst.mockResolvedValue(mockAsset);
      prisma.assetScanLog.create.mockResolvedValue({
        id: 'scan-1',
        asset_id: mockAssetId,
        scanned_by_id: null,
        scan_type: 'check',
        metadata: {},
        created_at: new Date(),
      });
      prisma.assetLoan.findFirst.mockResolvedValue(null);
      prisma.assetMaintenance.findFirst.mockResolvedValue(null);

      const result = await service.scanAsset(mockChurchId, { assetTag: 'AUD-001' });

      expect(result.asset.id).toBe(mockAssetId);
    });

    it('should throw BadRequestException for invalid QR format', async () => {
      await expect(service.scanAsset(mockChurchId, { qrData: 'INVALID' })).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('createMaintenance', () => {
    it('should create a maintenance record', async () => {
      prisma.asset.findFirst.mockResolvedValue(mockAsset);
      prisma.assetMaintenance.create.mockResolvedValue({
        id: 'maint-1',
        asset_id: mockAssetId,
        type: 'Routine service',
        description: null,
        status: MaintenanceStatus.scheduled,
        scheduled_date: new Date('2026-08-01'),
        completed_date: null,
        cost: null,
        performed_by: null,
        notes: null,
        created_at: new Date(),
        updated_at: new Date(),
      });

      const result = await service.createMaintenance(
        mockChurchId,
        mockAssetId,
        { type: 'Routine service', scheduledDate: '2026-08-01' },
        mockUserId,
      );

      expect(result.type).toBe('Routine service');
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'asset_maintenance', action: 'CREATE' }),
      );
    });
  });

  describe('createDepreciation', () => {
    it('should calculate straight-line depreciation', async () => {
      prisma.asset.findFirst.mockResolvedValue({
        ...mockAsset,
        depreciation: [],
      });
      prisma.assetDepreciation.findUnique.mockResolvedValue(null);
      prisma.assetDepreciation.create.mockResolvedValue({
        id: 'dep-1',
        asset_id: mockAssetId,
        year: new Date().getFullYear(),
        opening_value: 250000,
        depreciation_amount: 50000,
        closing_value: 200000,
        created_at: new Date(),
      });
      prisma.asset.update.mockResolvedValue(mockAsset);

      const result = await service.createDepreciation(mockChurchId, mockAssetId, mockUserId);

      expect(result.depreciationAmount).toBe(50000);
      expect(result.closingValue).toBe(200000);
    });

    it('should throw BadRequestException if asset lacks purchase price', async () => {
      prisma.asset.findFirst.mockResolvedValue({
        ...mockAsset,
        purchase_price: null,
      });

      await expect(
        service.createDepreciation(mockChurchId, mockAssetId, mockUserId),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('createLoan', () => {
    it('should create a loan for an asset', async () => {
      prisma.asset.findFirst.mockResolvedValue(mockAsset);
      prisma.assetLoan.findFirst.mockResolvedValue(null);
      prisma.member.findFirst.mockResolvedValue({ id: mockMemberId });
      prisma.assetLoan.create.mockResolvedValue({
        id: 'loan-1',
        asset_id: mockAssetId,
        borrower_member_id: mockMemberId,
        borrowed_by_name: null,
        loan_date: new Date(),
        expected_return_date: new Date('2026-08-15'),
        actual_return_date: null,
        status: AssetLoanStatus.borrowed,
        condition_before: AssetCondition.good,
        condition_after: null,
        notes: null,
        created_at: new Date(),
        updated_at: new Date(),
        member: { first_name: 'John', last_name: 'Doe' },
      });
      prisma.asset.update.mockResolvedValue(mockAsset);

      const result = await service.createLoan(
        mockChurchId,
        mockAssetId,
        { borrowerMemberId: mockMemberId, expectedReturnDate: '2026-08-15' },
        mockUserId,
      );

      expect(result.status).toBe(AssetLoanStatus.borrowed);
      expect(result.borrowerName).toBe('John Doe');
    });

    it('should throw BadRequestException if asset is already on loan', async () => {
      prisma.asset.findFirst.mockResolvedValue(mockAsset);
      prisma.assetLoan.findFirst.mockResolvedValue({ id: 'loan-1' });

      await expect(
        service.createLoan(
          mockChurchId,
          mockAssetId,
          { borrowedByName: 'Vendor', expectedReturnDate: '2026-08-15' },
          mockUserId,
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('returnLoan', () => {
    it('should record asset return and activate asset', async () => {
      prisma.asset.findFirst.mockResolvedValue(mockAsset);
      prisma.assetLoan.findFirst.mockResolvedValue({
        id: 'loan-1',
        asset_id: mockAssetId,
        borrower_member_id: null,
        borrowed_by_name: 'Vendor',
        loan_date: new Date(),
        expected_return_date: new Date('2026-08-15'),
        actual_return_date: null,
        status: AssetLoanStatus.borrowed,
        condition_before: null,
        condition_after: null,
        notes: null,
        created_at: new Date(),
        updated_at: new Date(),
        member: null,
      });
      prisma.assetLoan.update.mockResolvedValue({
        id: 'loan-1',
        asset_id: mockAssetId,
        borrower_member_id: null,
        borrowed_by_name: 'Vendor',
        loan_date: new Date(),
        expected_return_date: new Date('2026-08-15'),
        actual_return_date: new Date(),
        status: AssetLoanStatus.returned,
        condition_before: null,
        condition_after: AssetCondition.good,
        notes: null,
        created_at: new Date(),
        updated_at: new Date(),
        member: null,
      });
      prisma.asset.update.mockResolvedValue(mockAsset);

      const result = await service.returnLoan(
        mockChurchId,
        mockAssetId,
        'loan-1',
        { conditionAfter: AssetCondition.good },
        mockUserId,
      );

      expect(result.status).toBe(AssetLoanStatus.returned);
      expect(result.conditionAfter).toBe(AssetCondition.good);
    });

    it('should throw NotFoundException when returning a loan against an archived asset', async () => {
      prisma.asset.findFirst.mockResolvedValue({
        ...mockAsset,
        archived_at: new Date('2026-07-25T10:00:00.000Z'),
      });

      await expect(
        service.returnLoan(
          mockChurchId,
          mockAssetId,
          'loan-1',
          { conditionAfter: AssetCondition.good },
          mockUserId,
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
