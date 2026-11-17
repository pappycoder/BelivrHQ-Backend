import { AnalyticsService } from '../../../src/analytics/analytics.service';
import { BranchScopeService } from '../../../src/common/services/branch-scope.service';
import { RequestContextService } from '../../../src/common/services/request-context.service';
import { createPrismaMock } from '../../helpers/prisma-mock.helper';

describe('Analytics date bounds, branch filters and historical data', () => {
  const church = 'church-a';
  let prisma: ReturnType<typeof createPrismaMock>, service: AnalyticsService;
  beforeEach(() => {
    prisma = createPrismaMock();
    for (const model of [
      'member',
      'branch',
      'attendance',
      'riskScore',
      'event',
      'formSubmission',
      'engagementScore',
      'givingCategory',
      'recurringGiving',
      'message',
      'broadcast',
      'ticket',
      'eventRegistration',
    ]) {
      prisma[model].count.mockResolvedValue(0);
      prisma[model].findMany.mockResolvedValue([]);
      prisma[model].groupBy.mockResolvedValue([]);
    }
    prisma.transaction.aggregate.mockResolvedValue({ _sum: { amount: 0 }, _count: { amount: 0 } });
    prisma.transaction.groupBy.mockResolvedValue([]);
    prisma.transaction.findMany.mockResolvedValue([]);
    service = new AnalyticsService(
      prisma as never,
      new BranchScopeService(new RequestContextService()),
    );
  });
  it.each([
    { hq: false, query: { startDate: '2026-01-01' }, expected: { gte: new Date('2026-01-01') } },
    { hq: true, query: { endDate: '2026-02-01' }, expected: { lte: new Date('2026-02-01') } },
    {
      hq: false,
      query: { startDate: '2026-01-01', endDate: '2026-02-01' },
      expected: { gte: new Date('2026-01-01'), lte: new Date('2026-02-01') },
    },
  ])(
    'uses open-ended giving ranges without widening a branch viewer: HQ=$hq query=$query',
    async ({ hq, query, expected }) => {
      const result = await service.getGivingAnalytics(
        church,
        { ...query, currency: 'NGN', branchId: 'requested' },
        { church_id: church, role: 'church_admin', is_admin_hq: hq, branch_id: 'own' },
      );
      expect(result.total).toBe(0);
      expect(prisma.transaction.aggregate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            church_id: church,
            status: 'success',
            currency: 'NGN',
            giving_date: expected,
            branch_id: hq ? 'requested' : 'own',
          },
        }),
      );
      expect(prisma.recurringGiving.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            church_id: church,
            is_active: true,
            currency: 'NGN',
            member: { branch_id: hq ? 'requested' : 'own' },
          },
        }),
      );
    },
  );
  it('keeps dashboard counts and related risk scores in the current branch', async () => {
    await service.getDashboard(
      church,
      {},
      { church_id: church, role: 'church_admin', branch_id: 'own', is_admin_hq: false },
    );
    expect(prisma.member.count).toHaveBeenCalledWith({
      where: { church_id: church, branch_id: 'own' },
    });
    expect(prisma.branch.count).toHaveBeenCalledWith({ where: { church_id: church, id: 'own' } });
    expect(prisma.riskScore.count).toHaveBeenCalledWith({
      where: {
        church_id: church,
        level: { in: ['high', 'critical'] },
        member: { branch_id: 'own' },
      },
    });
    expect(prisma.engagementScore.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ church_id: church, member: { branch_id: 'own' } }),
      }),
    );
  });
  it('retains unknown and unassigned category/branch labels and normalizes recurring frequencies', async () => {
    prisma.transaction.groupBy.mockImplementation(async ({ by }) => {
      const key = by[0];
      if (key === 'status') return [{ status: 'success', _count: { id: 2 } }];
      if (key === 'member_id')
        return [{ member_id: 'removed', _sum: { amount: 0 }, _count: { amount: 1 } }];
      if (key === 'type') return [{ type: 'cash', _sum: { amount: 0 }, _count: { amount: 1 } }];
      return [
        { [key]: null, _sum: { amount: 0 }, _count: { amount: 1 } },
        { [key]: 'missing', _sum: { amount: 0 }, _count: { amount: 1 } },
      ];
    });
    prisma.recurringGiving.findMany.mockResolvedValue([
      { amount: 100, frequency: 'weekly' },
      { amount: 400, frequency: 'monthly' },
      { amount: 900, frequency: 'quarterly' },
    ]);
    const result = await service.getGivingAnalytics(church, {});
    expect(result.byCategory.map((item) => item.categoryName)).toEqual([
      'Uncategorized',
      'Unknown',
    ]);
    expect(result.byBranch.map((item) => item.branchName)).toEqual(['No branch', 'Unknown']);
    expect(result.topDonors[0]).toMatchObject({ memberName: 'Unknown', total: 0 });
    expect(result.recurring).toEqual({ active: 3, totalMonthlyAmount: 1100, totalScheduled: 1400 });
    expect(result.byStatus).toEqual({ success: 2 });
  });
  it.each(['day', 'week', 'month'] as const)(
    'builds sorted %s giving periods from business giving dates',
    async (groupBy) => {
      prisma.transaction.findMany.mockResolvedValue([
        { giving_date: new Date('2026-01-10'), amount: 100 },
        { giving_date: new Date('2026-01-09'), amount: 200 },
        { giving_date: new Date('2026-01-01'), amount: 300 },
      ]);
      const { trend } = await service.getGivingAnalytics(church, { groupBy });
      expect(trend.map((point) => point.date)).toEqual(
        groupBy === 'day'
          ? ['2026-01-01', '2026-01-09', '2026-01-10']
          : groupBy === 'week'
            ? ['2025-12-28', '2026-01-04']
            : ['2026-01'],
      );
      expect(trend.reduce((total, point) => total + point.total, 0)).toBe(600);
    },
  );
  it('counts age boundaries using actual birthdays rather than birth years alone', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-10T12:00:00Z'));
    try {
      const birthdays = [
        '2008-01-11',
        '2008-02-01',
        '2008-01-10',
        '2000-01-01',
        '1990-01-01',
        '1970-01-01',
        '1966-01-01',
        '1965-01-01',
        null,
      ];
      prisma.member.findMany.mockResolvedValue(
        birthdays.map((birthday, i) => ({
          id: String(i),
          status: 'active',
          gender: null,
          date_of_birth: birthday ? new Date(birthday) : null,
          member_since: new Date(i % 2 ? '2026-02-01' : '2026-01-01'),
        })),
      );
      prisma.member.groupBy
        .mockResolvedValueOnce([{ status: 'active', _count: { id: 9 } }])
        .mockResolvedValueOnce([{ gender: null, _count: { id: 9 } }]);
      const result = await service.getMemberAnalytics(church);
      expect(result.byAgeGroup).toEqual({
        under_18: 2,
        age_18_30: 2,
        age_31_45: 1,
        age_46_60: 2,
        age_60_plus: 1,
        unspecified: 1,
      });
      expect(result.byGender).toEqual({ unspecified: 9 });
      expect(result.growth.map((point) => point.total)).toEqual([5, 9]);
    } finally {
      jest.useRealTimers();
    }
  });
  it.each([true, false])(
    'aggregates attendance with explicit HQ=%s branch selection and unassigned services',
    async (hq) => {
      prisma.attendance.count
        .mockResolvedValueOnce(3)
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(1);
      prisma.attendance.groupBy.mockResolvedValue([{ source: 'manual', _count: { id: 3 } }]);
      prisma.attendance.findMany.mockResolvedValue([
        {
          id: 'a',
          checkin_at: new Date('2026-01-01'),
          member_id: 'member-a',
          service: { id: 'service-a', name: 'Sunday', branch_id: null, branch: null },
        },
        {
          id: 'b',
          checkin_at: new Date('2026-01-02'),
          member_id: null,
          service: { id: 'service-a', name: 'Sunday', branch_id: null, branch: null },
        },
        { id: 'c', checkin_at: new Date('2026-01-03'), member_id: 'member-b', service: null },
      ]);
      const result = await service.getAttendanceAnalytics(
        church,
        { branchId: 'selected', startDate: '2026-01-01', endDate: '2026-02-01', groupBy: 'week' },
        { church_id: church, role: 'church_admin', is_admin_hq: hq, branch_id: 'own' },
      );
      expect(result.byBranch).toEqual([
        { branchId: undefined, branchName: 'No branch', total: 2, count: 2 },
      ]);
      expect(result.byService).toEqual([
        { serviceId: 'service-a', serviceName: 'Sunday', total: 2, members: 1, visitors: 1 },
      ]);
      expect(prisma.attendance.count).toHaveBeenCalledWith({
        where: {
          church_id: church,
          checkin_at: { gte: new Date('2026-01-01'), lte: new Date('2026-02-01') },
          service: { branch_id: hq ? 'selected' : 'own' },
        },
      });
      expect(result.trend.reduce((total, point) => total + point.total, 0)).toBe(3);
    },
  );
});
