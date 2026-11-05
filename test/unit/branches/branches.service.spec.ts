import { RequestContextService } from '../../../src/common/services/request-context.service';
import { Test, TestingModule } from '@nestjs/testing';
import { BranchesService } from '../../../src/branches/branches.service';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { AuditLoggingService } from '../../../src/common/services/audit-logging.service';
import { BranchScopeService } from '../../../src/common/services/branch-scope.service';
import { MediaService } from '../../../src/media/media.service';
import { NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { createPrismaMock } from '../../helpers/prisma-mock.helper';

describe('BranchesService', () => {
  let service: BranchesService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let auditLog: jest.Mock;
  let mediaDelete: jest.Mock;

  const mockBranch = {
    id: 'branch-1',
    church_id: 'church-1',
    name: 'Main Auditorium',
    is_headquarters: true,
    address: '456 Grace Road',
    city: 'Lagos',
    state: 'Lagos',
    country: 'Nigeria',
    phone: '+234 803 456 7890',
    email: 'main@church.org',
    photo_url: null,
    created_at: new Date('2024-01-15'),
    updated_at: new Date('2024-06-20'),
    _count: { members: 50 },
  };

  beforeEach(async () => {
    prisma = createPrismaMock();
    auditLog = jest.fn();
    mediaDelete = jest.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RequestContextService,
        BranchesService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditLoggingService, useValue: { log: auditLog } },
        { provide: MediaService, useValue: { deleteByUrl: mediaDelete } },
        BranchScopeService,
      ],
    }).compile();

    service = module.get<BranchesService>(BranchesService);
  });

  describe('create', () => {
    it('should create a new branch', async () => {
      prisma.branch.findFirst.mockResolvedValue(null);
      prisma.branch.create.mockResolvedValue(mockBranch);

      const result = await service.create(
        { name: 'Main Auditorium', isHeadquarters: true },
        'church-1',
        'user-1',
      );

      expect(result.name).toBe('Main Auditorium');
      expect(result.isHeadquarters).toBe(true);
      expect(auditLog).toHaveBeenCalled();
    });

    it('should throw ConflictException if headquarters already exists', async () => {
      prisma.branch.findFirst.mockResolvedValue({ id: 'existing-hq' });

      await expect(
        service.create({ name: 'New HQ', isHeadquarters: true }, 'church-1', 'user-1'),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('findAll', () => {
    it('should return paginated branches', async () => {
      prisma.branch.findMany.mockResolvedValue([mockBranch]);
      prisma.branch.count.mockResolvedValue(1);

      const result = await service.findAll('church-1', { page: 1, limit: 20 });

      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.data[0].memberCount).toBe(50);
    });

    it('should exclude archived branches by default', async () => {
      prisma.branch.findMany.mockResolvedValue([]);
      prisma.branch.count.mockResolvedValue(0);

      await service.findAll('church-1', {});

      expect(prisma.branch.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ archived_at: null }) }),
      );
    });

    it('should list only archived branches when archived=true', async () => {
      prisma.branch.findMany.mockResolvedValue([
        { ...mockBranch, archived_at: new Date('2026-08-28T10:00:00.000Z') },
      ]);
      prisma.branch.count.mockResolvedValue(1);
      const result = await service.findAll('church-1', { archived: true });

      expect(prisma.branch.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ archived_at: { not: null } }) }),
      );
      expect(result.data[0].archivedAt).toBe('2026-08-28T10:00:00.000Z');
    });
  });

  describe('findOne', () => {
    it('should return a single branch', async () => {
      prisma.branch.findUnique.mockResolvedValue(mockBranch);

      const result = await service.findOne('branch-1', 'church-1');

      expect(result.branchId).toBe('branch-1');
    });

    it('should throw NotFoundException if branch not found', async () => {
      prisma.branch.findUnique.mockResolvedValue(null);

      await expect(service.findOne('nonexistent', 'church-1')).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException if branch belongs to different church', async () => {
      prisma.branch.findUnique.mockResolvedValue({ ...mockBranch, church_id: 'other-church' });

      await expect(service.findOne('branch-1', 'church-1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('update', () => {
    it('should update branch details', async () => {
      prisma.branch.findUnique.mockResolvedValue(mockBranch);
      prisma.branch.update.mockResolvedValue({ ...mockBranch, name: 'New Name' });

      const result = await service.update('branch-1', { name: 'New Name' }, 'church-1', 'user-1');

      expect(result.name).toBe('New Name');
      expect(auditLog).toHaveBeenCalled();
    });

    it('should delete old photo when updating photoUrl', async () => {
      const branchWithPhoto = { ...mockBranch, photo_url: 'https://old-photo.jpg' };
      prisma.branch.findUnique.mockResolvedValue(branchWithPhoto);
      prisma.branch.update.mockResolvedValue({
        ...branchWithPhoto,
        photo_url: 'https://new-photo.jpg',
      });

      await service.update('branch-1', { photoUrl: 'https://new-photo.jpg' }, 'church-1', 'user-1');

      expect(mediaDelete).toHaveBeenCalledWith('https://old-photo.jpg');
    });

    it('should default country to Nigeria on create when not provided', async () => {
      prisma.branch.findFirst.mockResolvedValue(null);
      prisma.branch.create.mockResolvedValue(mockBranch);

      await service.create({ name: 'Ikeja Campus' }, 'church-1', 'user-1');

      expect(prisma.branch.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ country: 'Nigeria' }) }),
      );
    });

    it('should persist country on update', async () => {
      prisma.branch.findUnique.mockResolvedValue(mockBranch);
      prisma.branch.update.mockResolvedValue({ ...mockBranch, country: 'Ghana' });

      const result = await service.update('branch-1', { country: 'Ghana' }, 'church-1', 'user-1');

      expect(prisma.branch.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ country: 'Ghana' }) }),
      );
      expect(result.country).toBe('Ghana');
    });

    it('should allow promoting a branch to headquarters', async () => {
      const nonHQ = { ...mockBranch, is_headquarters: false };
      prisma.branch.findUnique.mockResolvedValue(nonHQ);
      prisma.branch.findFirst.mockResolvedValue(null); // no other HQ exists
      prisma.branch.update.mockResolvedValue({ ...nonHQ, is_headquarters: true });

      const result = await service.update(
        'branch-1',
        { isHeadquarters: true },
        'church-1',
        'user-1',
      );

      expect(prisma.branch.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ is_headquarters: true }) }),
      );
      expect(result.isHeadquarters).toBe(true);
    });

    it('should reject promoting to headquarters when another HQ exists', async () => {
      const nonHQ = { ...mockBranch, id: 'branch-2', is_headquarters: false };
      prisma.branch.findUnique.mockResolvedValue(nonHQ);
      prisma.branch.findFirst.mockResolvedValue(mockBranch); // another HQ exists

      await expect(
        service.update('branch-2', { isHeadquarters: true }, 'church-1', 'user-1'),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('remove', () => {
    it('should delete branch with no members', async () => {
      const branchNoMembers = { ...mockBranch, _count: { members: 0 } };
      prisma.branch.findUnique.mockResolvedValue(branchNoMembers);
      prisma.branch.delete.mockResolvedValue({});

      const result = await service.remove('branch-1', 'church-1', 'user-1');

      expect(result.success).toBe(true);
      expect(auditLog).toHaveBeenCalled();
    });

    it('should throw BadRequestException if branch has members', async () => {
      prisma.branch.findUnique.mockResolvedValue({
        ...mockBranch,
        _count: { members: 5 },
      });

      await expect(service.remove('branch-1', 'church-1', 'user-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should delete old photo when deleting branch', async () => {
      const branchWithPhoto = {
        ...mockBranch,
        photo_url: 'https://photo.jpg',
        _count: { members: 0 },
      };
      prisma.branch.findUnique.mockResolvedValue(branchWithPhoto);
      prisma.branch.delete.mockResolvedValue({});

      await service.remove('branch-1', 'church-1', 'user-1');

      expect(mediaDelete).toHaveBeenCalledWith('https://photo.jpg');
    });

    it('should still allow hard delete (purge) of an archived branch', async () => {
      prisma.branch.findUnique.mockResolvedValue({
        ...mockBranch,
        archived_at: new Date(),
        _count: { members: 0 },
      });
      prisma.branch.delete.mockResolvedValue({});

      await expect(service.remove('branch-1', 'church-1', 'user-1')).resolves.toEqual({
        success: true,
      });
      expect(prisma.branch.delete).toHaveBeenCalled();
    });
  });

  describe('archive', () => {
    const archivedAt = new Date('2026-08-28T12:00:00.000Z');

    it('should set archived_at and audit ARCHIVE', async () => {
      prisma.branch.findUnique.mockResolvedValue(mockBranch);
      prisma.branch.update.mockResolvedValue({ ...mockBranch, archived_at: archivedAt });

      const result = await service.archive('branch-1', 'church-1', 'user-1');

      expect(prisma.branch.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { archived_at: expect.any(Date) } }),
      );
      expect(result.archivedAt).toBe(archivedAt.toISOString());
      expect(auditLog).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'ARCHIVE', entity: 'branch' }),
      );
    });

    it('should throw ConflictException when already archived', async () => {
      prisma.branch.findUnique.mockResolvedValue({ ...mockBranch, archived_at: archivedAt });

      await expect(service.archive('branch-1', 'church-1', 'user-1')).rejects.toThrow(
        ConflictException,
      );
    });

    it('should throw NotFoundException for missing branch', async () => {
      prisma.branch.findUnique.mockResolvedValue(null);

      await expect(service.archive('branch-1', 'church-1', 'user-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('restore', () => {
    it('should clear archived_at and audit RESTORE', async () => {
      prisma.branch.findUnique.mockResolvedValue({
        ...mockBranch,
        archived_at: new Date('2026-08-27T12:00:00.000Z'),
      });
      prisma.branch.update.mockResolvedValue(mockBranch);

      const result = await service.restore('branch-1', 'church-1', 'user-1');

      expect(prisma.branch.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { archived_at: null } }),
      );
      expect(result.archivedAt).toBeUndefined();
      expect(auditLog).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'RESTORE', entity: 'branch' }),
      );
    });

    it('should throw ConflictException when not archived', async () => {
      prisma.branch.findUnique.mockResolvedValue(mockBranch);

      await expect(service.restore('branch-1', 'church-1', 'user-1')).rejects.toThrow(
        ConflictException,
      );
    });

    it('should throw NotFoundException for missing branch', async () => {
      prisma.branch.findUnique.mockResolvedValue(null);

      await expect(service.restore('branch-1', 'church-1', 'user-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('archived-row guards', () => {
    it('should reject update of an archived branch with NotFoundException', async () => {
      prisma.branch.findUnique.mockResolvedValue({
        ...mockBranch,
        archived_at: new Date(),
      });

      await expect(service.update('branch-1', { name: 'X' }, 'church-1', 'user-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
