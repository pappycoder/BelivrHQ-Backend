import { ASSET_QR } from '../brand/brand';
import { ListAssetWorklistDto } from './dto/list-asset-worklist.dto';
import { RequestContextService } from '../common/services/request-context.service';
/**
 * @file assets.service.ts
 * @description Service for asset and inventory management.
 *
 * Provides CRUD for asset categories, asset register, maintenance scheduling,
 * depreciation tracking, asset loans, QR code generation, and scan workflows.
 *
 * @module assets/assets.service
 * @since 1.0.0
 */

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Asset,
  AssetCategory,
  AssetCondition,
  AssetDepreciation,
  AssetLoan,
  AssetLoanStatus,
  AssetMaintenance,
  AssetScanLog,
  AssetStatus,
  DepreciationMethod,
  MaintenanceStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLoggingService } from '../common/services/audit-logging.service';
import {
  CreateAssetCategoryDto,
  UpdateAssetCategoryDto,
  AssetCategoryResponseDto,
  CreateAssetDto,
  UpdateAssetDto,
  ListAssetsDto,
  AssetResponseDto,
  AssetSummaryResponseDto,
  CreateMaintenanceDto,
  MaintenanceResponseDto,
  DepreciationResponseDto,
  DepreciationSummaryResponseDto,
  CreateLoanDto,
  UpdateLoanDto,
  LoanResponseDto,
  ScanAssetDto,
  ScanLogResponseDto,
  QrResponseDto,
} from './dto';

interface AssetWithRelations extends Asset {
  category?: AssetCategory | null;
  branch?: { name: string } | null;
  department?: { name: string } | null;
  custodian?: { first_name: string; last_name: string } | null;
  borrower?: { first_name: string; last_name: string } | null;
}

/**
 * Service for managing church assets, maintenance, depreciation, and loans.
 */
