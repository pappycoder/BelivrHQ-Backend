import { plainToInstance } from 'class-transformer';
import { CreateDepartmentDto } from '../../../src/admin/dto/create-department.dto';
import { RequestContextService } from '../../../src/common/services/request-context.service';
import { Test, TestingModule } from '@nestjs/testing';
import { AdminService } from '../../../src/admin/admin.service';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { AuditLoggingService } from '../../../src/common/services/audit-logging.service';
import { BranchScopeService } from '../../../src/common/services/branch-scope.service';
import {
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { createPrismaMock } from '../../helpers/prisma-mock.helper';

describe('AdminService', () => {
  let service: AdminService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let auditLog: jest.Mock;

  const mockChurchId = 'church-1';
  const mockUserId = 'user-1';
  const mockDepartmentId = 'dept-1';
  const mockMemberId = 'member-1';
  const mockGroupId = 'group-1';

  const mockDepartment = {
    id: mockDepartmentId,
    church_id: mockChurchId,
    name: 'Youth Ministry',
    description: 'Ministry for youth',
    parent_id: null,
    created_at: new Date('2024-01-01'),
    updated_at: new Date('2024-06-01'),
    department_members: [],
  };

  const mockCellGroup = {
    id: mockGroupId,
    church_id: mockChurchId,
    name: 'Victory Cell',
    address: null,
    leader_id: null,
    latitude: 6.5244,
    longitude: 3.3792,
    meeting_day: 'Sunday',
    meeting_time: '18:00',
    created_at: new Date('2024-01-01'),
    updated_at: new Date('2024-06-01'),
  };

  const mockCellGroupMember = {
    cell_group_id: mockGroupId,
    member_id: mockMemberId,
    role: 'member',
    joined_at: new Date('2024-02-01'),
  };

  beforeEach(async () => {
    prisma = createPrismaMock();
    auditLog = jest.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RequestContextService,
        AdminService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditLoggingService, useValue: { log: auditLog } },
        BranchScopeService,
      ],
    }).compile();

    service = module.get<AdminService>(AdminService);
  });

  describe('Scoped department details and attendance aggregates', () => {
    beforeEach(() => {
      prisma.department.findFirst.mockResolvedValue({
        ...mockDepartment,
        head_member_id: mockMemberId,
        branch_id: 'branch-1',
        branch: { id: 'branch-1', name: 'Main' },
        department_members: [
          {
            id: 'membership-a',
            member_id: mockMemberId,
            role: 'member',
            joined_at: new Date('2026-01-01'),
            member: { first_name: 'Ada', last_name: 'Obi' },
          },
          {
            id: 'membership-b',
            member_id: 'removed',
            role: 'member',
            joined_at: new Date('2026-01-01'),
            member: null,
          },
        ],
      });
      prisma.member.findMany.mockResolvedValue([
        { id: mockMemberId, first_name: 'Head', last_name: 'Name' },
      ]);
      prisma.cellGroup.findFirst.mockResolvedValue(mockCellGroup);
      prisma.cellGroupMember.count.mockResolvedValue(12);
    });
    it.each([
      { hq: true, own: false, memberId: undefined, branchId: 'branch-1', expected: {} },
      {
        hq: false,
        own: false,
        memberId: undefined,
        branchId: 'branch-1',
        expected: { OR: [{ branch_id: 'branch-1' }, { branch_id: null }] },
      },
      {
        hq: false,
        own: true,
        memberId: mockMemberId,
        branchId: 'branch-1',
        expected: {
          head_member_id: mockMemberId,
          OR: [{ branch_id: 'branch-1' }, { branch_id: null }],
        },
      },
      {
        hq: false,
        own: true,
        memberId: undefined,
        branchId: undefined,
        expected: { head_member_id: '', branch_id: '' },
      },
    ])(
      'pins department detail scope for HQ=$hq own=$own member=$memberId',
      async ({ hq, own, memberId, branchId, expected }) => {
        const viewer = {
          church_id: mockChurchId,
          role: 'department_head',
          is_admin_hq: hq,
          branch_id: branchId,
          member_id: memberId,
          permissions: own ? ['departments:own:read'] : ['departments:read'],
        };
        const result = await service.getDepartmentById(mockDepartmentId, mockChurchId, viewer);
        expect(prisma.department.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: mockDepartmentId, church_id: mockChurchId, ...expected },
          }),
        );
        expect(result).toMatchObject({
          headFirstName: 'Head',
          headLastName: 'Name',
          branchName: 'Main',
          memberCount: 2,
          members: [
            expect.objectContaining({ firstName: 'Ada', lastName: 'Obi' }),
            expect.objectContaining({ firstName: '', lastName: '' }),
          ],
        });
        expect(prisma.member.findMany).toHaveBeenCalledWith({
          where: { church_id: mockChurchId, id: { in: [mockMemberId] } },
          select: { id: true, first_name: true, last_name: true },
        });
      },
    );
    it('uses the same ownership scope for department lists and permits HQ branch selection', async () => {
      prisma.department.findMany.mockResolvedValue([{ ...mockDepartment, head_member_id: null }]);
      await service.listDepartments(
        mockChurchId,
        true,
        { church_id: mockChurchId, role: 'church_admin', is_admin_hq: true },
        'selected',
      );
      expect(prisma.department.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            church_id: mockChurchId,
            archived_at: { not: null },
            OR: [{ branch_id: 'selected' }, { branch_id: null }],
          },
        }),
      );
      await service.listDepartments(mockChurchId, false, {
        church_id: mockChurchId,
        role: 'department_head',
        member_id: mockMemberId,
        branch_id: 'branch-1',
        permissions: ['departments:own:read'],
      });
      expect(prisma.department.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: {
            church_id: mockChurchId,
            archived_at: null,
            head_member_id: mockMemberId,
            OR: [{ branch_id: 'branch-1' }, { branch_id: null }],
          },
        }),
      );
    });
    it('maps named and walk-in department attendance without inventing member identities', async () => {
      prisma.departmentAttendance.findMany.mockResolvedValue([
        {
          id: 'a',
          member_id: mockMemberId,
          member: { first_name: 'Ada', last_name: 'Obi' },
          visitor_name: null,
          meeting_date: new Date('2026-01-01'),
          status: 'present',
          notes: null,
        },
        {
          id: 'b',
          member_id: null,
          member: null,
          visitor_name: 'Visitor',
          meeting_date: new Date('2026-01-01'),
          status: 'late',
          notes: 'Synthetic note',
        },
      ]);
      const result = await service.listDepartmentAttendance(
        mockDepartmentId,
        mockChurchId,
        '2026-01-01',
      );
      expect(result).toEqual([
        {
          id: 'a',
          memberId: mockMemberId,
          firstName: 'Ada',
          lastName: 'Obi',
          visitorName: undefined,
          meetingDate: '2026-01-01',
          status: 'present',
          notes: null,
        },
        {
          id: 'b',
          memberId: undefined,
          firstName: '',
          lastName: '',
          visitorName: 'Visitor',
          meetingDate: '2026-01-01',
          status: 'late',
          notes: 'Synthetic note',
        },
      ]);
      expect(prisma.departmentAttendance.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { department_id: mockDepartmentId, meeting_date: new Date('2026-01-01') },
        }),
      );
    });
    it('maps cell-group memberships with missing historical person details', async () => {
      prisma.cellGroupMember.findMany.mockResolvedValue([
        {
          id: 'a',
          member_id: mockMemberId,
          member: { first_name: 'Ada', last_name: 'Obi' },
          role: 'member',
          joined_at: new Date('2026-01-01'),
        },
        {
          id: 'b',
          member_id: 'removed',
          member: null,
          role: 'member',
          joined_at: new Date('2026-01-01'),
        },
      ]);
      const result = await service.listCellGroupMembers(mockGroupId, mockChurchId);
      expect(result.map((item) => [item.firstName, item.lastName])).toEqual([
        ['Ada', 'Obi'],
        ['', ''],
      ]);
      expect(prisma.cellGroupMember.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { cell_group_id: mockGroupId } }),
      );
    });
    it('replaces named counts with reported totals per date instead of double-counting attendance', async () => {
      prisma.attendanceSession.findMany.mockResolvedValue([
        { attendance_date: new Date('2026-01-01'), total: 20 },
        { attendance_date: new Date('2026-01-01'), total: 5 },
      ]);
      prisma.cellGroupAttendance.groupBy.mockResolvedValue([
        { meeting_date: new Date('2026-01-01'), status: 'present', _count: 10 },
        { meeting_date: new Date('2026-01-02'), status: 'present', _count: 3 },
        { meeting_date: new Date('2026-01-02'), status: 'late', _count: 2 },
        { meeting_date: new Date('2026-01-02'), status: 'absent', _count: 8 },
      ]);
      await expect(
        service.getCellGroupAttendanceSummary(mockGroupId, mockChurchId),
      ).resolves.toEqual({ totalMeetings: 2, averageAttendance: 15, memberCount: 12 });
    });
    it.each([0, 2])(
      'handles %s legacy meeting dates without reported sessions',
      async (meetings) => {
        prisma.attendanceSession.findMany.mockResolvedValue([]);
        prisma.cellGroupAttendance.findMany.mockResolvedValue(
          Array.from({ length: meetings }, (_, day) => ({
            meeting_date: new Date(`2026-01-0${day + 1}`),
          })),
        );
        prisma.cellGroupAttendance.count.mockResolvedValue(9);
        await expect(
          service.getCellGroupAttendanceSummary(mockGroupId, mockChurchId),
        ).resolves.toEqual({
          totalMeetings: meetings,
          averageAttendance: meetings ? 5 : 0,
          memberCount: 12,
        });
      },
    );
    it.each([
      {
        name: 'read department',
        run: () => service.getDepartmentById(mockDepartmentId, mockChurchId),
      },
      {
        name: 'update department',
        run: () => service.updateDepartment(mockDepartmentId, {}, mockChurchId, mockUserId),
      },
      {
        name: 'delete department',
        run: () => service.deleteDepartment(mockDepartmentId, mockChurchId, mockUserId),
      },
      {
        name: 'add department member',
        run: () =>
          service.addDepartmentMember(
            mockDepartmentId,
            { memberId: mockMemberId },
            mockChurchId,
            mockUserId,
          ),
      },
      {
        name: 'remove department member',
        run: () =>
          service.removeDepartmentMember(mockDepartmentId, mockMemberId, mockChurchId, mockUserId),
      },
      {
        name: 'update cell group',
        run: () => service.updateCellGroup(mockGroupId, {}, mockChurchId, mockUserId),
      },
      {
        name: 'delete cell group',
        run: () => service.deleteCellGroup(mockGroupId, mockChurchId, mockUserId),
      },
      {
        name: 'add cell member',
        run: () =>
          service.addCellGroupMember(mockGroupId, mockMemberId, 'member', mockChurchId, mockUserId),
      },
      {
        name: 'remove cell member',
        run: () =>
          service.removeCellGroupMember(mockGroupId, mockMemberId, mockChurchId, mockUserId),
      },
      {
        name: 'list cell members',
        run: () => service.listCellGroupMembers(mockGroupId, mockChurchId),
      },
    ])('returns not-found before $name can use a missing tenant resource', async ({ run }) => {
      prisma.department.findFirst.mockResolvedValue(null);
      prisma.cellGroup.findFirst.mockResolvedValue(null);
      await expect(run()).rejects.toThrow(NotFoundException);
      expect(prisma.department.update).not.toHaveBeenCalled();
      expect(prisma.cellGroup.update).not.toHaveBeenCalled();
    });
  });

  describe('Platform church aggregates', () => {
    it('returns zero totals for an empty platform', async () => {
      prisma.church.findMany.mockResolvedValue([]);
      await expect(service.getCrossChurchAnalytics()).resolves.toEqual({
        totalChurches: 0,
        totalMembers: 0,
        totalActiveMembers: 0,
        totalBranches: 0,
        totalMonthlyGiving: 0,
        averageMembersPerChurch: 0,
        averageGivingPerChurch: 0,
        churches: [],
      });
    });
    it('keeps each church query scoped while aggregating counts and successful monthly giving', async () => {
      prisma.church.findMany.mockResolvedValue([
        {
          id: 'church-a',
          name: 'A',
          denomination: null,
          city: 'Lagos',
          state: null,
          created_at: new Date('2026-01-01'),
          _count: { members: 4, branches: 2 },
        },
        {
          id: 'church-b',
          name: 'B',
          denomination: 'Independent',
          city: null,
          state: null,
          created_at: new Date('2026-01-01'),
          _count: { members: 6, branches: 1 },
        },
      ]);
      prisma.member.count.mockResolvedValueOnce(3).mockResolvedValueOnce(2);
      prisma.transaction.aggregate
        .mockResolvedValueOnce({ _sum: { amount: 1000 } })
        .mockResolvedValueOnce({ _sum: { amount: null } });
      prisma.profile.findFirst
        .mockResolvedValueOnce({ first_name: 'Ada', last_name: 'Obi' })
        .mockResolvedValueOnce(null);
      const result = await service.getCrossChurchAnalytics();
      expect(result).toMatchObject({
        totalChurches: 2,
        totalMembers: 10,
        totalActiveMembers: 5,
        totalBranches: 3,
        totalMonthlyGiving: 1000,
        averageMembersPerChurch: 5,
        averageGivingPerChurch: 500,
      });
      expect(result.churches.map((item) => item.adminName)).toEqual(['Ada Obi', 'N/A']);
      expect(prisma.member.count).toHaveBeenNthCalledWith(1, {
        where: { church_id: 'church-a', status: 'active' },
      });
      expect(prisma.member.count).toHaveBeenNthCalledWith(2, {
        where: { church_id: 'church-b', status: 'active' },
      });
      expect(prisma.transaction.aggregate).toHaveBeenCalledWith({
        where: { church_id: 'church-a', status: 'success', giving_date: { gte: expect.any(Date) } },
        _sum: { amount: true },
      });
    });
  });

  describe('createDepartment', () => {
    it('pins a branch creator to their branch and validates the selected leader', async () => {
      prisma.branch.findFirst.mockResolvedValue({ id: 'branch-1' });
      prisma.member.findFirst.mockResolvedValue({ id: mockMemberId, branch_id: 'branch-1' });
      prisma.department.create.mockResolvedValue(mockDepartment);
      await service.createDepartment(
        { name: 'Choir', headMemberId: mockMemberId },
        mockChurchId,
        mockUserId,
        { church_id: mockChurchId, role: 'secretary', branch_id: 'branch-1' },
      );
      expect(prisma.department.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ branch_id: 'branch-1', head_member_id: mockMemberId }),
        }),
      );
    });

    it('rejects creating in another branch', async () => {
      await expect(
        service.createDepartment(
          { name: 'Choir', branchId: 'branch-2' },
          mockChurchId,
          mockUserId,
          { church_id: mockChurchId, role: 'secretary', branch_id: 'branch-1' },
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.department.create).not.toHaveBeenCalled();
    });

    it('requires HQ creators to select a branch', async () => {
      await expect(
        service.createDepartment({ name: 'Choir' }, mockChurchId, mockUserId, {
          church_id: mockChurchId,
          role: 'church_admin',
          is_admin_hq: true,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a leader belonging to another branch', async () => {
      prisma.branch.findFirst.mockResolvedValue({ id: 'branch-1' });
      prisma.member.findFirst.mockResolvedValue({ id: mockMemberId, branch_id: 'branch-2' });
      await expect(
        service.createDepartment(
          { name: 'Choir', branchId: 'branch-1', headMemberId: mockMemberId },
          mockChurchId,
          mockUserId,
          { church_id: mockChurchId, role: 'church_admin', is_admin_hq: true },
        ),
      ).rejects.toThrow('Head member must belong to the selected branch');
      expect(prisma.department.create).not.toHaveBeenCalled();
    });

    it('should create a department', async () => {
      prisma.department.create.mockResolvedValue(mockDepartment);

      const result = await service.createDepartment(
        { name: 'Youth Ministry', description: 'Ministry for youth' },
        mockChurchId,
        mockUserId,
      );

      expect(result.name).toBe('Youth Ministry');
      expect(prisma.department.create).toHaveBeenCalled();
      expect(auditLog).toHaveBeenCalled();
    });

    it('should validate parent department exists', async () => {
      prisma.department.findFirst.mockResolvedValue(null);

      await expect(
        service.createDepartment(
          { name: 'Sub Ministry', parentId: 'non-existent' },
          mockChurchId,
          mockUserId,
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('listDepartments', () => {
    it('should list departments with members', async () => {
      prisma.department.findMany.mockResolvedValue([mockDepartment]);

      const result = await service.listDepartments(mockChurchId);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Youth Ministry');
    });
  });

  describe('deleteDepartment', () => {
    it('protects department attendance sessions from permanent deletion', async () => {
      prisma.department.findFirst.mockResolvedValue({
        ...mockDepartment,
        _count: { department_members: 0 },
      });
      prisma.attendanceSession.count.mockResolvedValue(1);
      await expect(
        service.deleteDepartment(mockDepartmentId, mockChurchId, mockUserId),
      ).rejects.toThrow('Archive it instead');
      expect(prisma.department.delete).not.toHaveBeenCalled();
    });
    it('protects cell group attendance sessions from permanent deletion', async () => {
      prisma.cellGroup.findFirst.mockResolvedValue(mockCellGroup);
      prisma.attendanceSession.count.mockResolvedValue(1);
      await expect(service.deleteCellGroup(mockGroupId, mockChurchId, mockUserId)).rejects.toThrow(
        'Archive it instead',
      );
      expect(prisma.cellGroup.delete).not.toHaveBeenCalled();
    });

    it('should delete an empty department', async () => {
      prisma.department.findFirst.mockResolvedValue({
        ...mockDepartment,
        _count: { department_members: 0 },
      });
      prisma.department.delete.mockResolvedValue(mockDepartment);

      await service.deleteDepartment(mockDepartmentId, mockChurchId, mockUserId);

      expect(prisma.department.delete).toHaveBeenCalled();
    });

    it('should block deletion of department with members', async () => {
      prisma.department.findFirst.mockResolvedValue({
        ...mockDepartment,
        _count: { department_members: 5 },
      });

      await expect(
        service.deleteDepartment(mockDepartmentId, mockChurchId, mockUserId),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('addDepartmentMember', () => {
    it('should add a member to a department', async () => {
      prisma.department.findFirst.mockResolvedValue(mockDepartment);
      prisma.member.findFirst.mockResolvedValue({ id: mockMemberId });
      prisma.departmentMember.findUnique.mockResolvedValue(null);
      prisma.departmentMember.create.mockResolvedValue({} as never);

      await service.addDepartmentMember(
        mockDepartmentId,
        { memberId: mockMemberId, role: 'leader' },
        mockChurchId,
        mockUserId,
      );

      expect(prisma.departmentMember.create).toHaveBeenCalled();
    });

    it('should prevent duplicate membership', async () => {
      prisma.department.findFirst.mockResolvedValue(mockDepartment);
      prisma.member.findFirst.mockResolvedValue({ id: mockMemberId });
      (prisma.departmentMember.findUnique as jest.Mock).mockResolvedValue({
        id: 'dm-1',
        member_id: 'm-1',
        department_id: 'd-1',
      });

      await expect(
        service.addDepartmentMember(
          mockDepartmentId,
          { memberId: mockMemberId },
          mockChurchId,
          mockUserId,
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('should reject a member from another church', async () => {
      prisma.department.findFirst.mockResolvedValue(mockDepartment);
      prisma.member.findFirst.mockResolvedValue(null);

      await expect(
        service.addDepartmentMember(
          mockDepartmentId,
          { memberId: mockMemberId },
          mockChurchId,
          mockUserId,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('should reject a member from a different branch than the department', async () => {
      prisma.department.findFirst.mockResolvedValue({
        ...mockDepartment,
        branch_id: 'branch-lekki',
        head_member_id: null,
        archived_at: null,
      });
      prisma.member.findFirst.mockResolvedValue({
        id: mockMemberId,
        branch_id: 'branch-hq',
      });

      await expect(
        service.addDepartmentMember(
          mockDepartmentId,
          { memberId: mockMemberId },
          mockChurchId,
          mockUserId,
        ),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.departmentMember.create).not.toHaveBeenCalled();
    });

    it('should allow a member from the department branch', async () => {
      prisma.department.findFirst.mockResolvedValue({
        ...mockDepartment,
        branch_id: 'branch-lekki',
        head_member_id: null,
        archived_at: null,
      });
      prisma.member.findFirst.mockResolvedValue({
        id: mockMemberId,
        branch_id: 'branch-lekki',
      });
      prisma.departmentMember.findUnique.mockResolvedValue(null);
      prisma.departmentMember.create.mockResolvedValue({} as never);

      await service.addDepartmentMember(
        mockDepartmentId,
        { memberId: mockMemberId },
        mockChurchId,
        mockUserId,
      );

      expect(prisma.departmentMember.create).toHaveBeenCalled();
    });

    it('should allow any church member when the department has no branch', async () => {
      prisma.department.findFirst.mockResolvedValue({
        ...mockDepartment,
        branch_id: null,
        head_member_id: null,
        archived_at: null,
      });
      prisma.member.findFirst.mockResolvedValue({
        id: mockMemberId,
        branch_id: 'branch-hq',
      });
      prisma.departmentMember.findUnique.mockResolvedValue(null);
      prisma.departmentMember.create.mockResolvedValue({} as never);

      await service.addDepartmentMember(
        mockDepartmentId,
        { memberId: mockMemberId },
        mockChurchId,
        mockUserId,
      );

      expect(prisma.departmentMember.create).toHaveBeenCalled();
    });

    it('should forbid an admin-hq department_head adding a member to a department they do not head', async () => {
      prisma.department.findFirst.mockResolvedValue({
        ...mockDepartment,
        head_member_id: 'member-other',
        archived_at: null,
      });

      await expect(
        service.addDepartmentMember(
          mockDepartmentId,
          { memberId: mockMemberId },
          mockChurchId,
          mockUserId,
          {
            church_id: mockChurchId,
            branch_id: 'branch-hq',
            member_id: 'member-hq-head',
            role: 'department_head',
            permissions: ['departments:own:read', 'departments:own:update'],
            is_admin_hq: true,
          },
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.departmentMember.create).not.toHaveBeenCalled();
    });

    it('should allow an admin-hq department_head adding a member to the department they head', async () => {
      prisma.department.findFirst.mockResolvedValue({
        ...mockDepartment,
        head_member_id: 'member-hq-head',
        archived_at: null,
      });
      prisma.member.findFirst.mockResolvedValue({ id: mockMemberId });
      prisma.departmentMember.findUnique.mockResolvedValue(null);
      prisma.departmentMember.create.mockResolvedValue({} as never);

      await service.addDepartmentMember(
        mockDepartmentId,
        { memberId: mockMemberId },
        mockChurchId,
        mockUserId,
        {
          church_id: mockChurchId,
          branch_id: 'branch-hq',
          member_id: 'member-hq-head',
          role: 'department_head',
          permissions: ['departments:own:read', 'departments:own:update'],
          is_admin_hq: true,
        },
      );

      expect(prisma.departmentMember.create).toHaveBeenCalled();
    });
  });

  describe('removeDepartmentMember', () => {
    it('should remove a member and audit the removal', async () => {
      prisma.department.findFirst.mockResolvedValue(mockDepartment);
      prisma.departmentMember.findUnique.mockResolvedValue({
        id: 'dm-1',
        department_id: mockDepartmentId,
        member_id: mockMemberId,
      });
      prisma.departmentMember.delete.mockResolvedValue({} as never);

      await service.removeDepartmentMember(
        mockDepartmentId,
        mockMemberId,
        mockChurchId,
        mockUserId,
      );

      expect(prisma.departmentMember.delete).toHaveBeenCalledTimes(1);
      expect(auditLog).toHaveBeenCalledTimes(1);
    });

    it('should treat an already-removed membership as a successful no-op', async () => {
      prisma.department.findFirst.mockResolvedValue(mockDepartment);
      prisma.departmentMember.findUnique.mockResolvedValue(null);

      await service.removeDepartmentMember(
        mockDepartmentId,
        mockMemberId,
        mockChurchId,
        mockUserId,
      );

      expect(prisma.departmentMember.findUnique).toHaveBeenCalledWith({
        where: {
          department_id_member_id: {
            department_id: mockDepartmentId,
            member_id: mockMemberId,
          },
        },
      });
      expect(prisma.departmentMember.delete).not.toHaveBeenCalled();
      expect(auditLog).not.toHaveBeenCalled();
    });

    it('should reject an unknown department', async () => {
      prisma.department.findFirst.mockResolvedValue(null);

      await expect(
        service.removeDepartmentMember(mockDepartmentId, mockMemberId, mockChurchId, mockUserId),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.departmentMember.delete).not.toHaveBeenCalled();
    });

    it('should forbid an admin-hq department_head removing a member from a department they do not head', async () => {
      prisma.department.findFirst.mockResolvedValue({
        ...mockDepartment,
        head_member_id: 'member-other',
        archived_at: null,
      });

      await expect(
        service.removeDepartmentMember(mockDepartmentId, mockMemberId, mockChurchId, mockUserId, {
          church_id: mockChurchId,
          branch_id: 'branch-hq',
          member_id: 'member-hq-head',
          role: 'department_head',
          permissions: ['departments:own:read', 'departments:own:update'],
          is_admin_hq: true,
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.departmentMember.delete).not.toHaveBeenCalled();
    });

    it('should allow an admin-hq department_head removing a member from the department they head', async () => {
      prisma.department.findFirst.mockResolvedValue({
        ...mockDepartment,
        head_member_id: 'member-hq-head',
        archived_at: null,
      });
      prisma.departmentMember.findUnique.mockResolvedValue({
        id: 'dm-1',
        department_id: mockDepartmentId,
        member_id: mockMemberId,
      });
      prisma.departmentMember.delete.mockResolvedValue({} as never);

      await service.removeDepartmentMember(
        mockDepartmentId,
        mockMemberId,
        mockChurchId,
        mockUserId,
        {
          church_id: mockChurchId,
          branch_id: 'branch-hq',
          member_id: 'member-hq-head',
          role: 'department_head',
          permissions: ['departments:own:read', 'departments:own:update'],
          is_admin_hq: true,
        },
      );

      expect(prisma.departmentMember.delete).toHaveBeenCalledTimes(1);
      expect(auditLog).toHaveBeenCalledTimes(1);
    });
  });

  describe('updateDepartment', () => {
    it('should allow an own-department head update while stripping branch/head reassignment', async () => {
      prisma.department.findFirst.mockResolvedValue({
        ...mockDepartment,
        head_member_id: 'member-l',
        branch_id: 'branch-1',
        archived_at: null,
      });
      prisma.department.update.mockResolvedValue({
        ...mockDepartment,
        head_member_id: 'member-l',
        branch_id: 'branch-1',
        description: 'Youth ministry for teens',
        branch: { id: 'branch-1', name: 'Lekki Campus' },
      });
      prisma.member.findMany.mockResolvedValue([]);

      const result = await service.updateDepartment(
        mockDepartmentId,
        {
          branchId: 'branch-2',
          headMemberId: 'member-other',
          description: 'Youth ministry for teens',
        },
        mockChurchId,
        mockUserId,
        {
          church_id: mockChurchId,
          branch_id: 'branch-1',
          member_id: 'member-l',
          role: 'department_head',
          permissions: ['departments:own:read', 'departments:own:update'],
        },
      );

      const call = prisma.department.update.mock.calls[0][0] as { data: Record<string, unknown> };
      expect(call.data.description).toBe('Youth ministry for teens');
      expect(call.data.branch_id).toBeUndefined();
      expect(call.data.head_member_id).toBeUndefined();
      expect(result.branchId).toBe('branch-1');
    });

    it('should forbid a department_head updating a department they do not head', async () => {
      prisma.department.findFirst.mockResolvedValue({
        ...mockDepartment,
        head_member_id: 'member-other',
        branch_id: 'branch-1',
        archived_at: null,
      });

      await expect(
        service.updateDepartment(
          mockDepartmentId,
          { description: 'Youth ministry for teens' },
          mockChurchId,
          mockUserId,
          {
            church_id: mockChurchId,
            branch_id: 'branch-1',
            member_id: 'member-l',
            role: 'department_head',
            permissions: ['departments:own:read', 'departments:own:update'],
          },
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.department.update).not.toHaveBeenCalled();
    });

    it('should forbid an admin-hq department_head updating a department they do not head', async () => {
      prisma.department.findFirst.mockResolvedValue({
        ...mockDepartment,
        head_member_id: 'member-other',
        branch_id: 'branch-1',
        archived_at: null,
      });

      await expect(
        service.updateDepartment(
          mockDepartmentId,
          { description: 'Choir practice' },
          mockChurchId,
          mockUserId,
          {
            church_id: mockChurchId,
            branch_id: 'branch-hq',
            member_id: 'member-hq-head',
            role: 'department_head',
            permissions: ['departments:own:read', 'departments:own:update'],
            is_admin_hq: true,
          },
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.department.update).not.toHaveBeenCalled();
    });

    it('should allow an admin-hq department_head updating their own department without stripping branch/head', async () => {
      prisma.department.findFirst.mockResolvedValue({
        ...mockDepartment,
        head_member_id: 'member-hq-head',
        branch_id: 'branch-hq',
        archived_at: null,
      });
      prisma.branch.findFirst.mockResolvedValue({ id: 'branch-3' });
      prisma.member.findFirst.mockResolvedValue({
        id: 'member-hq-head',
        branch_id: 'branch-3',
      });
      prisma.department.update.mockResolvedValue({
        ...mockDepartment,
        head_member_id: 'member-hq-head',
        branch_id: 'branch-3',
        description: 'Choir practice',
        branch: { id: 'branch-3', name: 'Ikeja Campus' },
      });
      prisma.member.findMany.mockResolvedValue([]);

      const result = await service.updateDepartment(
        mockDepartmentId,
        { branchId: 'branch-3', headMemberId: 'member-hq-head', description: 'Choir practice' },
        mockChurchId,
        mockUserId,
        {
          church_id: mockChurchId,
          branch_id: 'branch-hq',
          member_id: 'member-hq-head',
          role: 'department_head',
          permissions: ['departments:own:read', 'departments:own:update'],
          is_admin_hq: true,
        },
      );

      const call = prisma.department.update.mock.calls[0][0] as { data: Record<string, unknown> };
      expect(call.data.description).toBe('Choir practice');
      expect(call.data.branch_id).toBe('branch-3');
      expect(call.data.head_member_id).toBe('member-hq-head');
      expect(result.branchId).toBe('branch-3');
    });
  });

  describe('createCellGroup', () => {
    it('should create a cell group', async () => {
      prisma.cellGroup.create.mockResolvedValue(mockCellGroup);

      const result = await service.createCellGroup(
        { name: 'Victory Cell', latitude: 6.5244, longitude: 3.3792 },
        mockChurchId,
        mockUserId,
      );

      expect(result.name).toBe('Victory Cell');
      expect(result.latitude).toBe(6.5244);
    });

    it('should persist the branch id', async () => {
      prisma.branch.findFirst.mockResolvedValue({ id: 'branch-1' });
      prisma.cellGroup.create.mockResolvedValue({
        ...mockCellGroup,
        branch_id: 'branch-1',
      });

      await service.createCellGroup(
        { name: 'Victory Cell', branchId: 'branch-1' },
        mockChurchId,
        mockUserId,
      );

      expect(prisma.cellGroup.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ branch_id: 'branch-1' }),
        }),
      );
    });

    it('should persist the address and map it on the response', async () => {
      prisma.cellGroup.create.mockResolvedValue({
        ...mockCellGroup,
        address: '12 Adeola Odeku St, Lekki',
      });

      const result = await service.createCellGroup(
        { name: 'Victory Cell', address: '12 Adeola Odeku St, Lekki' },
        mockChurchId,
        mockUserId,
      );

      expect(prisma.cellGroup.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ address: '12 Adeola Odeku St, Lekki' }),
        }),
      );
      expect(result.address).toBe('12 Adeola Odeku St, Lekki');
    });

    it('should resolve the leader name on the response', async () => {
      prisma.cellGroup.create.mockResolvedValue({
        ...mockCellGroup,
        leader_id: mockMemberId,
      });
      prisma.member.findMany.mockResolvedValue([
        { id: mockMemberId, first_name: 'John', last_name: 'Doe' },
      ]);

      const result = await service.createCellGroup(
        { name: 'Victory Cell', leaderId: mockMemberId },
        mockChurchId,
        mockUserId,
      );

      expect(prisma.member.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            church_id: mockChurchId,
            id: { in: [mockMemberId] },
          }),
        }),
      );
      expect(result.leaderId).toBe(mockMemberId);
      expect(result.leaderFirstName).toBe('John');
      expect(result.leaderLastName).toBe('Doe');
    });
  });

  describe('updateCellGroup', () => {
    it('should persist details and map them on update', async () => {
      prisma.cellGroup.findFirst.mockResolvedValue(mockCellGroup);
      prisma.cellGroup.update.mockResolvedValue({
        ...mockCellGroup,
        branch_id: 'branch-1',
        address: '12 Adeola Odeku St, Lekki',
        branch: { id: 'branch-1', name: 'Lekki Campus' },
      });

      const result = await service.updateCellGroup(
        mockGroupId,
        { branchId: 'branch-1', address: '12 Adeola Odeku St, Lekki' },
        mockChurchId,
        mockUserId,
      );

      expect(prisma.cellGroup.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            branch_id: 'branch-1',
            address: '12 Adeola Odeku St, Lekki',
          }),
          include: { branch: { select: { id: true, name: true } } },
        }),
      );
      expect(result.branchId).toBe('branch-1');
      expect(result.branchName).toBe('Lekki Campus');
      expect(result.address).toBe('12 Adeola Odeku St, Lekki');
    });

    it('should forbid a cell_leader updating a group they do not lead', async () => {
      prisma.cellGroup.findFirst.mockResolvedValue({
        ...mockCellGroup,
        leader_id: 'member-other',
      });

      await expect(
        service.updateCellGroup(mockGroupId, { name: 'X' }, mockChurchId, mockUserId, {
          church_id: mockChurchId,
          branch_id: 'branch-1',
          member_id: 'member-leader-1',
          role: 'cell_leader',
          permissions: ['cell_groups:own:read', 'cell_groups:own:update'],
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should allow an own-group cell_leader update while stripping leader/branch changes', async () => {
      prisma.cellGroup.findFirst.mockResolvedValue({
        ...mockCellGroup,
        leader_id: 'member-leader-1',
        branch_id: 'branch-1',
      });
      prisma.cellGroup.update.mockResolvedValue({
        ...mockCellGroup,
        leader_id: 'member-leader-1',
        branch_id: 'branch-1',
        address: '10 Admiralty Way, Lekki',
        branch: { id: 'branch-1', name: 'Lekki Campus' },
      });
      prisma.member.findMany.mockResolvedValue([]);

      const result = await service.updateCellGroup(
        mockGroupId,
        { branchId: 'branch-2', leaderId: 'member-other', address: '10 Admiralty Way, Lekki' },
        mockChurchId,
        mockUserId,
        {
          church_id: mockChurchId,
          branch_id: 'branch-1',
          member_id: 'member-leader-1',
          role: 'cell_leader',
          permissions: ['cell_groups:own:read', 'cell_groups:own:update'],
        },
      );

      const call = prisma.cellGroup.update.mock.calls[0][0] as { data: Record<string, unknown> };
      expect(call.data.address).toBe('10 Admiralty Way, Lekki');
      expect(call.data.branch_id).toBeUndefined();
      expect(call.data.leader_id).toBeUndefined();
      expect(result.branchId).toBe('branch-1');
    });

    it('should forbid an admin-hq cell_leader editing a group they do not lead', async () => {
      prisma.cellGroup.findFirst.mockResolvedValue({
        ...mockCellGroup,
        leader_id: 'member-other',
        branch_id: 'branch-1',
      });

      await expect(
        service.updateCellGroup(
          mockGroupId,
          { branchId: 'branch-2', leaderId: 'member-other', address: '10 Admiralty Way, Lekki' },
          mockChurchId,
          mockUserId,
          {
            church_id: mockChurchId,
            branch_id: 'branch-1',
            member_id: 'member-leader-1',
            role: 'cell_leader',
            permissions: ['cell_groups:own:read', 'cell_groups:own:update'],
            is_admin_hq: true,
          },
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.cellGroup.update).not.toHaveBeenCalled();
    });

    it('should allow an admin-hq cell_leader editing their own group without stripping leader/branch', async () => {
      prisma.cellGroup.findFirst.mockResolvedValue({
        ...mockCellGroup,
        leader_id: 'member-leader-1',
        branch_id: 'branch-1',
      });
      prisma.cellGroup.update.mockResolvedValue({
        ...mockCellGroup,
        leader_id: 'member-leader-1',
        branch_id: 'branch-2',
        address: '10 Admiralty Way, Lekki',
        branch: { id: 'branch-2', name: 'Ikeja Campus' },
      });

      const result = await service.updateCellGroup(
        mockGroupId,
        { branchId: 'branch-2', leaderId: 'member-leader-1', address: '10 Admiralty Way, Lekki' },
        mockChurchId,
        mockUserId,
        {
          church_id: mockChurchId,
          branch_id: 'branch-1',
          member_id: 'member-leader-1',
          role: 'cell_leader',
          permissions: ['cell_groups:own:read', 'cell_groups:own:update'],
          is_admin_hq: true,
        },
      );

      const call = prisma.cellGroup.update.mock.calls[0][0] as { data: Record<string, unknown> };
      expect(call.data.address).toBe('10 Admiralty Way, Lekki');
      expect(call.data.branch_id).toBe('branch-2');
      expect(call.data.leader_id).toBe('member-leader-1');
      expect(result.branchId).toBe('branch-2');
    });
  });

  describe('cell group member management ownership', () => {
    it('should allow an own-group cell_leader to add members', async () => {
      prisma.cellGroup.findFirst.mockResolvedValue({
        ...mockCellGroup,
        leader_id: 'member-leader-1',
      });
      prisma.member.findFirst.mockResolvedValue({ id: mockMemberId, branch_id: 'branch-1' });
      prisma.cellGroupMember.findUnique.mockResolvedValue(null);
      prisma.cellGroupMember.create.mockResolvedValue({} as never);

      await service.addCellGroupMember(
        mockGroupId,
        mockMemberId,
        'member',
        mockChurchId,
        mockUserId,
        {
          church_id: mockChurchId,
          branch_id: 'branch-1',
          member_id: 'member-leader-1',
          role: 'cell_leader',
          permissions: ['cell_groups:own:read', 'cell_groups:own:update'],
        },
      );

      expect(prisma.cellGroupMember.create).toHaveBeenCalled();
    });

    it('should forbid a cell_leader adding members to a group they do not lead', async () => {
      prisma.cellGroup.findFirst.mockResolvedValue({
        ...mockCellGroup,
        leader_id: 'member-other',
      });

      await expect(
        service.addCellGroupMember(mockGroupId, mockMemberId, 'member', mockChurchId, mockUserId, {
          church_id: mockChurchId,
          branch_id: 'branch-1',
          member_id: 'member-leader-1',
          role: 'cell_leader',
          permissions: ['cell_groups:own:read', 'cell_groups:own:update'],
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should forbid a branch-restricted cell_leader adding a member from another branch', async () => {
      prisma.cellGroup.findFirst.mockResolvedValue({
        ...mockCellGroup,
        leader_id: 'member-leader-1',
      });
      prisma.member.findFirst.mockResolvedValue({ id: mockMemberId, branch_id: 'branch-2' });

      await expect(
        service.addCellGroupMember(mockGroupId, mockMemberId, 'member', mockChurchId, mockUserId, {
          church_id: mockChurchId,
          branch_id: 'branch-1',
          member_id: 'member-leader-1',
          role: 'cell_leader',
          permissions: ['cell_groups:own:read', 'cell_groups:own:update'],
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.cellGroupMember.create).not.toHaveBeenCalled();
    });

    it('should allow a branch-restricted cell_leader adding a member from their own branch', async () => {
      prisma.cellGroup.findFirst.mockResolvedValue({
        ...mockCellGroup,
        leader_id: 'member-leader-1',
      });
      prisma.member.findFirst.mockResolvedValue({ id: mockMemberId, branch_id: 'branch-1' });
      prisma.cellGroupMember.findUnique.mockResolvedValue(null);
      prisma.cellGroupMember.create.mockResolvedValue({} as never);

      await service.addCellGroupMember(
        mockGroupId,
        mockMemberId,
        'member',
        mockChurchId,
        mockUserId,
        {
          church_id: mockChurchId,
          branch_id: 'branch-1',
          member_id: 'member-leader-1',
          role: 'cell_leader',
          permissions: ['cell_groups:own:read', 'cell_groups:own:update'],
        },
      );

      expect(prisma.cellGroupMember.create).toHaveBeenCalled();
    });

    it('should forbid an admin-hq cell_leader adding a member to a group they do not lead', async () => {
      prisma.cellGroup.findFirst.mockResolvedValue({
        ...mockCellGroup,
        leader_id: 'member-other',
      });
      prisma.member.findFirst.mockResolvedValue({ id: mockMemberId, branch_id: 'branch-2' });
      prisma.cellGroupMember.findUnique.mockResolvedValue(null);
      prisma.cellGroupMember.create.mockResolvedValue({} as never);

      await expect(
        service.addCellGroupMember(mockGroupId, mockMemberId, 'member', mockChurchId, mockUserId, {
          church_id: mockChurchId,
          branch_id: 'branch-1',
          member_id: 'member-leader-1',
          role: 'cell_leader',
          permissions: ['cell_groups:own:read', 'cell_groups:own:update'],
          is_admin_hq: true,
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.cellGroupMember.create).not.toHaveBeenCalled();
    });

    it('should allow an admin-hq cell_leader adding a member to their own group (any branch)', async () => {
      prisma.cellGroup.findFirst.mockResolvedValue({
        ...mockCellGroup,
        leader_id: 'member-leader-1',
      });
      prisma.member.findFirst.mockResolvedValue({ id: mockMemberId, branch_id: 'branch-2' });
      prisma.cellGroupMember.findUnique.mockResolvedValue(null);
      prisma.cellGroupMember.create.mockResolvedValue({} as never);

      await service.addCellGroupMember(
        mockGroupId,
        mockMemberId,
        'member',
        mockChurchId,
        mockUserId,
        {
          church_id: mockChurchId,
          branch_id: 'branch-1',
          member_id: 'member-leader-1',
          role: 'cell_leader',
          permissions: ['cell_groups:own:read', 'cell_groups:own:update'],
          is_admin_hq: true,
        },
      );

      expect(prisma.cellGroupMember.create).toHaveBeenCalled();
    });

    it('should allow an own-group cell_leader to remove members', async () => {
      prisma.cellGroup.findFirst.mockResolvedValue({
        ...mockCellGroup,
        leader_id: 'member-leader-1',
      });
      prisma.cellGroupMember.findUnique.mockResolvedValue(mockCellGroupMember);
      prisma.cellGroupMember.delete.mockResolvedValue({} as never);

      await service.removeCellGroupMember(mockGroupId, mockMemberId, mockChurchId, mockUserId, {
        church_id: mockChurchId,
        branch_id: 'branch-1',
        member_id: 'member-leader-1',
        role: 'cell_leader',
        permissions: ['cell_groups:own:read', 'cell_groups:own:update'],
      });

      expect(prisma.cellGroupMember.delete).toHaveBeenCalled();
    });

    it('should forbid a cell_leader removing members from a group they do not lead', async () => {
      prisma.cellGroup.findFirst.mockResolvedValue({
        ...mockCellGroup,
        leader_id: 'member-other',
      });

      await expect(
        service.removeCellGroupMember(mockGroupId, mockMemberId, mockChurchId, mockUserId, {
          church_id: mockChurchId,
          branch_id: 'branch-1',
          member_id: 'member-leader-1',
          role: 'cell_leader',
          permissions: ['cell_groups:own:read', 'cell_groups:own:update'],
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should forbid a cell_leader without a linked member from managing members', async () => {
      prisma.cellGroup.findFirst.mockResolvedValue(mockCellGroup);

      await expect(
        service.removeCellGroupMember(mockGroupId, mockMemberId, mockChurchId, mockUserId, {
          church_id: mockChurchId,
          branch_id: 'branch-1',
          role: 'cell_leader',
          permissions: ['cell_groups:own:read', 'cell_groups:own:update'],
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should forbid an admin-hq cell_leader removing a member from a group they do not lead', async () => {
      prisma.cellGroup.findFirst.mockResolvedValue({ ...mockCellGroup, leader_id: 'member-other' });
      prisma.cellGroupMember.findUnique.mockResolvedValue(mockCellGroupMember);
      prisma.cellGroupMember.delete.mockResolvedValue({} as never);

      await expect(
        service.removeCellGroupMember(mockGroupId, mockMemberId, mockChurchId, mockUserId, {
          church_id: mockChurchId,
          branch_id: 'branch-1',
          member_id: 'member-leader-1',
          role: 'cell_leader',
          permissions: ['cell_groups:own:read', 'cell_groups:own:update'],
          is_admin_hq: true,
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.cellGroupMember.delete).not.toHaveBeenCalled();
    });

    it('should allow an admin-hq cell_leader removing a member from their own group', async () => {
      prisma.cellGroup.findFirst.mockResolvedValue({
        ...mockCellGroup,
        leader_id: 'member-leader-1',
      });
      prisma.cellGroupMember.findUnique.mockResolvedValue(mockCellGroupMember);
      prisma.cellGroupMember.delete.mockResolvedValue({} as never);

      await service.removeCellGroupMember(mockGroupId, mockMemberId, mockChurchId, mockUserId, {
        church_id: mockChurchId,
        branch_id: 'branch-1',
        member_id: 'member-leader-1',
        role: 'cell_leader',
        permissions: ['cell_groups:own:read', 'cell_groups:own:update'],
        is_admin_hq: true,
      });

      expect(prisma.cellGroupMember.delete).toHaveBeenCalled();
    });
  });

  describe('listCellGroups', () => {
    it('should map branch names on each group', async () => {
      prisma.cellGroup.findMany.mockResolvedValue([
        {
          ...mockCellGroup,
          branch_id: 'branch-1',
          branch: { id: 'branch-1', name: 'Lekki Campus' },
        },
        { ...mockCellGroup, id: 'group-2', name: 'Grace Cell', branch_id: null },
      ]);

      const result = await service.listCellGroups(mockChurchId);

      expect(prisma.cellGroup.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          include: { branch: { select: { id: true, name: true } } },
        }),
      );
      expect(result[0].branchName).toBe('Lekki Campus');
      expect(result[1].branchName).toBeUndefined();
    });

    it('should resolve leader names on each group', async () => {
      prisma.cellGroup.findMany.mockResolvedValue([
        { ...mockCellGroup, leader_id: mockMemberId },
        { ...mockCellGroup, id: 'group-2', name: 'Grace Cell', leader_id: null },
      ]);
      prisma.member.findMany.mockResolvedValue([
        { id: mockMemberId, first_name: 'John', last_name: 'Doe' },
      ]);

      const result = await service.listCellGroups(mockChurchId);

      expect(result[0].leaderFirstName).toBe('John');
      expect(result[0].leaderLastName).toBe('Doe');
      expect(result[1].leaderFirstName).toBeUndefined();
      expect(result[1].leaderLastName).toBeUndefined();
    });

    it('should scope a non-HQ cell_leader to the groups they lead', async () => {
      prisma.cellGroup.findMany.mockResolvedValue([]);
      prisma.member.findMany.mockResolvedValue([]);

      await service.listCellGroups(
        mockChurchId,
        {},
        {
          church_id: mockChurchId,
          branch_id: 'branch-a',
          member_id: 'leader-member',
          role: 'cell_leader',
          permissions: ['cell_groups:own:read', 'cell_groups:own:update'],
          roles: ['cell_leader'],
          is_admin_hq: false,
        },
      );

      expect(prisma.cellGroup.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ leader_id: 'leader-member' }),
        }),
      );
    });

    it('should scope a non-HQ cell_leader WITHOUT a linked member to zero groups (never the branch fallback)', async () => {
      prisma.cellGroup.findMany.mockResolvedValue([]);
      prisma.member.findMany.mockResolvedValue([]);

      await service.listCellGroups(
        mockChurchId,
        {},
        {
          church_id: mockChurchId,
          branch_id: 'branch-a',
          role: 'cell_leader',
          permissions: ['cell_groups:own:read', 'cell_groups:own:update'],
          roles: ['cell_leader'],
          is_admin_hq: false,
        },
      );

      expect(prisma.cellGroup.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            leader_id: '',
            archived_at: null,
          }),
        }),
      );
    });

    it('should scope a non-HQ non-leader viewer to their own branch', async () => {
      prisma.cellGroup.findMany.mockResolvedValue([]);
      prisma.member.findMany.mockResolvedValue([]);

      await service.listCellGroups(
        mockChurchId,
        {},
        {
          church_id: mockChurchId,
          branch_id: 'branch-a',
          role: 'branch_pastor',
          is_admin_hq: false,
        },
      );

      expect(prisma.cellGroup.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ branch_id: 'branch-a' }),
        }),
      );
    });

    it('should NOT scope an admin-hq viewer (sees all groups)', async () => {
      prisma.cellGroup.findMany.mockResolvedValue([]);
      prisma.member.findMany.mockResolvedValue([]);

      await service.listCellGroups(
        mockChurchId,
        {},
        {
          church_id: mockChurchId,
          branch_id: 'branch-a',
          role: 'church_admin',
          is_admin_hq: true,
        },
      );

      const call = prisma.cellGroup.findMany.mock.calls[0][0] as { where: Record<string, unknown> };
      expect(call.where.leader_id).toBeUndefined();
      expect(call.where.branch_id).toBeUndefined();
    });

    it('should honor the branchId filter for a church-only (admin-hq) viewer', async () => {
      prisma.cellGroup.findMany.mockResolvedValue([]);
      prisma.member.findMany.mockResolvedValue([]);

      await service.listCellGroups(
        mockChurchId,
        { branchId: 'branch-2' },
        {
          church_id: mockChurchId,
          branch_id: 'branch-1',
          role: 'cell_leader',
          permissions: ['cell_groups:own:read', 'cell_groups:own:update'],
          is_admin_hq: true,
        },
      );

      expect(prisma.cellGroup.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ branch_id: 'branch-2' }),
        }),
      );
    });

    it('should force a branch-restricted viewer to their own branch (ignore branchId filter)', async () => {
      prisma.cellGroup.findMany.mockResolvedValue([]);
      prisma.member.findMany.mockResolvedValue([]);

      await service.listCellGroups(
        mockChurchId,
        { branchId: 'branch-2' },
        {
          church_id: mockChurchId,
          branch_id: 'branch-1',
          role: 'branch_pastor',
          is_admin_hq: false,
        },
      );

      expect(prisma.cellGroup.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ branch_id: 'branch-1' }),
        }),
      );
    });

    it('should apply the meetingDay filter', async () => {
      prisma.cellGroup.findMany.mockResolvedValue([]);
      prisma.member.findMany.mockResolvedValue([]);

      await service.listCellGroups(mockChurchId, { meetingDay: 'Sunday' });

      expect(prisma.cellGroup.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ meeting_day: 'Sunday' }),
        }),
      );
    });

    it('should search across group name, address, and resolved leader names', async () => {
      prisma.cellGroup.findMany.mockResolvedValue([mockCellGroup]);
      // Search resolves leader ids by name, then leader-name resolution reuses
      // the same mock call for the returned group's leader.
      prisma.member.findMany.mockResolvedValue([
        { id: 'leader-a', first_name: 'Ada', last_name: 'Okafor' },
      ]);

      await service.listCellGroups(mockChurchId, { search: 'ada' });

      expect(prisma.member.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.arrayContaining([
              { first_name: { contains: 'ada', mode: 'insensitive' } },
              { last_name: { contains: 'ada', mode: 'insensitive' } },
            ]),
          }),
        }),
      );
      expect(prisma.cellGroup.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: expect.objectContaining({
              OR: expect.arrayContaining([
                { name: { contains: 'ada', mode: 'insensitive' } },
                { address: { contains: 'ada', mode: 'insensitive' } },
                { leader_id: { in: ['leader-a'] } },
              ]),
            }),
          }),
        }),
      );
    });

    it('should skip the search query when only whitespace is provided', async () => {
      prisma.cellGroup.findMany.mockResolvedValue([]);
      prisma.member.findMany.mockResolvedValue([]);

      await service.listCellGroups(mockChurchId, { search: '   ' });

      const call = prisma.cellGroup.findMany.mock.calls[0][0] as { where: Record<string, unknown> };
      expect(call.where.AND).toBeUndefined();
    });
  });

  describe('exportCellGroupsCsv', () => {
    it('should export scoped groups as CSV with a header row and escaped values', async () => {
      prisma.cellGroup.findMany.mockResolvedValue([
        {
          ...mockCellGroup,
          id: 'group-1',
          name: 'Grace, Cell',
          branch_id: 'branch-1',
          branch: { id: 'branch-1', name: 'Lekki Campus' },
          leader_id: mockMemberId,
          address: '12 Adeola "Odeku" St',
        },
      ]);
      prisma.member.findMany.mockResolvedValue([
        { id: mockMemberId, first_name: 'Ada', last_name: 'Okafor' },
      ]);

      const csv = await service.exportCellGroupsCsv(mockChurchId);

      const lines = csv.split('\n');
      expect(lines[0]).toBe(
        [
          'ID',
          'Name',
          'Leader',
          'Branch',
          'Address',
          'Meeting Day',
          'Meeting Time',
          'Latitude',
          'Longitude',
          'Archived At',
          'Created At',
        ].join(','),
      );
      expect(lines[1]).toContain('"Grace, Cell"');
      expect(lines[1]).toContain('Ada Okafor');
      expect(lines[1]).toContain('Lekki Campus');
      expect(lines[1]).toContain('"12 Adeola ""Odeku"" St"');
    });
  });

  describe('getCellGroupById', () => {
    it('should return a group with its resolved leader name', async () => {
      prisma.cellGroup.findFirst.mockResolvedValue({
        ...mockCellGroup,
        leader_id: mockMemberId,
        branch_id: 'branch-1',
        branch: { id: 'branch-1', name: 'Lekki Campus' },
      });
      prisma.member.findMany.mockResolvedValue([
        { id: mockMemberId, first_name: 'Ada', last_name: 'Okafor' },
      ]);

      const result = await service.getCellGroupById(mockGroupId, mockChurchId);

      expect(result.branchId).toBe('branch-1');
      expect(result.branchName).toBe('Lekki Campus');
      expect(result.leaderFirstName).toBe('Ada');
      expect(result.leaderLastName).toBe('Okafor');
    });

    it('should throw NotFoundException for a missing group', async () => {
      prisma.cellGroup.findFirst.mockResolvedValue(null);

      await expect(service.getCellGroupById(mockGroupId, mockChurchId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should allow the owning cell_leader to fetch their group', async () => {
      prisma.cellGroup.findFirst.mockResolvedValue({
        ...mockCellGroup,
        leader_id: 'member-leader-1',
        branch_id: 'branch-1',
        branch: { id: 'branch-1', name: 'Lekki Campus' },
      });
      prisma.member.findMany.mockResolvedValue([]);

      const result = await service.getCellGroupById(mockGroupId, mockChurchId, {
        church_id: mockChurchId,
        branch_id: 'branch-1',
        member_id: 'member-leader-1',
        role: 'cell_leader',
        permissions: ['cell_groups:own:read', 'cell_groups:own:update'],
        roles: ['cell_leader'],
        is_admin_hq: false,
      });

      expect(result.id).toBe(mockGroupId);
    });

    it('should 404 a non-owning cell_leader fetching a group in their branch', async () => {
      prisma.cellGroup.findFirst.mockResolvedValue({
        ...mockCellGroup,
        leader_id: 'member-other',
        branch_id: 'branch-1',
        branch: { id: 'branch-1', name: 'Lekki Campus' },
      });
      prisma.member.findMany.mockResolvedValue([]);

      await expect(
        service.getCellGroupById(mockGroupId, mockChurchId, {
          church_id: mockChurchId,
          branch_id: 'branch-1',
          member_id: 'member-leader-1',
          role: 'cell_leader',
          permissions: ['cell_groups:own:read', 'cell_groups:own:update'],
          roles: ['cell_leader'],
          is_admin_hq: false,
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should 404 a cell_leader WITHOUT a linked member fetching any group (never the branch fallback)', async () => {
      prisma.cellGroup.findFirst.mockResolvedValue({
        ...mockCellGroup,
        leader_id: 'member-leader-1',
        branch_id: 'branch-1',
        branch: { id: 'branch-1', name: 'Lekki Campus' },
      });
      prisma.member.findMany.mockResolvedValue([]);

      await expect(
        service.getCellGroupById(mockGroupId, mockChurchId, {
          church_id: mockChurchId,
          branch_id: 'branch-1',
          role: 'cell_leader',
          permissions: ['cell_groups:own:read', 'cell_groups:own:update'],
          roles: ['cell_leader'],
          is_admin_hq: false,
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('recordCellGroupAttendance', () => {
    const meetingDate = '2024-06-02T10:00:00.000Z';

    it('should reject when no member, visitor, or visitor name is supplied', async () => {
      await expect(
        service.recordCellGroupAttendance(
          mockGroupId,
          undefined,
          undefined,
          undefined,
          meetingDate,
          'present',
          undefined,
          mockChurchId,
          mockUserId,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should create a member attendance record', async () => {
      prisma.cellGroup.findFirst.mockResolvedValue(mockCellGroup);
      prisma.member.findFirst.mockResolvedValue({ id: mockMemberId });
      prisma.cellGroupAttendance.findUnique.mockResolvedValue(null);
      prisma.cellGroupAttendance.create.mockResolvedValue({} as never);

      await service.recordCellGroupAttendance(
        mockGroupId,
        mockMemberId,
        undefined,
        undefined,
        meetingDate,
        'present',
        undefined,
        mockChurchId,
        mockUserId,
      );

      expect(prisma.cellGroupAttendance.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            cell_group_id: mockGroupId,
            member_id: mockMemberId,
            visitor_id: null,
            status: 'present',
          }),
        }),
      );
    });

    it('should update an existing member attendance record', async () => {
      prisma.cellGroup.findFirst.mockResolvedValue(mockCellGroup);
      prisma.member.findFirst.mockResolvedValue({ id: mockMemberId });
      prisma.cellGroupAttendance.findUnique.mockResolvedValue({
        id: 'att-1',
        member_id: mockMemberId,
        visitor_id: null,
      });

      await service.recordCellGroupAttendance(
        mockGroupId,
        mockMemberId,
        undefined,
        undefined,
        meetingDate,
        'excused',
        'Sick',
        mockChurchId,
        mockUserId,
      );

      expect(prisma.cellGroupAttendance.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'excused', notes: 'Sick' }),
        }),
      );
    });

    it('should reject a member from another church', async () => {
      prisma.cellGroup.findFirst.mockResolvedValue(mockCellGroup);
      prisma.member.findFirst.mockResolvedValue(null);

      await expect(
        service.recordCellGroupAttendance(
          mockGroupId,
          mockMemberId,
          undefined,
          undefined,
          meetingDate,
          'present',
          undefined,
          mockChurchId,
          mockUserId,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('should create a visitor attendance record and resolve the visitor name', async () => {
      prisma.cellGroup.findFirst.mockResolvedValue(mockCellGroup);
      prisma.visitor.findFirst.mockResolvedValue({
        first_name: 'Ada',
        last_name: 'Okafor',
      });
      prisma.cellGroupAttendance.findUnique.mockResolvedValue(null);
      prisma.cellGroupAttendance.create.mockResolvedValue({} as never);

      await service.recordCellGroupAttendance(
        mockGroupId,
        undefined,
        'visitor-1',
        undefined,
        meetingDate,
        'present',
        undefined,
        mockChurchId,
        mockUserId,
      );

      expect(prisma.cellGroupAttendance.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            cell_group_id: mockGroupId,
            member_id: null,
            visitor_id: 'visitor-1',
            visitor_name: 'Ada Okafor',
          }),
        }),
      );
    });

    it('should reject a visitor from another church', async () => {
      prisma.cellGroup.findFirst.mockResolvedValue(mockCellGroup);
      prisma.visitor.findFirst.mockResolvedValue(null);

      await expect(
        service.recordCellGroupAttendance(
          mockGroupId,
          undefined,
          'visitor-1',
          undefined,
          meetingDate,
          'present',
          undefined,
          mockChurchId,
          mockUserId,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('should record a free-text walk-in', async () => {
      prisma.cellGroup.findFirst.mockResolvedValue(mockCellGroup);
      prisma.cellGroupAttendance.create.mockResolvedValue({} as never);

      await service.recordCellGroupAttendance(
        mockGroupId,
        undefined,
        undefined,
        'Walk In Guest',
        meetingDate,
        'present',
        undefined,
        mockChurchId,
        mockUserId,
      );

      expect(prisma.cellGroupAttendance.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            cell_group_id: mockGroupId,
            member_id: null,
            visitor_id: null,
            visitor_name: 'Walk In Guest',
          }),
        }),
      );
    });

    it('should allow a cell_leader recording attendance for their own group', async () => {
      prisma.cellGroup.findFirst.mockResolvedValue({
        ...mockCellGroup,
        leader_id: 'member-leader-1',
      });
      prisma.member.findFirst.mockResolvedValue({ id: mockMemberId, branch_id: 'branch-1' });
      prisma.cellGroupAttendance.findUnique.mockResolvedValue(null);
      prisma.cellGroupAttendance.create.mockResolvedValue({} as never);

      await service.recordCellGroupAttendance(
        mockGroupId,
        mockMemberId,
        undefined,
        undefined,
        meetingDate,
        'present',
        undefined,
        mockChurchId,
        mockUserId,
        {
          church_id: mockChurchId,
          branch_id: 'branch-1',
          member_id: 'member-leader-1',
          role: 'cell_leader',
          permissions: ['cell_groups:own:read', 'cell_groups:own:update'],
        },
      );

      expect(prisma.cellGroupAttendance.create).toHaveBeenCalled();
    });

    it('should forbid a cell_leader recording attendance for a group they do not lead', async () => {
      prisma.cellGroup.findFirst.mockResolvedValue({
        ...mockCellGroup,
        leader_id: 'member-other',
      });

      await expect(
        service.recordCellGroupAttendance(
          mockGroupId,
          mockMemberId,
          undefined,
          undefined,
          meetingDate,
          'present',
          undefined,
          mockChurchId,
          mockUserId,
          {
            church_id: mockChurchId,
            branch_id: 'branch-1',
            member_id: 'member-leader-1',
            role: 'cell_leader',
            permissions: ['cell_groups:own:read', 'cell_groups:own:update'],
          },
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should forbid a cell_leader without a linked member from recording attendance', async () => {
      prisma.cellGroup.findFirst.mockResolvedValue(mockCellGroup);

      await expect(
        service.recordCellGroupAttendance(
          mockGroupId,
          mockMemberId,
          undefined,
          undefined,
          meetingDate,
          'present',
          undefined,
          mockChurchId,
          mockUserId,
          {
            church_id: mockChurchId,
            branch_id: 'branch-1',
            role: 'cell_leader',
            permissions: ['cell_groups:own:read', 'cell_groups:own:update'],
          },
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should forbid an admin-hq cell_leader recording attendance for a group they do not lead', async () => {
      prisma.cellGroup.findFirst.mockResolvedValue({ ...mockCellGroup, leader_id: 'member-other' });
      prisma.member.findFirst.mockResolvedValue({ id: mockMemberId });
      prisma.cellGroupAttendance.findUnique.mockResolvedValue(null);
      prisma.cellGroupAttendance.create.mockResolvedValue({} as never);

      await expect(
        service.recordCellGroupAttendance(
          mockGroupId,
          mockMemberId,
          undefined,
          undefined,
          meetingDate,
          'present',
          undefined,
          mockChurchId,
          mockUserId,
          {
            church_id: mockChurchId,
            branch_id: 'branch-1',
            role: 'cell_leader',
            permissions: ['cell_groups:own:read', 'cell_groups:own:update'],
            is_admin_hq: true,
          },
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.cellGroupAttendance.create).not.toHaveBeenCalled();
    });

    it('should allow an admin-hq cell_leader recording attendance for their own group (any branch member)', async () => {
      prisma.cellGroup.findFirst.mockResolvedValue({
        ...mockCellGroup,
        leader_id: 'member-leader-1',
      });
      prisma.member.findFirst.mockResolvedValue({ id: mockMemberId, branch_id: 'branch-2' });
      prisma.cellGroupAttendance.findUnique.mockResolvedValue(null);
      prisma.cellGroupAttendance.create.mockResolvedValue({} as never);

      await service.recordCellGroupAttendance(
        mockGroupId,
        mockMemberId,
        undefined,
        undefined,
        meetingDate,
        'present',
        undefined,
        mockChurchId,
        mockUserId,
        {
          church_id: mockChurchId,
          branch_id: 'branch-1',
          member_id: 'member-leader-1',
          role: 'cell_leader',
          permissions: ['cell_groups:own:read', 'cell_groups:own:update'],
          is_admin_hq: true,
        },
      );

      expect(prisma.cellGroupAttendance.create).toHaveBeenCalled();
    });

    it('should forbid a branch-restricted viewer recording a member from another branch', async () => {
      prisma.cellGroup.findFirst.mockResolvedValue({
        ...mockCellGroup,
        leader_id: 'member-leader-1',
      });
      prisma.member.findFirst.mockResolvedValue({ id: mockMemberId, branch_id: 'branch-2' });

      await expect(
        service.recordCellGroupAttendance(
          mockGroupId,
          mockMemberId,
          undefined,
          undefined,
          meetingDate,
          'present',
          undefined,
          mockChurchId,
          mockUserId,
          {
            church_id: mockChurchId,
            branch_id: 'branch-1',
            member_id: 'member-leader-1',
            role: 'cell_leader',
            permissions: ['cell_groups:own:read', 'cell_groups:own:update'],
          },
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.cellGroupAttendance.create).not.toHaveBeenCalled();
    });

    it('should allow a branch-restricted viewer recording a member from their own branch', async () => {
      prisma.cellGroup.findFirst.mockResolvedValue({
        ...mockCellGroup,
        leader_id: 'member-leader-1',
      });
      prisma.member.findFirst.mockResolvedValue({ id: mockMemberId, branch_id: 'branch-1' });
      prisma.cellGroupAttendance.findUnique.mockResolvedValue(null);
      prisma.cellGroupAttendance.create.mockResolvedValue({} as never);

      await service.recordCellGroupAttendance(
        mockGroupId,
        mockMemberId,
        undefined,
        undefined,
        meetingDate,
        'present',
        undefined,
        mockChurchId,
        mockUserId,
        {
          church_id: mockChurchId,
          branch_id: 'branch-1',
          member_id: 'member-leader-1',
          role: 'cell_leader',
          permissions: ['cell_groups:own:read', 'cell_groups:own:update'],
        },
      );

      expect(prisma.cellGroupAttendance.create).toHaveBeenCalled();
    });

    it('should forbid a branch-restricted viewer recording a visitor from another branch', async () => {
      prisma.cellGroup.findFirst.mockResolvedValue({
        ...mockCellGroup,
        leader_id: 'member-leader-1',
      });
      prisma.visitor.findFirst.mockResolvedValue({
        first_name: 'Ada',
        last_name: 'Okafor',
        branch_id: 'branch-2',
      });

      await expect(
        service.recordCellGroupAttendance(
          mockGroupId,
          undefined,
          'visitor-1',
          undefined,
          meetingDate,
          'present',
          undefined,
          mockChurchId,
          mockUserId,
          {
            church_id: mockChurchId,
            branch_id: 'branch-1',
            member_id: 'member-leader-1',
            role: 'cell_leader',
            permissions: ['cell_groups:own:read', 'cell_groups:own:update'],
          },
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.cellGroupAttendance.create).not.toHaveBeenCalled();
    });

    it('should allow a branch-restricted viewer recording an untagged (null-branch) visitor', async () => {
      prisma.cellGroup.findFirst.mockResolvedValue({
        ...mockCellGroup,
        leader_id: 'member-leader-1',
      });
      prisma.visitor.findFirst.mockResolvedValue({
        first_name: 'Ada',
        last_name: 'Okafor',
        branch_id: null,
      });
      prisma.cellGroupAttendance.findUnique.mockResolvedValue(null);
      prisma.cellGroupAttendance.create.mockResolvedValue({} as never);

      await service.recordCellGroupAttendance(
        mockGroupId,
        undefined,
        'visitor-1',
        undefined,
        meetingDate,
        'present',
        undefined,
        mockChurchId,
        mockUserId,
        {
          church_id: mockChurchId,
          branch_id: 'branch-1',
          member_id: 'member-leader-1',
          role: 'cell_leader',
          permissions: ['cell_groups:own:read', 'cell_groups:own:update'],
        },
      );

      expect(prisma.cellGroupAttendance.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            member_id: null,
            visitor_id: 'visitor-1',
            visitor_name: 'Ada Okafor',
          }),
        }),
      );
    });

    it('should register a walk-in as a new visitor in the recorder\u2019s branch', async () => {
      prisma.cellGroup.findFirst.mockResolvedValue({
        ...mockCellGroup,
        leader_id: 'member-leader-1',
      });
      prisma.visitor.create.mockResolvedValue({
        id: 'visitor-new',
        first_name: 'Walk',
        last_name: 'In Guest',
      });
      prisma.cellGroupAttendance.findUnique.mockResolvedValue(null);
      prisma.cellGroupAttendance.create.mockResolvedValue({} as never);

      await service.recordCellGroupAttendance(
        mockGroupId,
        undefined,
        undefined,
        'Walk In Guest',
        meetingDate,
        'present',
        undefined,
        mockChurchId,
        mockUserId,
        {
          church_id: mockChurchId,
          branch_id: 'branch-1',
          member_id: 'member-leader-1',
          role: 'cell_leader',
          permissions: ['cell_groups:own:read', 'cell_groups:own:update'],
        },
      );

      expect(prisma.visitor.create).toHaveBeenCalledWith({
        data: {
          church_id: mockChurchId,
          first_name: 'Walk',
          last_name: 'In Guest',
          branch_id: 'branch-1',
        },
        select: { id: true, first_name: true, last_name: true },
      });
      expect(prisma.cellGroupAttendance.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            member_id: null,
            visitor_id: 'visitor-new',
            visitor_name: 'Walk In Guest',
          }),
        }),
      );
    });

    it('should register a single-name walk-in with a null last name', async () => {
      prisma.cellGroup.findFirst.mockResolvedValue({
        ...mockCellGroup,
        leader_id: 'member-leader-1',
      });
      prisma.visitor.create.mockResolvedValue({
        id: 'visitor-new',
        first_name: 'Moses',
        last_name: null,
      });
      prisma.cellGroupAttendance.findUnique.mockResolvedValue(null);
      prisma.cellGroupAttendance.create.mockResolvedValue({} as never);

      await service.recordCellGroupAttendance(
        mockGroupId,
        undefined,
        undefined,
        'Moses',
        meetingDate,
        'present',
        undefined,
        mockChurchId,
        mockUserId,
        {
          church_id: mockChurchId,
          branch_id: 'branch-1',
          member_id: 'member-leader-1',
          role: 'cell_leader',
          permissions: ['cell_groups:own:read', 'cell_groups:own:update'],
        },
      );

      expect(prisma.visitor.create).toHaveBeenCalledWith({
        data: {
          church_id: mockChurchId,
          first_name: 'Moses',
          last_name: null,
          branch_id: 'branch-1',
        },
        select: { id: true, first_name: true, last_name: true },
      });
    });

    it('should forbid an admin-hq cell_leader recording a walk-in for a group they do not lead', async () => {
      prisma.cellGroup.findFirst.mockResolvedValue({ ...mockCellGroup, leader_id: 'member-other' });
      prisma.cellGroupAttendance.findUnique.mockResolvedValue(null);
      prisma.cellGroupAttendance.create.mockResolvedValue({} as never);

      await expect(
        service.recordCellGroupAttendance(
          mockGroupId,
          undefined,
          undefined,
          'Walk In Guest',
          meetingDate,
          'present',
          undefined,
          mockChurchId,
          mockUserId,
          {
            church_id: mockChurchId,
            branch_id: 'branch-1',
            role: 'cell_leader',
            permissions: ['cell_groups:own:read', 'cell_groups:own:update'],
            is_admin_hq: true,
          },
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.visitor.create).not.toHaveBeenCalled();
      expect(prisma.cellGroupAttendance.create).not.toHaveBeenCalled();
    });

    it('should allow an admin-hq cell_leader recording a walk-in for their own group (snapshot only, no visitor row)', async () => {
      prisma.cellGroup.findFirst.mockResolvedValue({
        ...mockCellGroup,
        leader_id: 'member-leader-1',
      });
      prisma.cellGroupAttendance.findUnique.mockResolvedValue(null);
      prisma.cellGroupAttendance.create.mockResolvedValue({} as never);

      await service.recordCellGroupAttendance(
        mockGroupId,
        undefined,
        undefined,
        'Walk In Guest',
        meetingDate,
        'present',
        undefined,
        mockChurchId,
        mockUserId,
        {
          church_id: mockChurchId,
          branch_id: 'branch-1',
          member_id: 'member-leader-1',
          role: 'cell_leader',
          permissions: ['cell_groups:own:read', 'cell_groups:own:update'],
          is_admin_hq: true,
        },
      );

      expect(prisma.visitor.create).not.toHaveBeenCalled();
      expect(prisma.cellGroupAttendance.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            member_id: null,
            visitor_id: null,
            visitor_name: 'Walk In Guest',
          }),
        }),
      );
    });
  });

  describe('listCellGroupAttendance', () => {
    it('should resolve visitor names and keep member fields nullable', async () => {
      prisma.cellGroup.findFirst.mockResolvedValue(mockCellGroup);
      prisma.cellGroupAttendance.findMany.mockResolvedValue([
        {
          id: 'att-1',
          cell_group_id: mockGroupId,
          member_id: mockMemberId,
          visitor_id: null,
          visitor_name: null,
          meeting_date: new Date('2024-06-02T10:00:00.000Z'),
          status: 'present',
          notes: null,
          created_at: new Date('2024-06-02T10:00:00.000Z'),
          member: { id: mockMemberId, first_name: 'John', last_name: 'Doe' },
          visitor: null,
        },
        {
          id: 'att-2',
          cell_group_id: mockGroupId,
          member_id: null,
          visitor_id: 'visitor-1',
          visitor_name: 'Ada Okafor',
          meeting_date: new Date('2024-06-02T10:00:00.000Z'),
          status: 'present',
          notes: null,
          created_at: new Date('2024-06-02T10:00:00.000Z'),
          member: null,
          visitor: { first_name: 'Ada', last_name: 'Okafor' },
        },
      ]);

      const result = await service.listCellGroupAttendance(mockGroupId, mockChurchId);

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        memberId: mockMemberId,
        firstName: 'John',
        lastName: 'Doe',
        visitorName: undefined,
      });
      expect(result[1]).toMatchObject({
        memberId: undefined,
        firstName: '',
        visitorId: 'visitor-1',
        visitorName: 'Ada Okafor',
      });
    });

    it('should fall back to the linked visitor name when the snapshot is empty', async () => {
      prisma.cellGroup.findFirst.mockResolvedValue(mockCellGroup);
      prisma.cellGroupAttendance.findMany.mockResolvedValue([
        {
          id: 'att-2',
          cell_group_id: mockGroupId,
          member_id: null,
          visitor_id: 'visitor-1',
          visitor_name: null,
          meeting_date: new Date('2024-06-02T10:00:00.000Z'),
          status: 'present',
          notes: null,
          created_at: new Date('2024-06-02T10:00:00.000Z'),
          member: null,
          visitor: { first_name: 'Ada', last_name: 'Okafor' },
        },
      ]);

      const result = await service.listCellGroupAttendance(mockGroupId, mockChurchId);

      expect(result[0].visitorName).toBe('Ada Okafor');
    });
  });

  describe('findNearestGroups', () => {
    it('should find nearest groups sorted by distance', async () => {
      prisma.cellGroup.findMany.mockResolvedValue([
        { ...mockCellGroup, latitude: 6.5244, longitude: 3.3792 },
        {
          ...mockCellGroup,
          id: 'group-2',
          name: 'Grace Cell',
          latitude: 6.6,
          longitude: 3.4,
        },
      ]);

      const result = await service.findNearestGroups(6.52, 3.38, mockChurchId);

      expect(result).toHaveLength(2);
      expect(result[0].distanceKm).toBeLessThanOrEqual(result[1].distanceKm);
    });

    it('should limit results', async () => {
      prisma.cellGroup.findMany.mockResolvedValue(
        Array.from({ length: 10 }, (_, i) => ({
          ...mockCellGroup,
          id: `group-${i}`,
          latitude: 6.5 + i * 0.01,
          longitude: 3.37 + i * 0.01,
        })),
      );

      const result = await service.findNearestGroups(6.5, 3.37, mockChurchId, 3);

      expect(result).toHaveLength(3);
    });

    it('should resolve leader names in nearest results', async () => {
      prisma.cellGroup.findMany.mockResolvedValue([
        { ...mockCellGroup, leader_id: mockMemberId, latitude: 6.5244, longitude: 3.3792 },
      ]);
      prisma.member.findMany.mockResolvedValue([
        { id: mockMemberId, first_name: 'Ada', last_name: 'Okafor' },
      ]);

      const result = await service.findNearestGroups(6.52, 3.38, mockChurchId);

      expect(result).toHaveLength(1);
      expect(result[0].leaderFirstName).toBe('Ada');
      expect(result[0].leaderLastName).toBe('Okafor');
    });
  });

  describe('archiveDepartment', () => {
    it('should set archived_at and audit ARCHIVE', async () => {
      const archivedAt = new Date('2026-08-28T12:00:00.000Z');
      prisma.department.findFirst.mockResolvedValue(mockDepartment);
      prisma.department.update.mockResolvedValue({
        ...mockDepartment,
        archived_at: archivedAt,
        department_members: [],
      });

      const result = await service.archiveDepartment(mockDepartmentId, mockChurchId, mockUserId);

      expect(prisma.department.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: mockDepartmentId },
          data: { archived_at: expect.any(Date) },
        }),
      );
      expect(result.archivedAt).toBe(archivedAt.toISOString());
      expect(auditLog).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'ARCHIVE', entity: 'department' }),
      );
    });

    it('should throw ConflictException when already archived', async () => {
      prisma.department.findFirst.mockResolvedValue({
        ...mockDepartment,
        archived_at: new Date(),
      });

      await expect(
        service.archiveDepartment(mockDepartmentId, mockChurchId, mockUserId),
      ).rejects.toThrow(ConflictException);
    });

    it('should throw NotFoundException when department is missing', async () => {
      prisma.department.findFirst.mockResolvedValue(null);

      await expect(
        service.archiveDepartment(mockDepartmentId, mockChurchId, mockUserId),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('restoreDepartment', () => {
    it('should clear archived_at and audit RESTORE', async () => {
      prisma.department.findFirst.mockResolvedValue({
        ...mockDepartment,
        archived_at: new Date('2026-08-27T12:00:00.000Z'),
      });
      prisma.department.update.mockResolvedValue({
        ...mockDepartment,
        archived_at: null,
        department_members: [],
      });

      const result = await service.restoreDepartment(mockDepartmentId, mockChurchId, mockUserId);

      expect(prisma.department.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: mockDepartmentId }, data: { archived_at: null } }),
      );
      expect(result.archivedAt).toBeUndefined();
      expect(auditLog).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'RESTORE', entity: 'department' }),
      );
    });

    it('should throw ConflictException when not archived', async () => {
      prisma.department.findFirst.mockResolvedValue(mockDepartment);

      await expect(
        service.restoreDepartment(mockDepartmentId, mockChurchId, mockUserId),
      ).rejects.toThrow(ConflictException);
    });

    it('should throw NotFoundException when department is missing', async () => {
      prisma.department.findFirst.mockResolvedValue(null);

      await expect(
        service.restoreDepartment(mockDepartmentId, mockChurchId, mockUserId),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('department list & purge archive behavior', () => {
    it('should exclude archived departments by default', async () => {
      prisma.department.findMany.mockResolvedValue([mockDepartment]);

      const result = await service.listDepartments(mockChurchId);

      expect(prisma.department.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ archived_at: null }) }),
      );
      expect(result[0].archivedAt).toBeUndefined();
    });

    it('should list only archived departments when archived=true', async () => {
      const archivedAt = new Date('2026-08-28T10:00:00.000Z');
      prisma.department.findMany.mockResolvedValue([
        { ...mockDepartment, archived_at: archivedAt },
      ]);

      const result = await service.listDepartments(mockChurchId, true);

      expect(prisma.department.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ archived_at: { not: null } }),
        }),
      );
      expect(result[0].archivedAt).toBe(archivedAt.toISOString());
    });

    it('should still hard-delete (purge) an archived department', async () => {
      prisma.department.findFirst.mockResolvedValue({
        ...mockDepartment,
        archived_at: new Date(),
        _count: { department_members: 0 },
      });
      prisma.department.delete.mockResolvedValue(mockDepartment);

      await service.deleteDepartment(mockDepartmentId, mockChurchId, mockUserId);

      expect(prisma.department.delete).toHaveBeenCalled();
    });

    it('should throw NotFoundException when adding a member to an archived department', async () => {
      prisma.department.findFirst.mockResolvedValue({
        ...mockDepartment,
        archived_at: new Date(),
      });

      await expect(
        service.addDepartmentMember(
          mockDepartmentId,
          { memberId: mockMemberId },
          mockChurchId,
          mockUserId,
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('archiveCellGroup', () => {
    it('should set archived_at and audit ARCHIVE', async () => {
      const archivedAt = new Date('2026-08-28T12:00:00.000Z');
      prisma.cellGroup.findFirst.mockResolvedValue(mockCellGroup);
      prisma.cellGroup.update.mockResolvedValue({
        ...mockCellGroup,
        archived_at: archivedAt,
        branch: null,
      });

      const result = await service.archiveCellGroup(mockGroupId, mockChurchId, mockUserId);

      expect(prisma.cellGroup.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: mockGroupId },
          data: { archived_at: expect.any(Date) },
        }),
      );
      expect(result.archivedAt).toBe(archivedAt.toISOString());
      expect(auditLog).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'ARCHIVE', entity: 'cell_group' }),
      );
    });

    it('should throw ConflictException when already archived', async () => {
      prisma.cellGroup.findFirst.mockResolvedValue({ ...mockCellGroup, archived_at: new Date() });

      await expect(service.archiveCellGroup(mockGroupId, mockChurchId, mockUserId)).rejects.toThrow(
        ConflictException,
      );
    });

    it('should throw NotFoundException when group is missing', async () => {
      prisma.cellGroup.findFirst.mockResolvedValue(null);

      await expect(service.archiveCellGroup(mockGroupId, mockChurchId, mockUserId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('restoreCellGroup', () => {
    it('should clear archived_at and audit RESTORE', async () => {
      prisma.cellGroup.findFirst.mockResolvedValue({
        ...mockCellGroup,
        archived_at: new Date('2026-08-27T12:00:00.000Z'),
      });
      prisma.cellGroup.update.mockResolvedValue({
        ...mockCellGroup,
        archived_at: null,
        branch: null,
      });

      const result = await service.restoreCellGroup(mockGroupId, mockChurchId, mockUserId);

      expect(prisma.cellGroup.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: mockGroupId }, data: { archived_at: null } }),
      );
      expect(result.archivedAt).toBeUndefined();
      expect(auditLog).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'RESTORE', entity: 'cell_group' }),
      );
    });

    it('should throw ConflictException when not archived', async () => {
      prisma.cellGroup.findFirst.mockResolvedValue(mockCellGroup);

      await expect(service.restoreCellGroup(mockGroupId, mockChurchId, mockUserId)).rejects.toThrow(
        ConflictException,
      );
    });

    it('should throw NotFoundException when group is missing', async () => {
      prisma.cellGroup.findFirst.mockResolvedValue(null);

      await expect(service.restoreCellGroup(mockGroupId, mockChurchId, mockUserId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('cell group list & purge archive behavior', () => {
    it('should exclude archived cell groups by default', async () => {
      prisma.cellGroup.findMany.mockResolvedValue([mockCellGroup]);

      const result = await service.listCellGroups(mockChurchId);

      expect(prisma.cellGroup.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ archived_at: null }) }),
      );
      expect(result[0].archivedAt).toBeUndefined();
    });

    it('should list only archived cell groups when archived=true', async () => {
      const archivedAt = new Date('2026-08-28T10:00:00.000Z');
      prisma.cellGroup.findMany.mockResolvedValue([{ ...mockCellGroup, archived_at: archivedAt }]);

      const result = await service.listCellGroups(mockChurchId, { archived: true });

      expect(prisma.cellGroup.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ archived_at: { not: null } }),
        }),
      );
      expect(result[0].archivedAt).toBe(archivedAt.toISOString());
    });

    it('should still hard-delete (purge) an archived cell group', async () => {
      prisma.cellGroup.findFirst.mockResolvedValue({
        ...mockCellGroup,
        archived_at: new Date(),
      });
      prisma.cellGroup.delete.mockResolvedValue(mockCellGroup);

      await service.deleteCellGroup(mockGroupId, mockChurchId, mockUserId);

      expect(prisma.cellGroup.delete).toHaveBeenCalled();
    });

    it('should throw NotFoundException when updating an archived cell group', async () => {
      prisma.cellGroup.findFirst.mockResolvedValue({ ...mockCellGroup, archived_at: new Date() });

      await expect(
        service.updateCellGroup(mockGroupId, { name: 'X' }, mockChurchId, mockUserId),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException when adding a member to an archived cell group', async () => {
      prisma.cellGroup.findFirst.mockResolvedValue({ ...mockCellGroup, archived_at: new Date() });

      await expect(
        service.addCellGroupMember(mockGroupId, mockMemberId, 'member', mockChurchId, mockUserId),
      ).rejects.toThrow(NotFoundException);
    });
  });
  describe('cell group data updates and scoped export contracts', () => {
    it('persists all supplied meeting fields, including zero coordinates and cleared text', async () => {
      prisma.cellGroup.findFirst.mockResolvedValue(mockCellGroup);
      prisma.cellGroup.update.mockResolvedValue(mockCellGroup);
      await service.updateCellGroup(
        mockGroupId,
        { name: 'Care', address: '', latitude: 0, longitude: 0, meetingDay: '', meetingTime: '' },
        mockChurchId,
        mockUserId,
      );
      expect(prisma.cellGroup.update.mock.calls[0][0].data).toEqual({
        name: 'Care',
        address: '',
        latitude: 0,
        longitude: 0,
        meeting_day: '',
        meeting_time: '',
      });
      expect(auditLog).toHaveBeenCalledWith(
        expect.objectContaining({ entityId: mockGroupId, action: 'UPDATE' }),
      );
    });
    it('updates the department parent and name without assigning an unrelated head', async () => {
      prisma.department.findFirst.mockResolvedValue(mockDepartment);
      prisma.department.update.mockResolvedValue(mockDepartment);
      await service.updateDepartment(
        mockDepartmentId,
        plainToInstance(CreateDepartmentDto, { name: 'Care', parentId: null }),
        mockChurchId,
        mockUserId,
      );
      expect(prisma.department.update.mock.calls[0][0].data).toEqual({
        name: 'Care',
        parent_id: null,
      });
    });
    it('exports quoted meeting details while preserving the same viewer and query scope', async () => {
      const rows = [
        {
          id: 'group',
          name: 'Care, "Together"',
          leaderFirstName: 'Ada',
          leaderLastName: 'Guest',
          branchName: 'Main',
          address: 'Line 1\nLine 2',
          meetingDay: 'Sunday',
          meetingTime: '18:00',
          latitude: 6.5,
          longitude: 3.4,
          createdAt: '2026-01-01',
        },
        { id: 'legacy', name: 'Legacy', createdAt: '2026-01-01' },
      ];
      const list = jest
        .spyOn(service, 'listCellGroups')
        .mockResolvedValue(
          rows.map((row) => ({ ...row, churchId: mockChurchId, updatedAt: '2026-01-01' })),
        );
      const viewer = {
        church_id: mockChurchId,
        role: 'cell_leader',
        member_id: mockMemberId,
        branch_id: 'own',
        permissions: ['cell_groups:own:read'],
      };
      const csv = await service.exportCellGroupsCsv(mockChurchId, { search: 'Care' }, viewer);
      expect(list).toHaveBeenCalledWith(mockChurchId, { search: 'Care' }, viewer);
      expect(csv).toContain('"Care, ""Together"""');
      expect(csv).toContain('"Line 1\nLine 2"');
      expect(csv).toContain('Sunday,18:00,6.5,3.4');
      expect(csv).toContain('legacy,Legacy');
    });
  });
});
