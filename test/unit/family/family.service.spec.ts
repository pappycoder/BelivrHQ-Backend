import { BranchScopeService } from '../../../src/common/services/branch-scope.service';
import { RequestContextService } from '../../../src/common/services/request-context.service';
/**
 * @file family.service.spec.ts
 * @description Unit tests for FamilyService (archive/restore lifecycle + list filtering).
 *
 * @module test/unit/family/family.service.spec
 * @since 1.0.0
 */

import { Test, TestingModule } from '@nestjs/testing';
import { FamilyService } from '../../../src/family/family.service';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { AuditLoggingService } from '../../../src/common/services/audit-logging.service';
import { NotFoundException, ConflictException } from '@nestjs/common';
import { createPrismaMock } from '../../helpers/prisma-mock.helper';

describe('FamilyService', () => {
  let service: FamilyService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let auditLog: jest.Mock;

  const churchId = 'church-1';
  const userId = 'user-1';

  const mockFamily = {
    id: 'family-1',
    church_id: churchId,
    name: 'Okafor Family',
    head_id: null,
    archived_at: null,
    created_at: new Date('2026-01-15'),
    family_members: [],
  };

  beforeEach(async () => {
    prisma = createPrismaMock();
    auditLog = jest.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RequestContextService,
        BranchScopeService,
        FamilyService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditLoggingService, useValue: { log: auditLog } },
      ],
    }).compile();

    service = module.get<FamilyService>(FamilyService);
  });

  describe('listFamilies', () => {
    it('should exclude archived families by default', async () => {
      prisma.family.findMany.mockResolvedValue([]);
      prisma.family.count.mockResolvedValue(0);

      await service.listFamilies(churchId, {});

      expect(prisma.family.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ archived_at: null }) }),
      );
    });

    it('should list only archived families when archived=true', async () => {
      prisma.family.findMany.mockResolvedValue([
        { ...mockFamily, archived_at: new Date('2026-08-28T10:00:00.000Z') },
      ]);
      prisma.family.count.mockResolvedValue(1);

      const result = await service.listFamilies(churchId, { archived: true });

      expect(prisma.family.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ archived_at: { not: null } }) }),
      );
      expect(result.data[0].archivedAt).toBe('2026-08-28T10:00:00.000Z');
    });

    it('should default to sorting by name ascending', async () => {
      prisma.family.findMany.mockResolvedValue([]);
      prisma.family.count.mockResolvedValue(0);

      await service.listFamilies(churchId, {});

      expect(prisma.family.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: [{ name: 'asc' }] }),
      );
    });

    it('should sort by created date with a name tie-break', async () => {
      prisma.family.findMany.mockResolvedValue([]);
      prisma.family.count.mockResolvedValue(0);

      await service.listFamilies(churchId, { sortBy: 'createdAt', sortOrder: 'desc' });

      expect(prisma.family.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: [{ created_at: 'desc' }, { name: 'asc' }] }),
      );
    });

    it('should sort by member count via the family_members relation count', async () => {
      prisma.family.findMany.mockResolvedValue([]);
      prisma.family.count.mockResolvedValue(0);

      await service.listFamilies(churchId, { sortBy: 'memberCount', sortOrder: 'asc' });

      expect(prisma.family.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ family_members: { _count: 'asc' } }, { name: 'asc' }],
        }),
      );
    });
  });

  describe('archive', () => {
    it('should set archived_at and audit ARCHIVE', async () => {
      const archivedAt = new Date('2026-08-28T12:00:00.000Z');
      prisma.family.findFirst.mockResolvedValueOnce(mockFamily);
      prisma.family.update.mockResolvedValue({ ...mockFamily, archived_at: archivedAt });
      prisma.family.findFirst.mockResolvedValueOnce({ ...mockFamily, archived_at: archivedAt });

      const result = await service.archive('family-1', churchId, userId);

      expect(prisma.family.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { archived_at: expect.any(Date) } }),
      );
      expect(result.familyId).toBe('family-1');
      expect(result.archivedAt).toBe(archivedAt.toISOString());
      expect(auditLog).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'ARCHIVE', entity: 'family' }),
      );
    });

    it('should throw ConflictException when already archived', async () => {
      prisma.family.findFirst.mockResolvedValue({
        ...mockFamily,
        archived_at: new Date(),
      });

      await expect(service.archive('family-1', churchId, userId)).rejects.toThrow(
        ConflictException,
      );
    });

    it('should throw NotFoundException for missing family', async () => {
      prisma.family.findFirst.mockResolvedValue(null);

      await expect(service.archive('family-1', churchId, userId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('restore', () => {
    it('should clear archived_at and audit RESTORE', async () => {
      prisma.family.findFirst.mockResolvedValueOnce({
        ...mockFamily,
        archived_at: new Date('2026-08-27T12:00:00.000Z'),
      });
      prisma.family.update.mockResolvedValue(mockFamily);
      prisma.family.findFirst.mockResolvedValueOnce(mockFamily);

      const result = await service.restore('family-1', churchId, userId);

      expect(prisma.family.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { archived_at: null } }),
      );
      expect(result.archivedAt).toBeUndefined();
      expect(auditLog).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'RESTORE', entity: 'family' }),
      );
    });

    it('should throw ConflictException when not archived', async () => {
      prisma.family.findFirst.mockResolvedValue(mockFamily);

      await expect(service.restore('family-1', churchId, userId)).rejects.toThrow(
        ConflictException,
      );
    });

    it('should throw NotFoundException for missing family', async () => {
      prisma.family.findFirst.mockResolvedValue(null);

      await expect(service.restore('family-1', churchId, userId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('archived-row guards', () => {
    it('should reject updateFamily on an archived family', async () => {
      prisma.family.findFirst.mockResolvedValue({
        ...mockFamily,
        archived_at: new Date(),
      });

      await expect(
        service.updateFamily('family-1', { name: 'X' }, churchId, userId),
      ).rejects.toThrow(NotFoundException);
    });

    it('should reject addMember on an archived family', async () => {
      prisma.family.findFirst.mockResolvedValue({
        ...mockFamily,
        archived_at: new Date(),
      });

      await expect(
        service.addMember(
          'family-1',
          { memberId: 'member-1', relationship: 'spouse' },
          churchId,
          userId,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('should reject removeMember on an archived family', async () => {
      prisma.family.findFirst.mockResolvedValue({
        ...mockFamily,
        archived_at: new Date(),
      });

      await expect(service.removeMember('family-1', 'member-1', churchId, userId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should still allow hard delete (purge) of an archived family', async () => {
      prisma.family.findFirst.mockResolvedValue({
        ...mockFamily,
        archived_at: new Date(),
      });

      await expect(service.deleteFamily('family-1', churchId, userId)).resolves.toBeUndefined();
      expect(prisma.family.delete).toHaveBeenCalled();
    });
  });
});
