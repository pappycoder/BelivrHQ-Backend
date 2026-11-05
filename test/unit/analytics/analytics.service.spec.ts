import { RequestContextService } from '../../../src/common/services/request-context.service';
/**
 * @file analytics.service.spec.ts
 * @description Unit tests for AnalyticsService.
 *
 * @module test/unit/analytics/analytics.service.spec
 * @since 1.0.0
 */

import { Test, TestingModule } from '@nestjs/testing';
import { AnalyticsService } from '../../../src/analytics/analytics.service';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { BranchScopeService } from '../../../src/common/services/branch-scope.service';
import {
  AnalyticsDateRangeDto,
  AnalyticsTrendQueryDto,
} from '../../../src/analytics/dto/analytics-date-range.dto';

// Mock PrismaService
const mockPrismaService = {
  member: {
    count: jest.fn(),
    findMany: jest.fn(),
    groupBy: jest.fn(),
  },
  branch: {
    count: jest.fn(),
    findMany: jest.fn(),
  },
  attendance: {
    count: jest.fn(),
    findMany: jest.fn(),
    groupBy: jest.fn(),
  },
  transaction: {
    aggregate: jest.fn(),
    groupBy: jest.fn(),
    findMany: jest.fn(),
  },
  riskScore: {
    count: jest.fn(),
  },
  event: {
    count: jest.fn(),
    findMany: jest.fn(),
    aggregate: jest.fn(),
  },
  formSubmission: {
    count: jest.fn(),
  },
  engagementScore: {
    count: jest.fn(),
  },
  givingCategory: {
    findMany: jest.fn(),
  },
  recurringGiving: {
    findMany: jest.fn(),
  },
  message: {
    groupBy: jest.fn(),
  },
  broadcast: {
    findMany: jest.fn(),
  },
  ticket: {
    findMany: jest.fn(),
  },
  eventRegistration: {
    findMany: jest.fn(),
  },
  $queryRaw: jest.fn(),
};

