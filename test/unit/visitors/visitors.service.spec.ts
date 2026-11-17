import { plainToInstance } from 'class-transformer';
import { UpdateVisitorDto } from '../../../src/visitors/dto/update-visitor.dto';
import { RequestContextService } from '../../../src/common/services/request-context.service';
import { Test, TestingModule } from '@nestjs/testing';
import { VisitorsService } from '../../../src/visitors/visitors.service';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { AuditLoggingService } from '../../../src/common/services/audit-logging.service';
import { NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';

describe('VisitorsService', () => {
  let service: VisitorsService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prismaMock: any;
  let auditMock: { log: jest.Mock; notifyMutation: jest.Mock };

  const churchId = '11111111-1111-1111-1111-111111111111';
  const userId = '22222222-2222-2222-2222-222222222222';
  const assigneeId = '55555555-5555-5555-5555-555555555555';

  const mockVisitor = {
    id: 'bbbbbbb1-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    church_id: churchId,
    first_name: 'Amina',
    last_name: 'Okafor',
    gender: 'female',
    phone: '+234 801 234 5678',
    whatsapp_number: null,
    email: 'amina@example.com',
    first_visit_date: new Date('2026-07-01'),
    follow_up_status: 'new',
    assigned_to_id: null,
    assigned_to: null,
    notes: null,
    custom_fields: { how_heard: 'Friend' },
    converted_member_id: null,
    converted_at: null,
    created_at: new Date('2026-07-01'),
    updated_at: new Date('2026-07-01'),
  };

  const mockProfile = {
    id: assigneeId,
    church_id: churchId,
    first_name: 'David',
    last_name: 'Adeyemi',
  };

  beforeEach(async () => {
    prismaMock = {
      visitor: {
        create: jest.fn().mockResolvedValue(mockVisitor),
        findMany: jest.fn().mockResolvedValue([mockVisitor]),
        count: jest.fn().mockResolvedValue(1),
        findUnique: jest.fn().mockImplementation(({ where }) => {
          if (where.id === mockVisitor.id) return Promise.resolve(mockVisitor);
          return Promise.resolve(null);
        }),
        update: jest.fn().mockResolvedValue({ ...mockVisitor, follow_up_status: 'contacted' }),
        delete: jest.fn().mockResolvedValue(mockVisitor),
      },
      profile: {
        findUnique: jest.fn().mockImplementation(({ where }) => {
          if (where.id === assigneeId) return Promise.resolve(mockProfile);
          if (where.member_id === 'member-abc') {
            return Promise.resolve({ id: 'profile-from-member', church_id: churchId });
          }
          return Promise.resolve(null);
        }),
      },
      member: {
        create: jest.fn().mockResolvedValue({
          id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
          church_id: churchId,
          first_name: 'Amina',
          last_name: 'Okafor',
          email: 'amina@example.com',
          phone: '+234 801 234 5678',
          whatsapp_number: null,
          branch_id: null,
          status: 'active',
        }),
      },
    };

    prismaMock.$queryRaw = jest.fn().mockResolvedValue([]);
    prismaMock.$transaction = jest.fn((fn) => fn(prismaMock));
    prismaMock.auditLog = { create: jest.fn().mockResolvedValue({}) };
    auditMock = {
      log: jest.fn().mockResolvedValue(undefined),
      notifyMutation: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VisitorsService,
        RequestContextService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: AuditLoggingService, useValue: auditMock },
      ],
    }).compile();

    service = module.get<VisitorsService>(VisitorsService);
  });

  describe('branch isolation', () => {
    const context = new RequestContextService();
    const viewer = {
      church_id: churchId,
      branch_id: 'branch-1',
      role: 'secretary',
      is_admin_hq: false,
    };
    const run = (callback: () => Promise<unknown>) =>
      context.run({ userId, churchId, role: 'secretary', viewer }, callback);

    it('denies detail and mutation access to visitors in another branch', async () => {
      prismaMock.visitor.findUnique.mockResolvedValue({ ...mockVisitor, branch_id: 'branch-2' });
      for (const action of [
        () => service.findOne(mockVisitor.id, churchId),
        () => service.update(mockVisitor.id, { firstName: 'Changed' }, churchId, userId),
        () => service.remove(mockVisitor.id, churchId, userId),
        () => service.archive(mockVisitor.id, churchId, userId),
        () => service.restore(mockVisitor.id, churchId, userId),
        () =>
          service.convertToMember(
            mockVisitor.id,
            { firstName: 'Amina', lastName: 'Okafor' },
            churchId,
            userId,
          ),
      ])
        await expect(run(action)).rejects.toThrow(NotFoundException);
      expect(prismaMock.visitor.update).not.toHaveBeenCalled();
      expect(prismaMock.visitor.delete).not.toHaveBeenCalled();
      expect(prismaMock.member.create).not.toHaveBeenCalled();
    });

    it('fails closed for lists and writes when no branch is assigned', async () => {
      const unassigned = { ...viewer, branch_id: undefined };
      await service.findAll(churchId, {}, unassigned);
      expect(prismaMock.visitor.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: [{ branch_id: '00000000-0000-0000-0000-000000000000' }],
          }),
        }),
      );
      await expect(
        service.create({ firstName: 'Amina' }, churchId, userId, unassigned),
      ).rejects.toThrow('A branch assignment is required');
      expect(prismaMock.visitor.create).not.toHaveBeenCalled();
    });

    it('keeps untagged shared visitors readable for assigned branch staff', async () => {
      await expect(run(() => service.findOne(mockVisitor.id, churchId))).resolves.toBeDefined();
    });
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    it('should create a visitor with defaults', async () => {
      const result = await service.create(
        { firstName: 'Amina', lastName: 'Okafor', email: 'amina@example.com' },
        churchId,
        userId,
      );
      expect(result.firstName).toBe('Amina');
      expect(result.followUpStatus).toBe('new');
      expect(prismaMock.visitor.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            first_name: 'Amina',
            follow_up_status: 'new',
            custom_fields: {},
          }),
        }),
      );
      expect(auditMock.log).toHaveBeenCalled();
    });

    it('should persist gender, first visit date, and custom fields', async () => {
      await service.create(
        {
          firstName: 'Amina',
          gender: 'female',
          firstVisitDate: '2026-08-24T09:00:00.000Z',
          followUpStatus: 'contacted',
          customFields: { prayer_request: 'Job' },
        },
        churchId,
        userId,
      );
      expect(prismaMock.visitor.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            gender: 'female',
            follow_up_status: 'contacted',
            custom_fields: { prayer_request: 'Job' },
          }),
        }),
      );
      const call = (prismaMock.visitor.create as jest.Mock).mock.calls[0][0];
      expect(call.data.first_visit_date).toEqual(new Date('2026-08-24T09:00:00.000Z'));
    });

    it('should create visitor with assigned team member', async () => {
      (prismaMock.visitor.create as jest.Mock).mockImplementation(({ data }) =>
        Promise.resolve({
          ...mockVisitor,
          first_name: data.first_name,
          assigned_to_id: data.assigned_to_id,
          assigned_to: { first_name: 'David', last_name: 'Adeyemi' },
        }),
      );
      const result = await service.create(
        { firstName: 'Amina', assignedToId: assigneeId },
        churchId,
        userId,
      );
      expect(result.assignedToId).toBe(assigneeId);
    });

    it('should reject invalid assignee', async () => {
      (prismaMock.profile.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(
        service.create({ firstName: 'Amina', assignedToId: 'invalid' }, churchId, userId),
      ).rejects.toThrow(BadRequestException);
    });

    it('should resolve member_id to profile_id for assignee', async () => {
      (prismaMock.visitor.create as jest.Mock).mockImplementation(({ data }) =>
        Promise.resolve({
          ...mockVisitor,
          first_name: data.first_name,
          assigned_to_id: data.assigned_to_id,
          assigned_to: { first_name: 'David', last_name: 'Adeyemi' },
        }),
      );
      const result = await service.create(
        { firstName: 'Amina', assignedToId: 'member-abc' },
        churchId,
        userId,
      );
      expect(result.assignedToId).toBe('profile-from-member');
    });

    it("should pin branch to the acting user's branch for branch-restricted creators", async () => {
      (prismaMock.visitor.create as jest.Mock).mockImplementation(({ data }) =>
        Promise.resolve({ ...mockVisitor, branch_id: data.branch_id }),
      );
      await service.create({ firstName: 'Amina' }, churchId, userId, {
        church_id: churchId,
        branch_id: 'branch-9',
        role: 'cell_leader',
      });
      const call = (prismaMock.visitor.create as jest.Mock).mock.calls[0][0];
      expect(call.data.branch_id).toBe('branch-9');
    });

    it('should ignore an explicit branchId for branch-restricted creators', async () => {
      (prismaMock.visitor.create as jest.Mock).mockImplementation(({ data }) =>
        Promise.resolve({ ...mockVisitor, branch_id: data.branch_id }),
      );
      await service.create({ firstName: 'Amina', branchId: 'branch-other' }, churchId, userId, {
        church_id: churchId,
        branch_id: 'branch-9',
        role: 'cell_leader',
      });
      const call = (prismaMock.visitor.create as jest.Mock).mock.calls[0][0];
      expect(call.data.branch_id).toBe('branch-9');
    });

    it('should honor an explicit branchId for HQ creators', async () => {
      prismaMock.branch = { findFirst: jest.fn().mockResolvedValue({ id: 'branch-2' }) };
      (prismaMock.visitor.create as jest.Mock).mockImplementation(({ data }) =>
        Promise.resolve({ ...mockVisitor, branch_id: data.branch_id }),
      );
      await service.create({ firstName: 'Amina', branchId: 'branch-2' }, churchId, userId, {
        church_id: churchId,
        branch_id: 'branch-1',
        role: 'church_admin',
        is_admin_hq: true,
      });
      const call = (prismaMock.visitor.create as jest.Mock).mock.calls[0][0];
      expect(call.data.branch_id).toBe('branch-2');
    });

    it('should reject an explicit branch outside the church for HQ creators', async () => {
      prismaMock.branch = { findFirst: jest.fn().mockResolvedValue(null) };
      await expect(
        service.create({ firstName: 'Amina', branchId: 'branch-foreign' }, churchId, userId, {
          church_id: churchId,
          role: 'church_admin',
          is_admin_hq: true,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('findAll', () => {
    it('should return paginated visitors with meta totals', async () => {
      const result = await service.findAll(churchId, { page: 2, limit: 10 });
      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(prismaMock.visitor.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 10, take: 10 }),
      );
    });

    it('should filter by followUpStatus and assignedToId', async () => {
      await service.findAll(churchId, { followUpStatus: 'new', assignedToId: assigneeId });
      const arg = (prismaMock.visitor.findMany as jest.Mock).mock.calls[0][0];
      expect(arg.where.AND[0].follow_up_status).toBe('new');
      expect(arg.where.AND[1].assigned_to_id).toBe(assigneeId);
    });

    it('should search across name, email, and phone', async () => {
      await service.findAll(churchId, { search: 'Amina' });
      const arg = (prismaMock.visitor.findMany as jest.Mock).mock.calls[0][0];
      expect(arg.where.AND[0].OR).toHaveLength(4);
    });

    it('should scope branch-restricted viewers to their branch plus untagged visitors', async () => {
      await service.findAll(
        churchId,
        {},
        {
          church_id: churchId,
          branch_id: 'branch-1',
          role: 'cell_leader',
        },
      );
      const arg = (prismaMock.visitor.findMany as jest.Mock).mock.calls[0][0];
      expect(arg.where.AND[0].OR).toEqual([{ branch_id: 'branch-1' }, { branch_id: null }]);
    });

    it('should not scope HQ viewers by branch', async () => {
      await service.findAll(
        churchId,
        {},
        {
          church_id: churchId,
          branch_id: 'branch-1',
          role: 'church_admin',
          is_admin_hq: true,
        },
      );
      const arg = (prismaMock.visitor.findMany as jest.Mock).mock.calls[0][0];
      expect(arg.where.AND).toBeUndefined();
    });

    it('should map branchId and branchName in responses', async () => {
      (prismaMock.visitor.findMany as jest.Mock).mockResolvedValueOnce([
        { ...mockVisitor, branch_id: 'branch-1', branch: { id: 'branch-1', name: 'Lekki' } },
      ]);
      const result = await service.findAll(churchId, {});
      expect(result.data[0].branchId).toBe('branch-1');
      expect(result.data[0].branchName).toBe('Lekki');
    });

    it('should map camelCase sortBy to snake_case columns', async () => {
      await service.findAll(churchId, { sortBy: 'firstName', sortOrder: 'asc' });
      const arg = (prismaMock.visitor.findMany as jest.Mock).mock.calls[0][0];
      expect(arg.orderBy).toEqual([{ first_name: 'asc' }]);
    });

    it('should default sort to newest first', async () => {
      await service.findAll(churchId, {});
      const arg = (prismaMock.visitor.findMany as jest.Mock).mock.calls[0][0];
      expect(arg.orderBy).toEqual([{ created_at: 'desc' }]);
    });

    it('should exclude soft-deleted (converted) visitors from pulls', async () => {
      await service.findAll(churchId, {});
      const arg = (prismaMock.visitor.findMany as jest.Mock).mock.calls[0][0];
      expect(arg.where.deleted_at).toBeNull();
      expect(arg.where.church_id).toBe(churchId);
    });

    it('should exclude archived visitors by default', async () => {
      await service.findAll(churchId, {});
      const arg = (prismaMock.visitor.findMany as jest.Mock).mock.calls[0][0];
      expect(arg.where.archived_at).toBeNull();
    });

    it('should list only archived visitors when archived=true', async () => {
      await service.findAll(churchId, { archived: true });
      const arg = (prismaMock.visitor.findMany as jest.Mock).mock.calls[0][0];
      expect(arg.where.archived_at).toEqual({ not: null });
    });

    it('should map archivedAt in responses', async () => {
      (prismaMock.visitor.findMany as jest.Mock).mockResolvedValueOnce([
        { ...mockVisitor, archived_at: new Date('2026-08-28T10:00:00.000Z') },
      ]);
      const result = await service.findAll(churchId, { archived: true });
      expect(result.data[0].archivedAt).toBe('2026-08-28T10:00:00.000Z');
    });
  });

  describe('findOne', () => {
    it('should return a visitor by ID including gender and customFields', async () => {
      const result = await service.findOne(mockVisitor.id, churchId);
      expect(result.id).toBe(mockVisitor.id);
      expect(result.gender).toBe('female');
      expect(result.customFields).toEqual({ how_heard: 'Friend' });
    });

    it('should throw NotFoundException for wrong church', async () => {
      (prismaMock.visitor.findUnique as jest.Mock).mockResolvedValueOnce({
        ...mockVisitor,
        church_id: 'wrong',
      });
      await expect(service.findOne(mockVisitor.id, churchId)).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException for missing visitor', async () => {
      (prismaMock.visitor.findUnique as jest.Mock).mockResolvedValueOnce(null);
      await expect(service.findOne('nonexistent', churchId)).rejects.toThrow(NotFoundException);
    });
  });

  describe('update', () => {
    it('persists an active church-owned branch change for HQ', async () => {
      prismaMock.branch = { findFirst: jest.fn().mockResolvedValue({ id: 'branch-2' }) };
      prismaMock.visitor.update.mockResolvedValue({
        ...mockVisitor,
        branch_id: 'branch-2',
        branch: { id: 'branch-2', name: 'East' },
      });
      const result = await new RequestContextService().run(
        {
          churchId,
          userId,
          role: 'church_admin',
          viewer: { church_id: churchId, role: 'church_admin', is_admin_hq: true },
        },
        () => service.update(mockVisitor.id, { branchId: 'branch-2' }, churchId, userId),
      );
      expect(prismaMock.branch.findFirst).toHaveBeenCalledWith({
        where: { id: 'branch-2', church_id: churchId, archived_at: null },
        select: { id: true },
      });
      expect(prismaMock.visitor.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { branch: { connect: { id: 'branch-2' } } } }),
      );
      expect(result).toMatchObject({ branchId: 'branch-2', branchName: 'East' });
    });

    it.each(['foreign', 'archived', 'missing'])(
      'rejects reassignment to an unavailable %s branch',
      async (branchId) => {
        prismaMock.branch = { findFirst: jest.fn().mockResolvedValue(null) };
        await expect(
          service.update(mockVisitor.id, { branchId }, churchId, userId),
        ).rejects.toThrow(BadRequestException);
        expect(prismaMock.visitor.update).not.toHaveBeenCalled();
      },
    );

    it('rejects branch-scoped cross-branch reassignment', async () => {
      prismaMock.visitor.findUnique.mockResolvedValue({ ...mockVisitor, branch_id: 'branch-1' });
      await expect(
        new RequestContextService().run(
          {
            churchId,
            userId,
            role: 'secretary',
            viewer: { church_id: churchId, role: 'secretary', branch_id: 'branch-1' },
          },
          () => service.update(mockVisitor.id, { branchId: 'branch-2' }, churchId, userId),
        ),
      ).rejects.toThrow('You can only manage records in your branch');
      expect(prismaMock.visitor.update).not.toHaveBeenCalled();
    });

    it('should update visitor follow-up status and gender', async () => {
      const result = await service.update(
        mockVisitor.id,
        { followUpStatus: 'contacted', gender: 'male' },
        churchId,
        userId,
      );
      expect(result.followUpStatus).toBe('contacted');
      expect(prismaMock.visitor.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ follow_up_status: 'contacted', gender: 'male' }),
        }),
      );
    });

    it('should disconnect assignee when cleared', async () => {
      await service.update(mockVisitor.id, { assignedToId: '' }, churchId, userId);
      const arg = (prismaMock.visitor.update as jest.Mock).mock.calls[0][0];
      expect(arg.data.assigned_to).toEqual({ disconnect: true });
    });

    it('should throw NotFoundException for missing visitor', async () => {
      (prismaMock.visitor.findUnique as jest.Mock).mockResolvedValueOnce(null);
      await expect(
        service.update('nonexistent', { notes: 'test' }, churchId, userId),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('convertToMember', () => {
    it('should convert and carry gender + custom fields into the member', async () => {
      (prismaMock.visitor.findUnique as jest.Mock).mockResolvedValueOnce({
        ...mockVisitor,
        follow_up_status: 'interested',
      });
      (prismaMock.visitor.update as jest.Mock).mockResolvedValueOnce({
        ...mockVisitor,
        follow_up_status: 'converted',
        converted_member_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        converted_at: new Date(),
      });

      const result = await service.convertToMember(
        mockVisitor.id,
        { firstName: 'Amina', lastName: 'Okafor' },
        churchId,
        userId,
      );
      expect(result.memberId).toBe('cccccccc-cccc-cccc-cccc-cccccccccccc');
      expect(result.visitor.followUpStatus).toBe('converted');
      expect(prismaMock.member.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            gender: 'female',
            custom_fields: { how_heard: 'Friend' },
          }),
        }),
      );
      expect(prismaMock.visitor.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            follow_up_status: 'converted',
            deleted_at: expect.any(Date),
          }),
        }),
      );
    });

    it('should return the existing conversion on retry', async () => {
      (prismaMock.visitor.findUnique as jest.Mock).mockResolvedValueOnce({
        ...mockVisitor,
        follow_up_status: 'converted',
        converted_member_id: 'some-id',
      });
      await expect(
        service.convertToMember(
          mockVisitor.id,
          { firstName: 'Amina', lastName: 'Okafor' },
          churchId,
          userId,
        ),
      ).resolves.toMatchObject({ memberId: 'some-id' });
      expect(prismaMock.member.create).not.toHaveBeenCalled();
    });

    it('should throw NotFoundException for missing visitor', async () => {
      (prismaMock.visitor.findUnique as jest.Mock).mockResolvedValueOnce(null);
      await expect(
        service.convertToMember(
          'nonexistent',
          { firstName: 'Amina', lastName: 'Okafor' },
          churchId,
          userId,
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('remove', () => {
    it('should delete a visitor', async () => {
      await service.remove(mockVisitor.id, churchId, userId);
      expect(prismaMock.visitor.delete).toHaveBeenCalled();
    });

    it('should throw NotFoundException for missing visitor', async () => {
      (prismaMock.visitor.findUnique as jest.Mock).mockResolvedValueOnce(null);
      await expect(service.remove('nonexistent', churchId, userId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('archive', () => {
    it('should set archived_at and audit ARCHIVE', async () => {
      const archivedAt = new Date('2026-08-28T12:00:00.000Z');
      (prismaMock.visitor.update as jest.Mock).mockResolvedValueOnce({
        ...mockVisitor,
        archived_at: archivedAt,
      });

      const result = await service.archive(mockVisitor.id, churchId, userId);
      expect(prismaMock.visitor.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { archived_at: expect.any(Date) } }),
      );
      expect(result.archivedAt).toBe(archivedAt.toISOString());
      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'ARCHIVE', entity: 'visitor' }),
      );
    });

    it('should throw ConflictException when already archived', async () => {
      (prismaMock.visitor.findUnique as jest.Mock).mockResolvedValueOnce({
        ...mockVisitor,
        archived_at: new Date(),
      });
      await expect(service.archive(mockVisitor.id, churchId, userId)).rejects.toThrow(
        ConflictException,
      );
    });

    it('should throw NotFoundException for missing visitor', async () => {
      (prismaMock.visitor.findUnique as jest.Mock).mockResolvedValueOnce(null);
      await expect(service.archive('nonexistent', churchId, userId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('restore', () => {
    it('should clear archived_at and audit RESTORE', async () => {
      (prismaMock.visitor.findUnique as jest.Mock).mockResolvedValueOnce({
        ...mockVisitor,
        archived_at: new Date('2026-08-27T12:00:00.000Z'),
      });
      (prismaMock.visitor.update as jest.Mock).mockResolvedValueOnce(mockVisitor);

      const result = await service.restore(mockVisitor.id, churchId, userId);
      expect(prismaMock.visitor.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { archived_at: null } }),
      );
      expect(result.archivedAt).toBeUndefined();
      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'RESTORE', entity: 'visitor' }),
      );
    });

    it('should throw ConflictException when not archived', async () => {
      await expect(service.restore(mockVisitor.id, churchId, userId)).rejects.toThrow(
        ConflictException,
      );
    });

    it('should throw NotFoundException for missing visitor', async () => {
      (prismaMock.visitor.findUnique as jest.Mock).mockResolvedValueOnce(null);
      await expect(service.restore('nonexistent', churchId, userId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('archived-row guards', () => {
    it('should reject update of an archived visitor with NotFoundException', async () => {
      (prismaMock.visitor.findUnique as jest.Mock).mockResolvedValueOnce({
        ...mockVisitor,
        archived_at: new Date(),
      });
      await expect(
        service.update(mockVisitor.id, { notes: 'x' }, churchId, userId),
      ).rejects.toThrow(NotFoundException);
    });

    it('should reject converting an archived visitor with NotFoundException', async () => {
      (prismaMock.visitor.findUnique as jest.Mock).mockResolvedValueOnce({
        ...mockVisitor,
        archived_at: new Date(),
      });
      await expect(
        service.convertToMember(
          mockVisitor.id,
          { firstName: 'Amina', lastName: 'Okafor' },
          churchId,
          userId,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('should still allow hard delete (purge) of an archived visitor', async () => {
      (prismaMock.visitor.findUnique as jest.Mock).mockResolvedValueOnce({
        ...mockVisitor,
        archived_at: new Date(),
      });
      await expect(service.remove(mockVisitor.id, churchId, userId)).resolves.toBeUndefined();
      expect(prismaMock.visitor.delete).toHaveBeenCalled();
    });
  });

  describe('getVisitorsSummary', () => {
    it('should return all four stats from parallel counts', async () => {
      const result = await service.getVisitorsSummary(churchId);
      expect(result).toEqual({ total: 1, newThisMonth: 1, inFollowUp: 1, converted: 1 });
      expect(prismaMock.visitor.count).toHaveBeenCalledTimes(4);
    });

    it('should scope every count to the church and exclude deleted/archived visitors', async () => {
      await service.getVisitorsSummary(churchId);
      for (const call of (prismaMock.visitor.count as jest.Mock).mock.calls) {
        expect(call[0].where.church_id).toBe(churchId);
        expect(call[0].where.deleted_at).toBeNull();
        expect(call[0].where.archived_at).toBeNull();
      }
    });

    it('should count new visitors since the start of the current UTC month', async () => {
      await service.getVisitorsSummary(churchId);
      const newWhere = (prismaMock.visitor.count as jest.Mock).mock.calls[1][0].where;
      const expectedStart = new Date(
        Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1),
      );
      expect(newWhere.first_visit_date).toEqual({ gte: expectedStart });
    });

    it('should scope the in-follow-up count to active statuses without conversion', async () => {
      await service.getVisitorsSummary(churchId);
      const followUpWhere = (prismaMock.visitor.count as jest.Mock).mock.calls[2][0].where;
      expect(followUpWhere.follow_up_status.in).toEqual([
        'new',
        'contacted',
        'follow_up_scheduled',
        'interested',
      ]);
      expect(followUpWhere.converted_member_id).toBeNull();
    });

    it('should count converted visitors via member link or converted status', async () => {
      await service.getVisitorsSummary(churchId);
      const convertedWhere = (prismaMock.visitor.count as jest.Mock).mock.calls[3][0].where;
      expect(convertedWhere.OR).toEqual([
        { converted_member_id: { not: null } },
        { follow_up_status: 'converted' },
      ]);
    });

    it('should branch-scope a non-HQ viewer to their branch plus untagged visitors', async () => {
      await service.getVisitorsSummary(churchId, {
        church_id: churchId,
        branch_id: 'branch-1',
        role: 'cell_leader',
      });
      const where = (prismaMock.visitor.count as jest.Mock).mock.calls[0][0].where;
      expect(where.AND[0].OR).toEqual([{ branch_id: 'branch-1' }, { branch_id: null }]);
    });

    it('should not branch-scope an HQ viewer', async () => {
      await service.getVisitorsSummary(churchId, {
        church_id: churchId,
        branch_id: 'branch-1',
        role: 'church_admin',
        is_admin_hq: true,
      });
      const where = (prismaMock.visitor.count as jest.Mock).mock.calls[0][0].where;
      expect(where.AND).toBeUndefined();
    });
  });
  describe('nullable visitor edits and contact history', () => {
    it.each(['set', 'clear'])(
      'explicitly sets or clears contact, assignment and custom fields (%s)',
      async (mode) => {
        const clear = mode === 'clear';
        prismaMock.visitor.update.mockResolvedValue({
          ...mockVisitor,
          last_name: clear ? null : 'Guest',
          gender: clear ? null : 'female',
          phone: clear ? null : '+2348012345678',
          email: clear ? null : 'ada@example.invalid',
          custom_fields: clear ? null : {},
          assigned_to: clear ? null : { first_name: 'David', last_name: 'Adeyemi' },
        });
        const result = await service.update(
          mockVisitor.id,
          plainToInstance(UpdateVisitorDto, {
            firstName: 'Ada',
            lastName: clear ? null : 'Guest',
            gender: clear ? null : 'female',
            phone: clear ? null : '+2348012345678',
            whatsappNumber: clear ? null : '+2348012345678',
            email: clear ? null : 'ada@example.invalid',
            firstVisitDate: '2026-01-01',
            notes: clear ? null : 'Care requested',
            customFields: {},
            assignedToId: clear ? null : assigneeId,
            branchId: null,
          }),
          churchId,
          userId,
        );
        expect(prismaMock.visitor.update.mock.calls[0][0].data).toMatchObject({
          first_name: 'Ada',
          last_name: clear ? null : 'Guest',
          first_visit_date: new Date('2026-01-01'),
          custom_fields: {},
          branch: { disconnect: true },
          assigned_to: clear ? { disconnect: true } : { connect: { id: assigneeId } },
        });
        expect(result).toMatchObject({
          lastName: clear ? undefined : 'Guest',
          gender: clear ? undefined : 'female',
          email: clear ? undefined : 'ada@example.invalid',
          customFields: clear ? undefined : {},
        });
      },
    );
    it('uses descending date order when the client omits a direction for an explicit sort', async () => {
      await service.findAll(churchId, { sortBy: 'firstVisitDate' });
      expect(prismaMock.visitor.findMany.mock.calls[0][0].orderBy).toEqual([
        { first_visit_date: 'desc' },
      ]);
    });
  });
});