@Injectable()
export class AssetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly requestContext: RequestContextService,
    private readonly audit: AuditLoggingService,
  ) {}

  /** Paginated operational records, always scoped through their parent asset. */
  private worklistAssetScope(
    churchId: string,
    query: ListAssetWorklistDto,
  ): Prisma.AssetWhereInput {
    const search = query.search?.trim();
    return {
      church_id: churchId,
      ...this.requestContext.branchWhere(churchId),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' as const } },
              { asset_tag: { contains: search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
  }

  async listLoanWorklist(churchId: string, query: ListAssetWorklistDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: Prisma.AssetLoanWhereInput = { asset: this.worklistAssetScope(churchId, query) };
    const now = new Date();
    if (query.status === 'active') where.status = { in: ['borrowed', 'overdue'] };
    else if (query.status === 'overdue')
      where.OR = [{ status: 'overdue' }, { status: 'borrowed', expected_return_date: { lt: now } }];
    else if (query.status === 'borrowed')
      Object.assign(where, { status: 'borrowed', expected_return_date: { gte: now } });
    else if (query.status === 'returned') where.status = 'returned';
    else if (query.status) throw new BadRequestException('Invalid loan status filter');

    const [records, total] = await Promise.all([
      this.prisma.assetLoan.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: [{ expected_return_date: 'desc' }, { id: 'asc' }],
        include: {
          asset: { select: { name: true, asset_tag: true, archived_at: true } },
          member: { select: { first_name: true, last_name: true } },
        },
      }),
      this.prisma.assetLoan.count({ where }),
    ]);
    return {
      data: records.map((record) => ({
        ...this.mapLoan(record),
        assetName: record.asset.name,
        assetTag: record.asset.asset_tag,
        assetArchived: !!record.asset.archived_at,
      })),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async listMaintenanceWorklist(churchId: string, query: ListAssetWorklistDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: Prisma.AssetMaintenanceWhereInput = {
      asset: this.worklistAssetScope(churchId, query),
    };
    if (query.status) {
      if (!['scheduled', 'in_progress', 'completed', 'cancelled'].includes(query.status))
        throw new BadRequestException('Invalid maintenance status filter');
      where.status = query.status as MaintenanceStatus;
    }
    const [records, total] = await Promise.all([
      this.prisma.assetMaintenance.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: [{ scheduled_date: 'desc' }, { id: 'asc' }],
        include: { asset: { select: { name: true, asset_tag: true, archived_at: true } } },
      }),
      this.prisma.assetMaintenance.count({ where }),
    ]);
    return {
      data: records.map((record) => ({
        ...this.mapMaintenance(record),
        assetName: record.asset.name,
        assetTag: record.asset.asset_tag,
        assetArchived: !!record.asset.archived_at,
      })),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * Creates a new asset category scoped to a church.
   *
   * @param churchId - Church ID
   * @param dto - Category data
   * @param userId - ID of the user creating the category
   * @returns Created category response
   */
  async createCategory(
    churchId: string,
    dto: CreateAssetCategoryDto,
    userId: string,
  ): Promise<AssetCategoryResponseDto> {
    const existing = await this.prisma.assetCategory.findUnique({
      where: { church_id_name: { church_id: churchId, name: dto.name } },
    });

    if (existing) {
      throw new BadRequestException('Asset category name already exists');
    }

    const category = await this.prisma.assetCategory.create({
      data: {
        church_id: churchId,
        name: dto.name,
        description: dto.description,
      },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'asset_category',
      action: 'CREATE',
      entityId: category.id,
      newValues: category as unknown as Record<string, unknown>,
    });

    return this.mapCategory(category);
  }

  /**
   * Lists asset categories for a church.
   *
   * @param churchId - Church ID
   * @param archived - When true, lists archived categories only (default: active only)
   * @returns Array of category responses
   */
  async listCategories(churchId: string, archived = false): Promise<AssetCategoryResponseDto[]> {
    const categories = await this.prisma.assetCategory.findMany({
      where: {
        church_id: churchId,
        archived_at: archived ? { not: null } : null,
      },
      orderBy: { name: 'asc' },
    });

    return categories.map((category) => this.mapCategory(category));
  }

  /**
   * Updates an asset category.
   *
   * @param churchId - Church ID
   * @param categoryId - Category ID
   * @param dto - Update data
   * @param userId - User ID
   * @returns Updated category response
   */
  async updateCategory(
    churchId: string,
    categoryId: string,
    dto: UpdateAssetCategoryDto,
    userId: string,
  ): Promise<AssetCategoryResponseDto> {
    const category = await this.getCategoryById(churchId, categoryId);

    if (category.archived_at) {
      throw new NotFoundException('Asset category is archived');
    }

    if (dto.name && dto.name !== category.name) {
      const existing = await this.prisma.assetCategory.findUnique({
        where: { church_id_name: { church_id: churchId, name: dto.name } },
      });
      if (existing) {
        throw new BadRequestException('Asset category name already exists');
      }
    }

    const updated = await this.prisma.assetCategory.update({
      where: { id: categoryId },
      data: {
        name: dto.name,
        description: dto.description,
      },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'asset_category',
      action: 'UPDATE',
      entityId: categoryId,
      oldValues: category as unknown as Record<string, unknown>,
      newValues: updated as unknown as Record<string, unknown>,
    });

    return this.mapCategory(updated);
  }

  /**
   * Deletes an asset category if no assets are linked.
   *
   * @param churchId - Church ID
   * @param categoryId - Category ID
   * @param userId - User ID
   */
  async deleteCategory(churchId: string, categoryId: string, userId: string): Promise<void> {
    const category = await this.getCategoryById(churchId, categoryId);

    const linkedAssets = await this.prisma.asset.count({
      where: { category_id: categoryId },
    });

    if (linkedAssets > 0) {
      throw new BadRequestException('Cannot delete category with linked assets');
    }

    await this.prisma.assetCategory.delete({ where: { id: categoryId } });

    await this.audit.log({
      userId,
      churchId,
      entity: 'asset_category',
      action: 'DELETE',
      entityId: categoryId,
      oldValues: category as unknown as Record<string, unknown>,
    });
  }

  /**
   * Archives an asset category by setting archived_at. Archived categories
   * drop out of active category lists (they stay reachable by ID and can be
   * restored or permanently deleted).
   *
   * @param churchId - Church ID
   * @param categoryId - Category ID
   * @param userId - User ID
   * @returns Updated category response
   * @throws NotFoundException if the category is missing or not in this church
   * @throws ConflictException if the category is already archived
   */
  async archiveCategory(
    churchId: string,
    categoryId: string,
    userId: string,
  ): Promise<AssetCategoryResponseDto> {
    const existing = await this.getCategoryById(churchId, categoryId);

    if (existing.archived_at) {
      throw new ConflictException('Asset category is already archived');
    }

    const updated = await this.prisma.assetCategory.update({
      where: { id: categoryId },
      data: { archived_at: new Date() },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'asset_category',
      action: 'ARCHIVE',
      entityId: categoryId,
      oldValues: { archived_at: existing.archived_at },
      newValues: { archived_at: updated.archived_at },
    });

    return this.mapCategory(updated);
  }

  /**
   * Restores an archived asset category by clearing archived_at.
   *
   * @param churchId - Church ID
   * @param categoryId - Category ID
   * @param userId - User ID
   * @returns Updated category response
   * @throws NotFoundException if the category is missing or not in this church
   * @throws ConflictException if the category is not currently archived
   */
  async restoreCategory(
    churchId: string,
    categoryId: string,
    userId: string,
  ): Promise<AssetCategoryResponseDto> {
    const existing = await this.getCategoryById(churchId, categoryId);

    if (!existing.archived_at) {
      throw new ConflictException('Asset category is not archived');
    }

    const updated = await this.prisma.assetCategory.update({
      where: { id: categoryId },
      data: { archived_at: null },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'asset_category',
      action: 'RESTORE',
      entityId: categoryId,
      oldValues: { archived_at: existing.archived_at },
      newValues: { archived_at: null },
    });

    return this.mapCategory(updated);
  }

  /**
   * Registers a new asset.
   *
   * @param churchId - Church ID
   * @param dto - Asset data
   * @param userId - User ID
   * @returns Created asset response
   */
  async createAsset(
    churchId: string,
    dto: CreateAssetDto,
    userId: string,
  ): Promise<AssetResponseDto> {
    dto.branchId = this.requestContext.branchIdForWrite(churchId, dto.branchId);
    await this.validateAssetRelations(churchId, dto);

    const existingTag = await this.prisma.asset.findUnique({
      where: { church_id_asset_tag: { church_id: churchId, asset_tag: dto.assetTag } },
    });

    if (existingTag) {
      throw new BadRequestException('Asset tag already exists');
    }

    const asset = await this.prisma.asset.create({
      data: {
        church_id: churchId,
        asset_tag: dto.assetTag,
        name: dto.name,
        description: dto.description,
        image_url: dto.imageUrl,
        category_id: dto.categoryId,
        serial_number: dto.serialNumber,
        brand: dto.brand,
        model: dto.model,
        department_id: dto.departmentId,
        branch_id: dto.branchId,
        custodian_id: dto.custodianId,
        condition: dto.condition ?? AssetCondition.good,
        status: dto.status ?? AssetStatus.active,
        purchase_date: dto.purchaseDate ? new Date(dto.purchaseDate) : null,
        purchase_price: dto.purchasePrice ?? null,
        salvage_value: dto.salvageValue ?? 0,
        useful_life_years: dto.usefulLifeYears ?? null,
        depreciation_method: dto.depreciationMethod ?? DepreciationMethod.straight_line,
        current_value: dto.currentValue ?? dto.purchasePrice ?? null,
        location: dto.location,
        qr_code: null,
        notes: dto.notes,
      },
      include: {
        category: true,
        branch: { select: { name: true } },
        department: { select: { name: true } },
        custodian: { select: { first_name: true, last_name: true } },
      },
    });

    // Update QR code with the real asset ID now that it exists.
    const updatedAsset = await this.prisma.asset.update({
      where: { id: asset.id },
      data: { qr_code: `BELIVRHQ:ASSET:${asset.id}` },
      include: {
        category: true,
        branch: { select: { name: true } },
        department: { select: { name: true } },
        custodian: { select: { first_name: true, last_name: true } },
      },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'asset',
      action: 'CREATE',
      entityId: asset.id,
      newValues: updatedAsset as unknown as Record<string, unknown>,
    });

    return this.mapAsset(updatedAsset as AssetWithRelations);
  }

  /**
   * Lists assets for a church with filters and pagination.
   *
   * @param churchId - Church ID
   * @param dto - Query filters
   * @returns Paginated asset list
   */
  async listAssets(
    churchId: string,
    dto: ListAssetsDto,
  ): Promise<{ items: AssetResponseDto[]; total: number; page: number; limit: number }> {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.AssetWhereInput = {
      church_id: churchId,
      archived_at: dto.archived === true ? { not: null } : null,
    };

    if (dto.status) where.status = dto.status;
    if (dto.condition) where.condition = dto.condition;
    if (dto.categoryId) where.category_id = dto.categoryId;
    if (dto.branchId) where.branch_id = dto.branchId;
    Object.assign(where, this.requestContext.branchWhere(churchId));
    if (dto.departmentId) where.department_id = dto.departmentId;

    if (dto.search) {
      const search = dto.search;
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { asset_tag: { contains: search, mode: 'insensitive' } },
        { serial_number: { contains: search, mode: 'insensitive' } },
        { location: { contains: search, mode: 'insensitive' } },
      ];
    }

    // Run these as separate awaited queries so a list request uses only one
    // database connection at a time under the capped Postgres session pool.
    const assets = await this.prisma.asset.findMany({
      where,
      skip,
      take: limit,
      orderBy: { created_at: 'desc' },
      include: {
        category: true,
        branch: { select: { name: true } },
        department: { select: { name: true } },
        custodian: { select: { first_name: true, last_name: true } },
      },
    });
    const total = await this.prisma.asset.count({ where });

    return {
      items: assets.map((asset) => this.mapAsset(asset as AssetWithRelations)),
      total,
      page,
      limit,
    };
  }

  /**
   * Returns asset register stats (count + valuation) for dashboard cards.
   * Computed in a single aggregate over active (non-archived) assets.
   *
   * @param churchId - Church ID
   * @returns Active asset count and purchase/current value totals
   */
  async getAssetsSummary(churchId: string, branchId?: string): Promise<AssetSummaryResponseDto> {
    const where: Prisma.AssetWhereInput = { church_id: churchId, archived_at: null };
    if (branchId) where.branch_id = branchId;
    Object.assign(where, this.requestContext.branchWhere(churchId));

    const agg = await this.prisma.asset.aggregate({
      where,
      _count: { _all: true },
      _sum: { purchase_price: true, current_value: true },
    });

    return {
      totalAssets: agg._count._all ?? 0,
      totalPurchaseValue: agg._sum.purchase_price ?? 0,
      totalCurrentValue: agg._sum.current_value ?? 0,
    };
  }

  /**
   * Retrieves a single asset by ID.
   *
   * @param churchId - Church ID
   * @param assetId - Asset ID
   * @returns Asset response
   */
  async getAsset(churchId: string, assetId: string): Promise<AssetResponseDto> {
    const asset = await this.prisma.asset.findFirst({
      where: { id: assetId, church_id: churchId, ...this.requestContext.branchWhere(churchId) },
      include: {
        category: true,
        branch: { select: { name: true } },
        department: { select: { name: true } },
        custodian: { select: { first_name: true, last_name: true } },
      },
    });

    if (!asset) {
      throw new NotFoundException('Asset not found');
    }

    return this.mapAsset(asset as AssetWithRelations);
  }

  /**
   * Updates an asset.
   *
   * @param churchId - Church ID
   * @param assetId - Asset ID
   * @param dto - Update data
   * @param userId - User ID
   * @returns Updated asset response
   */
  async updateAsset(
    churchId: string,
    assetId: string,
    dto: UpdateAssetDto,
    userId: string,
  ): Promise<AssetResponseDto> {
    if (dto.branchId !== undefined)
      dto.branchId = this.requestContext.branchIdForWrite(churchId, dto.branchId);
    const asset = await this.prisma.asset.findFirst({
      where: { id: assetId, church_id: churchId, ...this.requestContext.branchWhere(churchId) },
    });

    if (!asset) {
      throw new NotFoundException('Asset not found');
    }

    if (asset.archived_at) {
      throw new NotFoundException('Asset is archived');
    }

    await this.validateAssetRelations(churchId, dto);

    if (dto.assetTag && dto.assetTag !== asset.asset_tag) {
      const existingTag = await this.prisma.asset.findUnique({
        where: { church_id_asset_tag: { church_id: churchId, asset_tag: dto.assetTag } },
      });
      if (existingTag) {
        throw new BadRequestException('Asset tag already exists');
      }
    }

    const updated = await this.prisma.asset.update({
      where: { id: assetId },
      data: {
        asset_tag: dto.assetTag,
        name: dto.name,
        description: dto.description,
        image_url: dto.imageUrl,
        category_id: dto.categoryId,
        serial_number: dto.serialNumber,
        brand: dto.brand,
        model: dto.model,
        department_id: dto.departmentId,
        branch_id: dto.branchId,
        custodian_id: dto.custodianId,
        condition: dto.condition,
        status: dto.status,
        purchase_date:
          dto.purchaseDate === undefined
            ? undefined
            : dto.purchaseDate
              ? new Date(dto.purchaseDate)
              : null,
        purchase_price: dto.purchasePrice === undefined ? undefined : dto.purchasePrice,
        salvage_value: dto.salvageValue,
        useful_life_years: dto.usefulLifeYears,
        depreciation_method: dto.depreciationMethod,
        current_value: dto.currentValue,
        location: dto.location,
        notes: dto.notes,
      },
      include: {
        category: true,
        branch: { select: { name: true } },
        department: { select: { name: true } },
        custodian: { select: { first_name: true, last_name: true } },
      },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'asset',
      action: 'UPDATE',
      entityId: assetId,
      oldValues: asset as unknown as Record<string, unknown>,
      newValues: updated as unknown as Record<string, unknown>,
    });

    return this.mapAsset(updated as AssetWithRelations);
  }

  /**
   * Soft-deletes an asset by setting its status to disposed.
   *
   * @param churchId - Church ID
   * @param assetId - Asset ID
   * @param userId - User ID
   */
  async deleteAsset(churchId: string, assetId: string, userId: string): Promise<void> {
    const asset = await this.prisma.asset.findFirst({
      where: { id: assetId, church_id: churchId, ...this.requestContext.branchWhere(churchId) },
    });

    if (!asset) {
      throw new NotFoundException('Asset not found');
    }

    const updated = await this.prisma.asset.update({
      where: { id: assetId },
      data: { status: AssetStatus.disposed, qr_code: null },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'asset',
      action: 'DELETE',
      entityId: assetId,
      oldValues: asset as unknown as Record<string, unknown>,
      newValues: updated as unknown as Record<string, unknown>,
    });
  }

  /**
   * Archives an asset by setting archived_at. Archived assets drop out of
   * active asset lists (they stay reachable by ID and can be restored) while
   * their transactional history (maintenance, depreciation, loans) is kept.
   *
   * @param churchId - Church ID
   * @param assetId - Asset ID
   * @param userId - User ID
   * @returns Updated asset response
   * @throws NotFoundException if the asset is missing or not in this church
   * @throws ConflictException if the asset is already archived
   */
  async archiveAsset(churchId: string, assetId: string, userId: string): Promise<AssetResponseDto> {
    const existing = await this.prisma.asset.findFirst({
      where: { id: assetId, church_id: churchId, ...this.requestContext.branchWhere(churchId) },
    });

    if (!existing) {
      throw new NotFoundException('Asset not found');
    }

    if (existing.archived_at) {
      throw new ConflictException('Asset is already archived');
    }

    const updated = await this.prisma.asset.update({
      where: { id: assetId },
      data: { archived_at: new Date() },
      include: {
        category: true,
        branch: { select: { name: true } },
        department: { select: { name: true } },
        custodian: { select: { first_name: true, last_name: true } },
      },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'asset',
      action: 'ARCHIVE',
      entityId: assetId,
      oldValues: { archived_at: existing.archived_at },
      newValues: { archived_at: updated.archived_at },
    });

    return this.mapAsset(updated as AssetWithRelations);
  }

  /**
   * Restores an archived asset by clearing archived_at.
   *
   * @param churchId - Church ID
   * @param assetId - Asset ID
   * @param userId - User ID
   * @returns Updated asset response
   * @throws NotFoundException if the asset is missing or not in this church
   * @throws ConflictException if the asset is not currently archived
   */
  async restoreAsset(churchId: string, assetId: string, userId: string): Promise<AssetResponseDto> {
    const existing = await this.prisma.asset.findFirst({
      where: { id: assetId, church_id: churchId, ...this.requestContext.branchWhere(churchId) },
    });

    if (!existing) {
      throw new NotFoundException('Asset not found');
    }

    if (!existing.archived_at) {
      throw new ConflictException('Asset is not archived');
    }

    const updated = await this.prisma.asset.update({
      where: { id: assetId },
      data: { archived_at: null },
      include: {
        category: true,
        branch: { select: { name: true } },
        department: { select: { name: true } },
        custodian: { select: { first_name: true, last_name: true } },
      },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'asset',
      action: 'RESTORE',
      entityId: assetId,
      oldValues: { archived_at: existing.archived_at },
      newValues: { archived_at: null },
    });

    return this.mapAsset(updated as AssetWithRelations);
  }

  /**
   * Generates or refreshes an asset's QR code data.
   *
   * @param churchId - Church ID
   * @param assetId - Asset ID
   * @returns QR response
   */
  async generateQrCode(churchId: string, assetId: string): Promise<QrResponseDto> {
    await this.getAsset(churchId, assetId);

    const qrData = `BELIVRHQ:ASSET:${assetId}`;
    await this.prisma.asset.update({
      where: { id: assetId },
      data: { qr_code: qrData },
    });

    return { assetId, qrData };
  }

  /**
   * Retrieves QR code data for an asset.
   *
   * @param churchId - Church ID
   * @param assetId - Asset ID
   * @returns QR response
   */
  async getQrCode(churchId: string, assetId: string): Promise<QrResponseDto> {
    const asset = await this.prisma.asset.findFirst({
      where: { id: assetId, church_id: churchId, ...this.requestContext.branchWhere(churchId) },
      select: { id: true, qr_code: true },
    });

    if (!asset) {
      throw new NotFoundException('Asset not found');
    }

    return { assetId, qrData: asset.qr_code ?? `BELIVRHQ:ASSET:${assetId}` };
  }

  /**
   * Scans an asset by QR code or asset tag and logs the scan.
   *
   * @param churchId - Church ID
   * @param dto - Scan data
   * @param scannedById - Profile ID of the scanner
   * @returns Asset details and recent scan log
   */
  async scanAsset(
    churchId: string,
    dto: ScanAssetDto,
    scannedById?: string,
  ): Promise<{
    asset: AssetResponseDto;
    activeLoan?: LoanResponseDto;
    upcomingMaintenance?: MaintenanceResponseDto;
    scanLog: ScanLogResponseDto;
  }> {
    let assetId: string | undefined;

    if (dto.qrData) {
      const match = dto.qrData.match(ASSET_QR);
      if (!match) {
        throw new BadRequestException('Invalid QR code format');
      }
      assetId = match[1];
    } else if (dto.assetTag) {
      const asset = await this.prisma.asset.findUnique({
        where: { church_id_asset_tag: { church_id: churchId, asset_tag: dto.assetTag } },
        select: { id: true },
      });
      assetId = asset?.id;
    } else {
      throw new BadRequestException('Provide qrData or assetTag');
    }

    if (!assetId) {
      throw new NotFoundException('Asset not found');
    }

    const asset = await this.prisma.asset.findFirst({
      where: { id: assetId, church_id: churchId, ...this.requestContext.branchWhere(churchId) },
      include: {
        category: true,
        branch: { select: { name: true } },
        department: { select: { name: true } },
        custodian: { select: { first_name: true, last_name: true } },
      },
    });

    if (!asset) {
      throw new NotFoundException('Asset not found');
    }

    const scanLog = await this.prisma.assetScanLog.create({
      data: {
        asset_id: assetId,
        scanned_by_id: scannedById ?? null,
        scan_type: 'check',
        metadata: dto as unknown as Prisma.InputJsonValue,
      },
    });

    const activeLoan = await this.prisma.assetLoan.findFirst({
      where: {
        asset_id: assetId,
        status: { in: [AssetLoanStatus.borrowed, AssetLoanStatus.overdue] },
      },
      include: { member: { select: { first_name: true, last_name: true } } },
      orderBy: { created_at: 'desc' },
    });

    const upcomingMaintenance = await this.prisma.assetMaintenance.findFirst({
      where: {
        asset_id: assetId,
        status: { in: [MaintenanceStatus.scheduled, MaintenanceStatus.in_progress] },
        scheduled_date: { gte: new Date() },
      },
      orderBy: { scheduled_date: 'asc' },
    });

    return {
      asset: this.mapAsset(asset as AssetWithRelations),
      activeLoan: activeLoan ? this.mapLoan(activeLoan) : undefined,
      upcomingMaintenance: upcomingMaintenance
        ? this.mapMaintenance(upcomingMaintenance)
        : undefined,
      scanLog: this.mapScanLog(scanLog),
    };
  }

  /**
   * Creates a maintenance record for an asset.
   *
   * @param churchId - Church ID
   * @param assetId - Asset ID
   * @param dto - Maintenance data
   * @param userId - User ID
   * @returns Maintenance response
   */
  async createMaintenance(
    churchId: string,
    assetId: string,
    dto: CreateMaintenanceDto,
    userId: string,
  ): Promise<MaintenanceResponseDto> {
    await this.getAsset(churchId, assetId);

    const maintenance = await this.prisma.assetMaintenance.create({
      data: {
        asset_id: assetId,
        type: dto.type,
        description: dto.description,
        status: dto.status ?? MaintenanceStatus.scheduled,
        scheduled_date: new Date(dto.scheduledDate),
        completed_date: dto.completedDate ? new Date(dto.completedDate) : null,
        cost: dto.cost ?? null,
        performed_by: dto.performedBy,
        notes: dto.notes,
      },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'asset_maintenance',
      action: 'CREATE',
      entityId: maintenance.id,
      newValues: maintenance as unknown as Record<string, unknown>,
    });

    return this.mapMaintenance(maintenance);
  }

  /**
   * Lists maintenance records for an asset.
   *
   * @param churchId - Church ID
   * @param assetId - Asset ID
   * @returns Maintenance responses
   */
  async listMaintenance(churchId: string, assetId: string): Promise<MaintenanceResponseDto[]> {
    await this.getAsset(churchId, assetId);

    const records = await this.prisma.assetMaintenance.findMany({
      where: { asset_id: assetId },
      orderBy: { scheduled_date: 'desc' },
    });

    return records.map((record) => this.mapMaintenance(record));
  }

  /**
   * Updates a maintenance record.
   *
   * @param churchId - Church ID
   * @param assetId - Asset ID
   * @param maintenanceId - Maintenance ID
   * @param dto - Partial update data
   * @param userId - User ID
   * @returns Updated maintenance response
   */
  async updateMaintenance(
    churchId: string,
    assetId: string,
    maintenanceId: string,
    dto: Partial<CreateMaintenanceDto>,
    userId: string,
  ): Promise<MaintenanceResponseDto> {
    await this.getAsset(churchId, assetId);

    const maintenance = await this.prisma.assetMaintenance.findFirst({
      where: { id: maintenanceId, asset_id: assetId },
    });

    if (!maintenance) {
      throw new NotFoundException('Maintenance record not found');
    }

    const updated = await this.prisma.assetMaintenance.update({
      where: { id: maintenanceId },
      data: {
        type: dto.type,
        description: dto.description,
        status: dto.status,
        scheduled_date: dto.scheduledDate ? new Date(dto.scheduledDate) : undefined,
        completed_date:
          dto.completedDate === undefined
            ? undefined
            : dto.completedDate
              ? new Date(dto.completedDate)
              : null,
        cost: dto.cost,
        performed_by: dto.performedBy,
        notes: dto.notes,
      },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'asset_maintenance',
      action: 'UPDATE',
      entityId: maintenanceId,
      oldValues: maintenance as unknown as Record<string, unknown>,
      newValues: updated as unknown as Record<string, unknown>,
    });

    return this.mapMaintenance(updated);
  }

  /**
   * Creates a depreciation entry for an asset.
   *
   * @param churchId - Church ID
   * @param assetId - Asset ID
   * @param userId - User ID
   * @returns Depreciation response
   */
  async createDepreciation(
    churchId: string,
    assetId: string,
    userId: string,
  ): Promise<DepreciationResponseDto> {
    const asset = await this.prisma.asset.findFirst({
      where: { id: assetId, church_id: churchId, ...this.requestContext.branchWhere(churchId) },
      include: { depreciation: { orderBy: { year: 'desc' }, take: 1 } },
    });

    if (!asset) {
      throw new NotFoundException('Asset not found');
    }

    if (asset.archived_at) {
      throw new NotFoundException('Asset is archived');
    }

    if (!asset.purchase_price || !asset.useful_life_years) {
      throw new BadRequestException(
        'Asset must have purchase price and useful life years to calculate depreciation',
      );
    }

    const currentYear = new Date().getFullYear();
    const existing = await this.prisma.assetDepreciation.findUnique({
      where: { asset_id_year: { asset_id: assetId, year: currentYear } },
    });

    if (existing) {
      throw new BadRequestException(`Depreciation for ${currentYear} already exists`);
    }

    const lastEntry = asset.depreciation[0];
    const openingValue = lastEntry ? lastEntry.closing_value : asset.purchase_price;

    const depreciationAmount = this.calculateDepreciation(
      openingValue,
      asset.purchase_price,
      asset.salvage_value,
      asset.useful_life_years,
      asset.depreciation_method,
    );

    const closingValue = Math.max(openingValue - depreciationAmount, asset.salvage_value);

    const entry = await this.prisma.assetDepreciation.create({
      data: {
        asset_id: assetId,
        year: currentYear,
        opening_value: openingValue,
        depreciation_amount: depreciationAmount,
        closing_value: closingValue,
      },
    });

    await this.prisma.asset.update({
      where: { id: assetId },
      data: { current_value: closingValue },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'asset_depreciation',
      action: 'CREATE',
      entityId: entry.id,
      newValues: entry as unknown as Record<string, unknown>,
    });

    return this.mapDepreciation(entry);
  }

  /**
   * Lists depreciation entries for an asset.
   *
   * @param churchId - Church ID
   * @param assetId - Asset ID
   * @returns Depreciation responses
   */
  async listDepreciation(churchId: string, assetId: string): Promise<DepreciationResponseDto[]> {
    await this.getAsset(churchId, assetId);

    const entries = await this.prisma.assetDepreciation.findMany({
      where: { asset_id: assetId },
      orderBy: { year: 'asc' },
    });

    return entries.map((entry) => this.mapDepreciation(entry));
  }

  /**
   * Returns a depreciation summary for an asset.
   *
   * @param churchId - Church ID
   * @param assetId - Asset ID
   * @returns Summary response
   */
  async getDepreciationSummary(
    churchId: string,
    assetId: string,
  ): Promise<DepreciationSummaryResponseDto> {
    const asset = await this.prisma.asset.findFirst({
      where: { id: assetId, church_id: churchId, ...this.requestContext.branchWhere(churchId) },
      include: { depreciation: { orderBy: { year: 'asc' } } },
    });

    if (!asset) {
      throw new NotFoundException('Asset not found');
    }

    const totalDepreciation = asset.depreciation.reduce(
      (sum, entry) => sum + entry.depreciation_amount,
      0,
    );

    return {
      assetId,
      purchasePrice: asset.purchase_price ?? 0,
      totalDepreciation,
      currentValue: asset.current_value ?? asset.purchase_price ?? 0,
      entries: asset.depreciation.map((entry) => this.mapDepreciation(entry)),
    };
  }

  /**
   * Creates a loan record for an asset.
   *
   * @param churchId - Church ID
   * @param assetId - Asset ID
   * @param dto - Loan data
   * @param userId - User ID
   * @returns Loan response
   */
  async createLoan(
    churchId: string,
    assetId: string,
    dto: CreateLoanDto,
    userId: string,
  ): Promise<LoanResponseDto> {
    const asset = await this.prisma.asset.findFirst({
      where: { id: assetId, church_id: churchId, ...this.requestContext.branchWhere(churchId) },
    });

    if (!asset) {
      throw new NotFoundException('Asset not found');
    }

    if (asset.archived_at) {
      throw new NotFoundException('Asset is archived');
    }

    const activeLoan = await this.prisma.assetLoan.findFirst({
      where: {
        asset_id: assetId,
        status: { in: [AssetLoanStatus.borrowed, AssetLoanStatus.overdue] },
      },
    });

    if (activeLoan) {
      throw new BadRequestException('Asset is already on loan');
    }

    if (dto.borrowerMemberId) {
      const member = await this.prisma.member.findFirst({
        where: { id: dto.borrowerMemberId, church_id: churchId },
      });
      if (!member) {
        throw new NotFoundException('Borrower member not found');
      }
    }

    if (!dto.borrowerMemberId && !dto.borrowedByName) {
      throw new BadRequestException('Provide borrowerMemberId or borrowedByName');
    }

    const loan = await this.prisma.assetLoan.create({
      data: {
        asset_id: assetId,
        borrower_member_id: dto.borrowerMemberId ?? null,
        borrowed_by_name: dto.borrowedByName ?? null,
        expected_return_date: new Date(dto.expectedReturnDate),
        condition_before: dto.conditionBefore ?? null,
        notes: dto.notes,
      },
      include: { member: { select: { first_name: true, last_name: true } } },
    });

    await this.prisma.asset.update({
      where: { id: assetId },
      data: { status: AssetStatus.maintenance },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'asset_loan',
      action: 'CREATE',
      entityId: loan.id,
      newValues: loan as unknown as Record<string, unknown>,
    });

    return this.mapLoan(loan);
  }

  /**
   * Lists loan records for an asset.
   *
   * @param churchId - Church ID
   * @param assetId - Asset ID
   * @returns Loan responses
   */
  async listLoans(churchId: string, assetId: string): Promise<LoanResponseDto[]> {
    await this.getAsset(churchId, assetId);

    const loans = await this.prisma.assetLoan.findMany({
      where: { asset_id: assetId },
      orderBy: { created_at: 'desc' },
      include: { member: { select: { first_name: true, last_name: true } } },
    });

    return loans.map((loan) => this.mapLoan(loan));
  }

  /**
   * Records the return of a loaned asset.
   *
   * @param churchId - Church ID
   * @param assetId - Asset ID
   * @param loanId - Loan ID
   * @param dto - Return data
   * @param userId - User ID
   * @returns Updated loan response
   */
  async returnLoan(
    churchId: string,
    assetId: string,
    loanId: string,
    dto: UpdateLoanDto,
    userId: string,
  ): Promise<LoanResponseDto> {
    const asset = await this.prisma.asset.findFirst({
      where: { id: assetId, church_id: churchId, ...this.requestContext.branchWhere(churchId) },
    });

    if (!asset) {
      throw new NotFoundException('Asset not found');
    }

    if (asset.archived_at) {
      throw new NotFoundException('Asset is archived');
    }

    const loan = await this.prisma.assetLoan.findFirst({
      where: { id: loanId, asset_id: assetId },
      include: { member: { select: { first_name: true, last_name: true } } },
    });

    if (!loan) {
      throw new NotFoundException('Loan record not found');
    }

    if (loan.status === AssetLoanStatus.returned) {
      throw new BadRequestException('Asset has already been returned');
    }

    const updated = await this.prisma.assetLoan.update({
      where: { id: loanId },
      data: {
        actual_return_date: dto.actualReturnDate ? new Date(dto.actualReturnDate) : new Date(),
        condition_after: dto.conditionAfter ?? null,
        status: AssetLoanStatus.returned,
        notes: dto.notes,
      },
      include: { member: { select: { first_name: true, last_name: true } } },
    });

    await this.prisma.asset.update({
      where: { id: assetId },
      data: { status: AssetStatus.active },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'asset_loan',
      action: 'UPDATE',
      entityId: loanId,
      oldValues: loan as unknown as Record<string, unknown>,
      newValues: updated as unknown as Record<string, unknown>,
    });

    return this.mapLoan(updated);
  }

  /**
   * Validates that related entities belong to the same church.
   */
  private async validateAssetRelations(
    churchId: string,
    dto: CreateAssetDto | UpdateAssetDto,
  ): Promise<void> {
    if (dto.categoryId) {
      const category = await this.prisma.assetCategory.findFirst({
        where: { id: dto.categoryId, church_id: churchId },
      });
      if (!category) {
        throw new NotFoundException('Asset category not found');
      }
    }

    if (dto.departmentId) {
      const department = await this.prisma.department.findFirst({
        where: { id: dto.departmentId, church_id: churchId },
      });
      if (!department) {
        throw new NotFoundException('Department not found');
      }
    }

    if (dto.branchId) {
      const branch = await this.prisma.branch.findFirst({
        where: { id: dto.branchId, church_id: churchId },
      });
      if (!branch) {
        throw new NotFoundException('Branch not found');
      }
    }

    if (dto.custodianId) {
      const member = await this.prisma.member.findFirst({
        where: { id: dto.custodianId, church_id: churchId },
      });
      if (!member) {
        throw new NotFoundException('Custodian member not found');
      }
    }
  }

  /**
   * Calculates annual depreciation for an asset.
   */
  private calculateDepreciation(
    openingValue: number,
    purchasePrice: number,
    salvageValue: number,
    usefulLifeYears: number,
    method: DepreciationMethod,
  ): number {
    const REDUCING_BALANCE_RATE = 0.25;

    if (method === DepreciationMethod.straight_line) {
      return Math.max((purchasePrice - salvageValue) / usefulLifeYears, 0);
    }

    const amount = openingValue * REDUCING_BALANCE_RATE;
    return Math.max(Math.min(amount, openingValue - salvageValue), 0);
  }

  /**
   * Helper to retrieve a category by ID scoped to church.
   */
  private async getCategoryById(churchId: string, categoryId: string): Promise<AssetCategory> {
    const category = await this.prisma.assetCategory.findFirst({
      where: { id: categoryId, church_id: churchId },
    });

    if (!category) {
      throw new NotFoundException('Asset category not found');
    }

    return category;
  }

  /**
   * Maps a Prisma AssetCategory to a response DTO.
   */
  private mapCategory(category: AssetCategory): AssetCategoryResponseDto {
    return {
      id: category.id,
      churchId: category.church_id,
      name: category.name,
      description: category.description ?? undefined,
      archivedAt: category.archived_at?.toISOString() ?? undefined,
      createdAt: category.created_at.toISOString(),
      updatedAt: category.updated_at.toISOString(),
    };
  }

  /**
   * Maps a Prisma Asset to a response DTO.
   */
  private mapAsset(asset: AssetWithRelations): AssetResponseDto {
    return {
      id: asset.id,
      churchId: asset.church_id,
      assetTag: asset.asset_tag,
      name: asset.name,
      description: asset.description ?? undefined,
      imageUrl: asset.image_url ?? undefined,
      categoryId: asset.category_id ?? undefined,
      categoryName: asset.category?.name,
      serialNumber: asset.serial_number ?? undefined,
      brand: asset.brand ?? undefined,
      model: asset.model ?? undefined,
      departmentId: asset.department_id ?? undefined,
      departmentName: asset.department?.name,
      branchId: asset.branch_id ?? undefined,
      branchName: asset.branch?.name,
      custodianId: asset.custodian_id ?? undefined,
      custodianName: asset.custodian
        ? `${asset.custodian.first_name} ${asset.custodian.last_name}`
        : undefined,
      condition: asset.condition,
      status: asset.status,
      purchaseDate: asset.purchase_date?.toISOString().split('T')[0],
      purchasePrice: asset.purchase_price ?? undefined,
      salvageValue: asset.salvage_value,
      usefulLifeYears: asset.useful_life_years ?? undefined,
      depreciationMethod: asset.depreciation_method,
      currentValue: asset.current_value ?? undefined,
      location: asset.location ?? undefined,
      qrCode: asset.qr_code ?? undefined,
      notes: asset.notes ?? undefined,
      archivedAt: asset.archived_at?.toISOString() ?? undefined,
      createdAt: asset.created_at.toISOString(),
      updatedAt: asset.updated_at.toISOString(),
    };
  }

  /**
   * Maps a Prisma AssetMaintenance to a response DTO.
   */
  private mapMaintenance(maintenance: AssetMaintenance): MaintenanceResponseDto {
    return {
      id: maintenance.id,
      assetId: maintenance.asset_id,
      type: maintenance.type,
      description: maintenance.description ?? undefined,
      status: maintenance.status,
      scheduledDate: maintenance.scheduled_date.toISOString(),
      completedDate: maintenance.completed_date?.toISOString(),
      cost: maintenance.cost ?? undefined,
      performedBy: maintenance.performed_by ?? undefined,
      notes: maintenance.notes ?? undefined,
      createdAt: maintenance.created_at.toISOString(),
      updatedAt: maintenance.updated_at.toISOString(),
    };
  }

  /**
   * Maps a Prisma AssetDepreciation to a response DTO.
   */
  private mapDepreciation(entry: AssetDepreciation): DepreciationResponseDto {
    return {
      id: entry.id,
      assetId: entry.asset_id,
      year: entry.year,
      openingValue: entry.opening_value,
      depreciationAmount: entry.depreciation_amount,
      closingValue: entry.closing_value,
      createdAt: entry.created_at.toISOString(),
    };
  }

  /**
   * Maps a Prisma AssetLoan to a response DTO.
   */
  private mapLoan(
    loan: AssetLoan & { member?: { first_name: string; last_name: string } | null },
  ): LoanResponseDto {
    const borrowerName = loan.member
      ? `${loan.member.first_name} ${loan.member.last_name}`
      : (loan.borrowed_by_name ?? undefined);

    return {
      id: loan.id,
      assetId: loan.asset_id,
      borrowerMemberId: loan.borrower_member_id ?? undefined,
      borrowerName,
      loanDate: loan.loan_date.toISOString(),
      expectedReturnDate: loan.expected_return_date.toISOString(),
      actualReturnDate: loan.actual_return_date?.toISOString(),
      status: loan.status,
      conditionBefore: loan.condition_before ?? undefined,
      conditionAfter: loan.condition_after ?? undefined,
      notes: loan.notes ?? undefined,
      createdAt: loan.created_at.toISOString(),
      updatedAt: loan.updated_at.toISOString(),
    };
  }

  /**
   * Maps a Prisma AssetScanLog to a response DTO.
   */
  private mapScanLog(scanLog: AssetScanLog): ScanLogResponseDto {
    return {
      id: scanLog.id,
      assetId: scanLog.asset_id,
      scannedById: scanLog.scanned_by_id ?? undefined,
      scanType: scanLog.scan_type,
      metadata: (scanLog.metadata as Record<string, unknown>) ?? undefined,
      createdAt: scanLog.created_at.toISOString(),
    };
  }
}
