import { RequestContextService } from '../../../src/common/services/request-context.service';
/**
 * @file members.service.spec.ts
 * @description Unit tests for MembersService.
 *
 * Tests CRUD operations, search, pagination, and audit logging.
 * All external dependencies (Prisma, AuditLogging) are mocked.
 *
 * @module test/unit/members/members.service.spec
 * @since 1.0.0
 */

import { MembersService } from '../../../src/members/members.service';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { AuditLoggingService } from '../../../src/common/services/audit-logging.service';
import { BranchScopeService } from '../../../src/common/services/branch-scope.service';
import { NotFoundException, ConflictException } from '@nestjs/common';
import { CreateMemberDto } from '../../../src/members/dto/create-member.dto';
import { UpdateMemberDto } from '../../../src/members/dto/update-member.dto';

describe('MembersService', () => {
  let service: MembersService;
  let prisma: Record<string, unknown> & { $transaction: jest.Mock };
  let audit: { log: jest.Mock };

  const mockUserId = '11111111-1111-1111-1111-111111111111';
  const mockChurchId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const mockMemberId = '44444444-4444-4444-4444-444444444444';

  const mockMember = {
    id: mockMemberId,
    church_id: mockChurchId,
    branch_id: null,
    first_name: 'Chioma',
    last_name: 'Eze',
    email: 'chioma.eze@example.com',
    phone: '+234 803 456 7890',
    whatsapp_number: null,
    date_of_birth: new Date('1990-05-15'),
    gender: 'female',
    address: '12 Admiralty Way',
    city: 'Lagos',
    state: 'Lagos',
    status: 'active',
    member_since: new Date('2024-01-15'),
    photo_url: null,
    custom_fields: {},
    notes: null,
    archived_at: null,
    created_at: new Date('2024-01-15T10:30:00'),
    updated_at: new Date('2024-06-20T14:15:00'),
  };

  function createPrismaMock() {
    const models: Record<string, Record<string, jest.Mock>> = {};
    const $transactionMock = jest.fn();

    const handler: ProxyHandler<Record<string, unknown>> = {
      get(_target, prop: string) {
        if (prop === '$transaction') {
          return $transactionMock;
        }
        if (!models[prop]) {
          models[prop] = {
            findMany: jest.fn(),
            findUnique: jest.fn(),
            findFirst: jest.fn(),
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

  beforeEach(() => {
    prisma = createPrismaMock();
    audit = { log: jest.fn().mockResolvedValue(undefined) };

    service = new MembersService(
      prisma as unknown as PrismaService,
      new RequestContextService(),
      audit as unknown as AuditLoggingService,
      {
        createNotification: jest.fn().mockResolvedValue({}),
        broadcastToChurch: jest.fn().mockResolvedValue({ sent: 0 }),
      } as never,
      new BranchScopeService(new RequestContextService()),
    );
  });

  describe('getDashboard', () => {
    it.each([
      [true, 'branch-a', 'branch-b', 'branch-b'],
      [true, 'branch-a', undefined, undefined],
      [false, 'branch-a', 'branch-b', 'branch-a'],
      [false, undefined, 'branch-b', '00000000-0000-0000-0000-000000000000'],
    ])(
      'keeps church and non-archived scope for HQ=%s own=%s requested=%s',
      async (hq, own, requested, expected) => {
        model('member').findMany.mockResolvedValue([]);
        const result = await service.getDashboard(
          mockChurchId,
          { branchId: requested as string | undefined },
          {
            church_id: mockChurchId,
            role: 'church_admin',
            is_admin_hq: hq as boolean,
            branch_id: own as string | undefined,
          },
        );
        expect(model('member').findMany).toHaveBeenCalledWith({
          where: {
            church_id: mockChurchId,
            archived_at: null,
            ...(expected ? { branch_id: expected } : {}),
          },
          select: { status: true, date_of_birth: true, member_since: true },
        });
        expect(result.total).toBe(0);
        expect(result.growth).toEqual([]);
      },
    );

    it('returns demographic and cumulative growth aggregates without individual records', async () => {
      model('member').findMany.mockResolvedValue([
        {
          status: 'active',
          date_of_birth: new Date(Date.UTC(new Date().getUTCFullYear() - 20, 0, 1)),
          member_since: new Date('2025-02-01'),
        },
        { status: 'inactive', date_of_birth: null, member_since: new Date('2025-01-01') },
        { status: 'active', date_of_birth: null, member_since: new Date('2025-02-02') },
      ]);
      const result = await service.getDashboard(mockChurchId, {});
      expect(Object.keys(result).sort()).toEqual(['byAgeGroup', 'byStatus', 'growth', 'total']);
      expect(result.total).toBe(3);
      expect(result.byStatus).toEqual({ active: 2, inactive: 1 });
      expect(result.byAgeGroup.age_18_30).toBe(1);
      expect(result.byAgeGroup.unspecified).toBe(2);
      expect(result.growth).toEqual([
        { date: '2025-01-01', total: 1, members: 1, visitors: 0 },
        { date: '2025-02-01', total: 3, members: 2, visitors: 0 },
      ]);
    });
  });

  describe('createMember', () => {
    it('should create a member successfully', async () => {
      const dto: CreateMemberDto = {
        firstName: 'Chioma',
        lastName: 'Eze',
        email: 'chioma.eze@example.com',
        phone: '+234 803 456 7890',
      };

      model('member').findFirst.mockResolvedValue(null); // No duplicate phone
      model('member').create.mockResolvedValue(mockMember);
      model('profile').findMany.mockResolvedValue([]);

      const result = await service.createMember(dto, mockChurchId, mockUserId);

      expect(result.memberId).toBe(mockMemberId);
      expect(result.firstName).toBe('Chioma');
      expect(result.lastName).toBe('Eze');
      expect(model('member').create).toHaveBeenCalled();
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entity: 'member',
          action: 'CREATE',
          entityId: mockMemberId,
        }),
      );
    });

    it('should trim whitespace and normalize string values', async () => {
      const dto: CreateMemberDto = {
        firstName: '  Chioma  ',
        lastName: '  Eze  ',
        email: '  chioma.eze@example.com  ',
        phone: '  +234 803 456 7890  ',
      };

      model('member').findFirst.mockResolvedValue(null);
      model('member').create.mockResolvedValue(mockMember);
      model('profile').findMany.mockResolvedValue([]);

      await service.createMember(dto, mockChurchId, mockUserId);

      expect(model('member').create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            first_name: 'Chioma',
            last_name: 'Eze',
            email: 'chioma.eze@example.com',
            phone: '+234 803 456 7890',
          }),
        }),
      );
    });

    it('should throw ConflictException for duplicate phone', async () => {
      const dto: CreateMemberDto = {
        firstName: 'Chioma',
        lastName: 'Eze',
        phone: '+234 803 456 7890',
      };

      model('member').findFirst.mockResolvedValue({ id: 'existing-member' });

      await expect(service.createMember(dto, mockChurchId, mockUserId)).rejects.toThrow(
        ConflictException,
      );
    });

    it('should create member without phone check when phone is not provided', async () => {
      const dto: CreateMemberDto = {
        firstName: 'Chioma',
        lastName: 'Eze',
      };

      model('member').create.mockResolvedValue({
        ...mockMember,
        phone: null,
      });
      model('profile').findMany.mockResolvedValue([]);

      const result = await service.createMember(dto, mockChurchId, mockUserId);

      expect(result.phone).toBeUndefined();
      expect(model('member').findFirst).not.toHaveBeenCalled();
    });
  });

  describe('getMemberById', () => {
    it('should return a member by ID', async () => {
      model('member').findUnique.mockResolvedValue(mockMember);

      const result = await service.getMemberById(mockMemberId, mockChurchId);

      expect(result.memberId).toBe(mockMemberId);
      expect(result.firstName).toBe('Chioma');
    });

    it('should hide sensitive member fields when the viewer lacks access', async () => {
      model('member').findUnique.mockResolvedValue(mockMember);

      const result = await service.getMemberById(mockMemberId, mockChurchId, ['members:read']);

      expect(result.email).toBeUndefined();
      expect(result.phone).toBeUndefined();
      expect(result.address).toBeUndefined();
    });

    it('should throw NotFoundException if member not found', async () => {
      model('member').findUnique.mockResolvedValue(null);

      await expect(service.getMemberById('nonexistent-id', mockChurchId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException if member belongs to another church', async () => {
      model('member').findUnique.mockResolvedValue({
        ...mockMember,
        church_id: 'other-church-id',
      });

      await expect(service.getMemberById(mockMemberId, mockChurchId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('listMembers', () => {
    it('should return paginated members', async () => {
      model('member').findMany.mockResolvedValue([mockMember]);
      model('member').count.mockResolvedValue(1);

      const result = await service.listMembers(mockChurchId, {});

      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.data[0].memberId).toBe(mockMemberId);
    });

    it('should apply status filter', async () => {
      model('member').findMany.mockResolvedValue([]);
      model('member').count.mockResolvedValue(0);

      await service.listMembers(mockChurchId, { status: 'active' });

      expect(model('member').findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'active',
          }),
        }),
      );
    });

    it('should scope a non-HQ viewer to their own branch', async () => {
      model('member').findMany.mockResolvedValue([]);
      model('member').count.mockResolvedValue(0);

      await service.listMembers(mockChurchId, {}, ['members:read'], {
        church_id: mockChurchId,
        branch_id: 'branch-a',
        role: 'branch_pastor',
        is_admin_hq: false,
      });

      expect(model('member').findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ branch_id: 'branch-a' }),
        }),
      );
    });

    it('should NOT branch-scope an admin-hq viewer', async () => {
      model('member').findMany.mockResolvedValue([]);
      model('member').count.mockResolvedValue(0);

      await service.listMembers(mockChurchId, { branchId: 'branch-a' }, ['members:read'], {
        church_id: mockChurchId,
        branch_id: 'branch-b',
        role: 'church_admin',
        is_admin_hq: true,
      });

      expect(model('member').findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ branch_id: 'branch-a' }),
        }),
      );
    });

    it('should apply search filter', async () => {
      model('member').findMany.mockResolvedValue([]);
      model('member').count.mockResolvedValue(0);

      await service.listMembers(mockChurchId, { search: 'Chioma' });

      expect(model('member').findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.arrayContaining([
              expect.objectContaining({
                first_name: expect.objectContaining({ contains: 'Chioma' }),
              }),
            ]),
          }),
        }),
      );
    });

    it('should apply pagination', async () => {
      model('member').findMany.mockResolvedValue([]);
      model('member').count.mockResolvedValue(0);

      await service.listMembers(mockChurchId, { page: 2, limit: 10 });

      expect(model('member').findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 10,
          take: 10,
        }),
      );
    });

    it('should exclude archived members by default', async () => {
      model('member').findMany.mockResolvedValue([]);
      model('member').count.mockResolvedValue(0);

      await service.listMembers(mockChurchId, {});

      expect(model('member').findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ archived_at: null }) }),
      );
    });

    it('should list only archived members when archived=true', async () => {
      model('member').findMany.mockResolvedValue([
        { ...mockMember, archived_at: new Date('2026-08-28T10:00:00.000Z') },
      ]);
      model('member').count.mockResolvedValue(1);

      const result = await service.listMembers(mockChurchId, { archived: true });

      expect(model('member').findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ archived_at: { not: null } }),
        }),
      );
      expect(result.data[0].archivedAt).toBe('2026-08-28T10:00:00.000Z');
    });
  });

  describe('updateMember', () => {
    it('should update a member successfully', async () => {
      const dto: UpdateMemberDto = {
        firstName: 'Chioma Updated',
      };

      model('member').findUnique.mockResolvedValue(mockMember);
      model('member').update.mockResolvedValue({
        ...mockMember,
        first_name: 'Chioma Updated',
      });

      const result = await service.updateMember(mockMemberId, dto, mockChurchId, mockUserId);

      expect(result.firstName).toBe('Chioma Updated');
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entity: 'member',
          action: 'UPDATE',
        }),
      );
    });

    it('should throw NotFoundException if member not found', async () => {
      model('member').findUnique.mockResolvedValue(null);

      await expect(
        service.updateMember('nonexistent-id', { firstName: 'Test' }, mockChurchId, mockUserId),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ConflictException for duplicate phone', async () => {
      model('member').findUnique.mockResolvedValue(mockMember);
      model('member').findFirst.mockResolvedValue({ id: 'other-member' });

      await expect(
        service.updateMember(
          mockMemberId,
          { phone: '+234 999 999 9999' },
          mockChurchId,
          mockUserId,
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('should return existing member if nothing to update', async () => {
      model('member').findUnique.mockResolvedValue(mockMember);

      const result = await service.updateMember(mockMemberId, {}, mockChurchId, mockUserId);

      expect(result.memberId).toBe(mockMemberId);
      expect(model('member').update).not.toHaveBeenCalled();
    });

    it('should throw NotFoundException when updating an archived member', async () => {
      model('member').findUnique.mockResolvedValue({
        ...mockMember,
        archived_at: new Date('2026-08-28T10:00:00.000Z'),
      });

      await expect(
        service.updateMember(mockMemberId, { firstName: 'X' }, mockChurchId, mockUserId),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('softDeleteMember', () => {
    it('should soft-delete a member', async () => {
      model('member').findUnique.mockResolvedValue(mockMember);
      model('member').update.mockResolvedValue({});

      await service.softDeleteMember(mockMemberId, mockChurchId, mockUserId);

      expect(model('member').update).toHaveBeenCalledWith({
        where: { id: mockMemberId },
        data: { status: 'inactive' },
      });
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entity: 'member',
          action: 'DELETE',
        }),
      );
    });

    it('should throw NotFoundException if member not found', async () => {
      model('member').findUnique.mockResolvedValue(null);

      await expect(
        service.softDeleteMember('nonexistent-id', mockChurchId, mockUserId),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('archiveMember', () => {
    it('should set archived_at and audit ARCHIVE', async () => {
      const archivedAt = new Date('2026-08-28T12:00:00.000Z');
      model('member').findUnique.mockResolvedValue(mockMember);
      model('member').update.mockResolvedValue({ ...mockMember, archived_at: archivedAt });

      const result = await service.archiveMember(mockMemberId, mockChurchId, mockUserId);

      expect(model('member').update).toHaveBeenCalledWith({
        where: { id: mockMemberId },
        data: { archived_at: expect.any(Date) },
      });
      expect(result.archivedAt).toBe(archivedAt.toISOString());
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'ARCHIVE', entity: 'member' }),
      );
    });

    it('should throw ConflictException when already archived', async () => {
      model('member').findUnique.mockResolvedValue({
        ...mockMember,
        archived_at: new Date(),
      });

      await expect(service.archiveMember(mockMemberId, mockChurchId, mockUserId)).rejects.toThrow(
        ConflictException,
      );
    });

    it('should throw NotFoundException if member not found', async () => {
      model('member').findUnique.mockResolvedValue(null);

      await expect(service.archiveMember(mockMemberId, mockChurchId, mockUserId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('restoreArchivedMember', () => {
    it('should clear archived_at and audit RESTORE', async () => {
      model('member').findUnique.mockResolvedValue({
        ...mockMember,
        archived_at: new Date('2026-08-27T12:00:00.000Z'),
      });
      model('member').update.mockResolvedValue(mockMember);

      const result = await service.restoreArchivedMember(mockMemberId, mockChurchId, mockUserId);

      expect(model('member').update).toHaveBeenCalledWith({
        where: { id: mockMemberId },
        data: { archived_at: null },
      });
      expect(result.archivedAt).toBeUndefined();
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'RESTORE', entity: 'member' }),
      );
    });

    it('should throw ConflictException when not archived', async () => {
      model('member').findUnique.mockResolvedValue(mockMember);

      await expect(
        service.restoreArchivedMember(mockMemberId, mockChurchId, mockUserId),
      ).rejects.toThrow(ConflictException);
    });

    it('should throw NotFoundException if member not found', async () => {
      model('member').findUnique.mockResolvedValue(null);

      await expect(
        service.restoreArchivedMember(mockMemberId, mockChurchId, mockUserId),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('purge (soft-delete) on archived member', () => {
    it('should still allow soft-delete on an archived member', async () => {
      model('member').findUnique.mockResolvedValue({
        ...mockMember,
        archived_at: new Date('2026-08-28T10:00:00.000Z'),
      });
      model('member').update.mockResolvedValue({});

      await service.softDeleteMember(mockMemberId, mockChurchId, mockUserId);

      expect(model('member').update).toHaveBeenCalled();
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'DELETE', entity: 'member' }),
      );
    });
  });

  describe('mutation guard on archived members', () => {
    it('should throw NotFoundException when adding a note to an archived member', async () => {
      model('member').findUnique.mockResolvedValue({
        id: mockMemberId,
        church_id: mockChurchId,
        notes: null,
        archived_at: new Date('2026-08-28T10:00:00.000Z'),
      });

      await expect(
        service.addMemberNote(mockMemberId, 'hello', mockChurchId, mockUserId),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('searchMembers', () => {
    it('applies an HQ picker branch filter before limiting search results', async () => {
      model('member').findMany.mockResolvedValue([]);
      await service.searchMembers(
        mockChurchId,
        'Chioma',
        20,
        [],
        { church_id: mockChurchId, role: 'treasurer', is_admin_hq: true },
        'branch-b',
      );
      expect(model('member').findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ church_id: mockChurchId, branch_id: 'branch-b' }),
          take: 20,
        }),
      );
    });

    it('ignores another requested branch for a branch-only picker', async () => {
      model('member').findMany.mockResolvedValue([]);
      await service.searchMembers(
        mockChurchId,
        'Chioma',
        20,
        [],
        { church_id: mockChurchId, role: 'treasurer', branch_id: 'branch-a', is_admin_hq: false },
        'branch-b',
      );
      expect(model('member').findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ church_id: mockChurchId, branch_id: 'branch-a' }),
        }),
      );
    });

    it('should return matching members', async () => {
      model('member').findMany.mockResolvedValue([mockMember]);

      const result = await service.searchMembers(mockChurchId, 'Chioma');

      expect(result).toHaveLength(1);
      expect(result[0].firstName).toBe('Chioma');
    });

    it('should return empty array for empty search term', async () => {
      const result = await service.searchMembers(mockChurchId, '');

      expect(result).toHaveLength(0);
      expect(model('member').findMany).not.toHaveBeenCalled();
    });

    it('should apply limit parameter', async () => {
      model('member').findMany.mockResolvedValue([]);

      await service.searchMembers(mockChurchId, 'test', 5);

      expect(model('member').findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 5,
        }),
      );
    });
  });
});