describe('AnalyticsService', () => {
  let service: AnalyticsService;
  let prisma: typeof mockPrismaService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RequestContextService,
        AnalyticsService,
        { provide: PrismaService, useValue: mockPrismaService },
        BranchScopeService,
      ],
    }).compile();

    service = module.get<AnalyticsService>(AnalyticsService);
    prisma = module.get(PrismaService);

    jest.clearAllMocks();
  });

  describe('getDashboard', () => {
    const churchId = 'church-123';
    const query: AnalyticsDateRangeDto = { startDate: '2026-01-01', endDate: '2026-01-31' };

    it('should return dashboard data with all counts', async () => {
      prisma.member.count
        .mockResolvedValueOnce(100) // totalMembers
        .mockResolvedValueOnce(80) // activeMembers
        .mockResolvedValueOnce(5); // newMembers
      prisma.branch.count.mockResolvedValue(3);
      prisma.attendance.count.mockResolvedValue(250);
      prisma.transaction.aggregate.mockResolvedValue({ _sum: { amount: 50000 } });
      prisma.riskScore.count.mockResolvedValue(12);
      prisma.event.count.mockResolvedValue(4);
      prisma.formSubmission.count.mockResolvedValue(3);
      prisma.engagementScore.count
        .mockResolvedValueOnce(20) // highly
        .mockResolvedValueOnce(30) // moderately
        .mockResolvedValueOnce(25) // low
        .mockResolvedValueOnce(5); // disengaged

      const result = await service.getDashboard(churchId, query);

      expect(result).toEqual({
        totalMembers: 100,
        activeMembers: 80,
        newMembers: 5,
        totalBranches: 3,
        totalAttendance: 250,
        totalGiving: 50000,
        atRiskCount: 12,
        upcomingEvents: 4,
        pendingSubmissions: 3,
        engagementDistribution: {
          highlyEngaged: 20,
          moderatelyEngaged: 30,
          lowEngaged: 25,
          disengaged: 5,
        },
      });
    });

    it('should treat an absent range as all time (no date predicates)', async () => {
      prisma.member.count.mockResolvedValue(0);
      prisma.branch.count.mockResolvedValue(0);
      prisma.attendance.count.mockResolvedValue(0);
      prisma.transaction.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
      prisma.riskScore.count.mockResolvedValue(0);
      prisma.event.count.mockResolvedValue(0);
      prisma.formSubmission.count.mockResolvedValue(0);
      prisma.engagementScore.count.mockResolvedValue(0);

      const result = await service.getDashboard(churchId, {});

      expect(result.totalMembers).toBe(0);
      expect(prisma.member.count).toHaveBeenCalledTimes(3);
      // Member-since count for new members carries NO date predicate when absent.
      const newMembersCall = prisma.member.count.mock.calls.at(-1)?.[0];
      expect(newMembersCall).toBeDefined();
      // attendance + giving also run without date filters.
      expect(prisma.attendance.count).toHaveBeenCalledTimes(1);
      const attendanceCall = prisma.attendance.count.mock.calls[0][0];
      expect(attendanceCall?.where).not.toHaveProperty('checkin_at');
    });
  });

  describe('getGivingAnalytics', () => {
    const churchId = 'church-123';
    const query: AnalyticsTrendQueryDto = { startDate: '2026-01-01', endDate: '2026-01-31' };

    it('should return giving analytics with breakdowns', async () => {
      prisma.transaction.aggregate.mockResolvedValue({
        _sum: { amount: 10000 },
        _count: { amount: 20 },
      });
      prisma.transaction.groupBy
        .mockResolvedValueOnce([
          { category_id: 'cat1', _sum: { amount: 5000 }, _count: { amount: 10 } },
        ]) // byCategory
        .mockResolvedValueOnce([
          { branch_id: 'br1', _sum: { amount: 6000 }, _count: { amount: 12 } },
        ]) // byBranch
        .mockResolvedValueOnce([
          { type: 'digital', _sum: { amount: 8000 }, _count: { amount: 15 } },
        ]) // byType
        .mockResolvedValueOnce([{ status: 'success', _count: { id: 20 } }]); // byStatus
      prisma.transaction.groupBy.mockResolvedValueOnce([
        { member_id: 'mem1', _sum: { amount: 3000 }, _count: { amount: 5 } },
      ]); // topDonors
      prisma.givingCategory.findMany.mockResolvedValue([{ id: 'cat1', name: 'Tithe' }]);
      prisma.branch.findMany.mockResolvedValue([{ id: 'br1', name: 'Main Campus' }]);
      prisma.member.findMany.mockResolvedValue([
        { id: 'mem1', first_name: 'John', last_name: 'Doe' },
      ]);
      prisma.recurringGiving.findMany.mockResolvedValue([
        { amount: 1000, frequency: 'monthly' },
        { amount: 500, frequency: 'weekly' },
      ]);
      prisma.transaction.findMany.mockResolvedValue([
        { giving_date: new Date('2026-01-15'), amount: 1000 },
      ]);

      const result = await service.getGivingAnalytics(churchId, query);

      expect(result.total).toBe(10000);
      expect(result.count).toBe(20);
      expect(result.average).toBe(500);
      expect(result.byCategory).toHaveLength(1);
      expect(result.byBranch).toHaveLength(1);
      expect(result.byType).toHaveLength(1);
      expect(result.topDonors).toHaveLength(1);
      expect(result.recurring.active).toBe(2);
      expect(result.recurring.totalMonthlyAmount).toBe(1000 + 500 * 4); // weekly * 4 + monthly
      expect(result.trend).toHaveLength(1);
    });

    it('should scope a non-HQ viewer to their own branch', async () => {
      prisma.transaction.aggregate.mockResolvedValue({
        _sum: { amount: 0 },
        _count: { amount: 0 },
      });
      prisma.transaction.groupBy.mockResolvedValue([]);
      prisma.recurringGiving.findMany.mockResolvedValue([]);
      prisma.transaction.findMany.mockResolvedValue([]);

      await service.getGivingAnalytics(
        churchId,
        { currency: 'USD' },
        {
          church_id: churchId,
          branch_id: 'branch-a',
          role: 'treasurer',
          is_admin_hq: false,
        },
      );

      expect(prisma.recurringGiving.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ currency: 'USD', member: { branch_id: 'branch-a' } }),
        }),
      );
      for (const [call] of prisma.transaction.groupBy.mock.calls)
        expect(call.where).toMatchObject({ currency: 'USD', branch_id: 'branch-a' });
      expect(prisma.transaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ currency: 'USD', branch_id: 'branch-a' }),
        }),
      );
      expect(prisma.transaction.aggregate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ branch_id: 'branch-a', currency: 'USD' }),
        }),
      );
    });
  });

  describe('getAttendanceAnalytics', () => {
    const churchId = 'church-123';
    const query: AnalyticsTrendQueryDto = { startDate: '2026-01-01', endDate: '2026-01-31' };

    it('should return attendance analytics', async () => {
      prisma.attendance.count
        .mockResolvedValueOnce(150) // total
        .mockResolvedValueOnce(120) // members
        .mockResolvedValueOnce(30); // visitors
      prisma.attendance.groupBy.mockResolvedValue([{ source: 'manual', _count: { id: 100 } }]);
      prisma.attendance.findMany.mockResolvedValue([
        {
          id: 'att1',
          checkin_at: new Date('2026-01-15T10:00:00Z'),
          member_id: 'mem1',
          visitor_name: null,
          service: {
            id: 'svc1',
            name: 'Sunday Service',
            branch_id: 'br1',
            branch: { name: 'Main' },
          },
        },
        {
          id: 'att2',
          checkin_at: new Date('2026-01-15T10:00:00Z'),
          member_id: null,
          visitor_name: 'Visitor',
          service: {
            id: 'svc1',
            name: 'Sunday Service',
            branch_id: 'br1',
            branch: { name: 'Main' },
          },
        },
      ]);
      prisma.$queryRaw.mockResolvedValue([{ count: 5 }]); // firstTimeVisitors

      const result = await service.getAttendanceAnalytics(churchId, query);

      expect(result.total).toBe(150);
      expect(result.members).toBe(120);
      expect(result.visitors).toBe(30);
      expect(result.firstTimeVisitors).toBe(5);
      expect(result.returningVisitors).toBe(25);
      expect(result.trend).toHaveLength(1);
    });

    it('should treat an absent range as all time and count every first-time visitor', async () => {
      prisma.attendance.count
        .mockResolvedValueOnce(150) // total
        .mockResolvedValueOnce(120) // members
        .mockResolvedValueOnce(30); // visitors
      prisma.attendance.groupBy.mockResolvedValue([{ source: 'manual', _count: { id: 100 } }]);
      prisma.attendance.findMany.mockResolvedValue([]);
      prisma.$queryRaw.mockResolvedValue([{ count: 30 }]); // all-time firstTimeVisitors

      const result = await service.getAttendanceAnalytics(churchId, {});

      expect(result.total).toBe(150);
      expect(result.visitors).toBe(30);
      expect(result.firstTimeVisitors).toBe(30);
      expect(result.returningVisitors).toBe(0);
      // No date predicate is applied to the base attendance filter.
      const attendanceCall = prisma.attendance.count.mock.calls[0][0];
      expect(attendanceCall?.where).not.toHaveProperty('checkin_at');
    });
  });

  describe('getMemberAnalytics', () => {
    const churchId = 'church-123';

    it.each([
      { hq: true, ownBranch: 'branch-a', requested: 'branch-b', expected: 'branch-b' },
      { hq: true, ownBranch: 'branch-a', requested: undefined, expected: undefined },
      { hq: false, ownBranch: 'branch-a', requested: 'branch-b', expected: 'branch-a' },
      {
        hq: false,
        ownBranch: undefined,
        requested: 'branch-b',
        expected: '00000000-0000-0000-0000-000000000000',
      },
    ])(
      'scopes every membership aggregate for $hq HQ, own=$ownBranch, requested=$requested',
      async ({ hq, ownBranch, requested, expected }) => {
        prisma.member.findMany.mockReset().mockResolvedValue([]);
        prisma.member.groupBy.mockReset().mockResolvedValue([]);
        await service.getMemberAnalytics(
          churchId,
          {
            church_id: churchId,
            role: 'church_admin',
            is_admin_hq: hq,
            branch_id: ownBranch,
          },
          { branchId: requested },
        );
        const where = { church_id: churchId, ...(expected ? { branch_id: expected } : {}) };
        expect(prisma.member.findMany).toHaveBeenCalledWith(expect.objectContaining({ where }));
        expect(prisma.member.groupBy).toHaveBeenCalledTimes(2);
        for (const [args] of prisma.member.groupBy.mock.calls) expect(args.where).toEqual(where);
      },
    );

    it('should return member demographics and growth', async () => {
      prisma.member.findMany
        .mockResolvedValueOnce([
          {
            id: 'm1',
            status: 'active',
            gender: 'male',
            date_of_birth: new Date('1990-01-01'),
            member_since: new Date('2025-01-15'),
          },
          {
            id: 'm2',
            status: 'active',
            gender: 'female',
            date_of_birth: new Date('1985-05-05'),
            member_since: new Date('2025-02-20'),
          },
        ]) // all members
        .mockResolvedValueOnce([
          { member_since: new Date('2025-01-15') },
          { member_since: new Date('2025-02-20') },
        ]); // growth
      prisma.member.groupBy
        .mockResolvedValueOnce([{ status: 'active', _count: { id: 2 } }]) // byStatus
        .mockResolvedValueOnce([
          { gender: 'male', _count: { id: 1 } },
          { gender: 'female', _count: { id: 1 } },
        ]); // byGender

      const result = await service.getMemberAnalytics(churchId);

      expect(result.total).toBe(2);
      expect(result.byStatus.active).toBe(2);
      expect(result.byGender.male).toBe(1);
      expect(result.byGender.female).toBe(1);
      expect(result.growth).toHaveLength(2);
    });
  });

  describe('getEventAnalytics', () => {
    const churchId = 'church-123';
    const query: AnalyticsDateRangeDto = { startDate: '2026-01-01', endDate: '2026-01-31' };

    it('should return event analytics', async () => {
      const mockEvent = {
        id: 'evt1',
        title: 'Conference',
        start_date: new Date('2026-01-15'),
        capacity: 100,
        is_free: false,
        registrations: [
          { id: 'reg1', ticket_id: 'tix1', payment_status: 'paid' },
          { id: 'reg2', ticket_id: 'tix2', payment_status: 'paid' },
        ],
        ticket_tiers: [{ id: 't1', name: 'VIP', price: 5000, capacity: 20 }],
      };
      prisma.event.findMany.mockResolvedValue([mockEvent]);
      prisma.event.count
        .mockResolvedValueOnce(0) // freeEvents
        .mockResolvedValueOnce(1); // paidEvents
      prisma.event.aggregate.mockResolvedValue({ _sum: { capacity: 100 } });
      prisma.eventRegistration.findMany.mockResolvedValue([
        { event_id: 'evt1', created_at: new Date() },
        { event_id: 'evt1', created_at: new Date() },
      ]);
      prisma.ticket.findMany.mockResolvedValue([
        { id: 'tix1', tier_name: 'VIP', price_paid: 5000, status: 'paid' },
        { id: 'tix2', tier_name: 'VIP', price_paid: 5000, status: 'paid' },
      ]);

      const result = await service.getEventAnalytics(churchId, query);

      expect(result.totalEvents).toBe(1);
      expect(result.totalRegistrations).toBe(2);
      expect(result.totalCapacity).toBe(100);
      expect(result.totalRevenue).toBe(10000);
      expect(result.paidEvents).toBe(1);
      expect(result.freeEvents).toBe(0);
      expect(result.events).toHaveLength(1);
      expect(result.tiers).toHaveLength(1);
    });
  });

  describe('getCommunicationAnalytics', () => {
    const churchId = 'church-123';
    const query: AnalyticsDateRangeDto = { startDate: '2026-01-01', endDate: '2026-01-31' };

    it('should return communication analytics', async () => {
      prisma.message.groupBy.mockResolvedValue([
        { channel: 'whatsapp', status: 'sent', _count: { id: 50 } },
        { channel: 'whatsapp', status: 'delivered', _count: { id: 45 } },
        { channel: 'whatsapp', status: 'read', _count: { id: 40 } },
        { channel: 'whatsapp', status: 'failed', _count: { id: 5 } },
        { channel: 'sms', status: 'sent', _count: { id: 10 } },
        { channel: 'sms', status: 'delivered', _count: { id: 9 } },
        { channel: 'sms', status: 'failed', _count: { id: 1 } },
      ]);
      prisma.broadcast.findMany.mockResolvedValue([
        { status: 'sent', total_recipients: 100 },
        { status: 'sent', total_recipients: 50 },
        { status: 'failed', total_recipients: 10 },
      ]);

      const result = await service.getCommunicationAnalytics(churchId, query);

      expect(result.channels).toHaveLength(2);
      const wa = result.channels.find((c) => c.channel === 'whatsapp')!;
      expect(wa.sent).toBe(50);
      expect(wa.delivered).toBe(45);
      expect(wa.read).toBe(40);
      expect(wa.failed).toBe(5);
      expect(wa.total).toBe(140);

      expect(result.broadcasts.total).toBe(3);
      expect(result.broadcasts.sent).toBe(2);
      expect(result.broadcasts.failed).toBe(1);
      expect(result.broadcasts.totalRecipients).toBe(160);
    });
  });
});
