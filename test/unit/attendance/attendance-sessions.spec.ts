import { AttendanceService } from '../../../src/attendance/attendance.service';
import { AttendanceSessionsController } from '../../../src/attendance/attendance-sessions.controller';
import { RequestContextService } from '../../../src/common/services/request-context.service';
import { BranchScopeService, ViewerScope } from '../../../src/common/services/branch-scope.service';
import { createPrismaMock } from '../../helpers/prisma-mock.helper';

describe('Shared attendance session scope', () => {
  const church = 'church-a',
    branch = 'branch-a';
  const viewer: ViewerScope = {
    church_id: church,
    branch_id: branch,
    member_id: 'owner-a',
    role: 'custom',
    permissions: [],
  };
  const input = { attendanceDate: '2026-10-18', total: 100 };
  let prisma: ReturnType<typeof createPrismaMock>, service: AttendanceService;
  beforeEach(() => {
    prisma = createPrismaMock();
    const context = new RequestContextService();
    service = new AttendanceService(
      prisma as never,
      context,
      { log: jest.fn() } as never,
      new BranchScopeService(context),
    );
    prisma.branch.findFirst.mockResolvedValue({ id: branch });
    prisma.attendanceSession.findMany.mockResolvedValue([]);
    prisma.attendanceSession.count.mockResolvedValue(0);
  });
  it.each(['service', 'event', 'department', 'cell_group'] as const)(
    'uses one total-only schema for %s',
    async (type) => {
      const model = type === 'cell_group' ? 'cellGroup' : type;
      prisma[model].findFirst.mockResolvedValue({
        id: 'parent-a',
        church_id: church,
        branch_id: branch,
        ...(type === 'event'
          ? {
              start_date: new Date(`${input.attendanceDate}T09:00:00Z`),
              recurrence: 'one_time',
            }
          : {}),
      });
      const field = `${type}_id`;
      prisma.attendanceSession.create.mockResolvedValue({
        id: 'session-a',
        church_id: church,
        branch_id: branch,
        [field]: 'parent-a',
        attendance_date: new Date(input.attendanceDate),
        total: 100,
        adult_count: null,
        children_count: null,
        male_count: null,
        female_count: null,
      });
      const record = await service.recordSession(type, 'parent-a', input, church, 'user-a', viewer);
      expect(record).toMatchObject({
        contextType: type,
        contextId: 'parent-a',
        total: 100,
        adultCount: null,
        maleCount: null,
      });
      expect(prisma.attendanceSession.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ [field]: 'parent-a', total: 100, adult_count: null }),
        }),
      );
    },
  );
  it.each(['department', 'cell_group'] as const)(
    'keeps HQ own-scope %s writes restricted while allowing church-wide reading',
    async (type) => {
      const model = type === 'cell_group' ? 'cellGroup' : type,
        resource = type === 'cell_group' ? 'cell_groups' : 'departments';
      const own = {
        ...viewer,
        is_admin_hq: true,
        permissions: [`${resource}:own:read`, `${resource}:own:update`],
      };
      prisma[model].findFirst.mockResolvedValue({
        id: 'parent-b',
        church_id: church,
        branch_id: branch,
        head_member_id: 'owner-b',
        leader_id: 'owner-b',
      });
      await expect(
        service.recordSession(type, 'parent-b', input, church, 'user-a', own),
      ).rejects.toThrow('own');
      expect(prisma.attendanceSession.create).not.toHaveBeenCalled();
      await expect(service.listSessions(type, 'parent-b', church, {}, own)).resolves.toMatchObject({
        data: [],
      });
    },
  );
  it.each(['department', 'cell_group'] as const)(
    'hides another owner’s %s from a branch own-reader',
    async (type) => {
      const model = type === 'cell_group' ? 'cellGroup' : type,
        resource = type === 'cell_group' ? 'cell_groups' : 'departments';
      prisma[model].findFirst.mockResolvedValue({
        id: 'parent-b',
        church_id: church,
        branch_id: branch,
        head_member_id: 'owner-b',
        leader_id: 'owner-b',
      });
      await expect(
        service.listSessions(
          type,
          'parent-b',
          church,
          {},
          { ...viewer, permissions: [`${resource}:own:read`] },
        ),
      ).rejects.toThrow('not found');
      expect(prisma.attendanceSession.findMany).not.toHaveBeenCalled();
    },
  );
  it('cannot use a service-update grant to change another session context', async () => {
    prisma.attendanceSession.findFirst.mockResolvedValue(null);
    await expect(
      service.updateGeneralAttendance('department-session', { total: 2 }, church, 'user-a', viewer),
    ).rejects.toThrow('not found');
    expect(prisma.attendanceSession.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'department-session',
        church_id: church,
        branch_id: branch,
        service_id: { not: null },
      },
    });
  });
  it('declares the existing context-specific permissions on every new route', () => {
    for (const [context, read, create, update] of [
      ['Event', 'events:checkin:read', 'events:checkin:create', 'events:checkin:update'],
      ['Department', 'departments:read', 'departments:update', 'departments:update'],
      ['CellGroup', 'cell_groups:details:read', 'cell_groups:create', 'cell_groups:update'],
    ]) {
      for (const [prefix, permission] of [
        ['list', read],
        ['summary', read],
        ['record', create],
        ['update', update],
      ]) {
        const handler =
          AttendanceSessionsController.prototype[
            `${prefix}${context}` as keyof AttendanceSessionsController
          ];
        expect(Reflect.getMetadata('permissions', handler)).toEqual([permission]);
      }
    }
  });
});
