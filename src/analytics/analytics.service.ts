/**
 * @file analytics.service.ts
 * @description Business logic for cross-domain analytics and reporting.
 *
 * Aggregates data from members, attendance, giving, events, assets, forms,
 * and communication into standardized analytics responses. All queries are
 * scoped by church_id for multi-tenant data isolation.
 *
 * @module analytics/analytics.service
 * @since 1.0.0
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BranchScopeService, ViewerScope } from '../common/services/branch-scope.service';
import { Prisma } from '@prisma/client';
import {
  AnalyticsDateRangeDto,
  AnalyticsTrendQueryDto,
  MemberAnalyticsQueryDto,
} from './dto/analytics-date-range.dto';
import {
  DashboardResponseDto,
  GivingAnalyticsResponseDto,
  AttendanceAnalyticsResponseDto,
  MemberAnalyticsResponseDto,
  EventAnalyticsResponseDto,
  CommunicationAnalyticsResponseDto,
  CategoryBreakdownDto,
  BranchBreakdownDto,
  TypeBreakdownDto,
  TopDonorDto,
  DatePointDto,
  ServiceBreakdownDto,
  EventSummaryDto,
  TierBreakdownDto,
  ChannelStatsDto,
  BroadcastSummaryDto,
} from './dto/analytics-response.dto';

/**
 * Service that computes analytics and reports across the platform.
 */
@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly branchScope: BranchScopeService,
  ) {
    this.logger.log('AnalyticsService initialized');
  }

  // ─── Helpers ────────────────────────────────────────────

  /**
   * Resolves an optional date range. When neither bound is supplied the range
   * is unbounded ("all time") — callers must then omit the date predicates
   * entirely so no accidental 30-day window is applied.
   */
  private getDateRange(query: AnalyticsDateRangeDto): {
    start?: Date;
    end?: Date;
  } {
    const start = query.startDate ? new Date(query.startDate) : undefined;
    const end = query.endDate ? new Date(query.endDate) : undefined;
    return { start, end };
  }

  /**
   * Builds an optional { gte, lte } date predicate for an ISO-8601 column.
   * Returns `undefined` when the range is unbounded (all time).
   */
  private dateRangeFilter(start?: Date, end?: Date): { gte?: Date; lte?: Date } | undefined {
    if (!start && !end) return undefined;
    return {
      ...(start ? { gte: start } : {}),
      ...(end ? { lte: end } : {}),
    };
  }

  /**
   * Formats a date for trend grouping.
   */
  private formatPeriod(date: Date, groupBy: 'day' | 'week' | 'month'): string {
    const iso = date.toISOString();
    if (groupBy === 'month') return iso.slice(0, 7);
    if (groupBy === 'week') {
      const d = new Date(date);
      d.setUTCDate(d.getUTCDate() - d.getUTCDay());
      return d.toISOString().slice(0, 10);
    }
    return iso.slice(0, 10);
  }

  /**
   * Computes age from a date of birth.
   */
  private calculateAge(dateOfBirth: Date): number {
    const today = new Date();
    let age = today.getFullYear() - dateOfBirth.getFullYear();
    const monthDiff = today.getMonth() - dateOfBirth.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dateOfBirth.getDate())) {
      age--;
    }
    return age;
  }

  // ─── Dashboard ──────────────────────────────────────────

  /**
   * Returns a unified dashboard overview for a church.
   */
  async getDashboard(
    churchId: string,
    query: AnalyticsDateRangeDto,
    viewer?: ViewerScope | null,
  ): Promise<DashboardResponseDto> {
    const { start, end } = this.getDateRange(query);
    const memberSinceFilter = this.dateRangeFilter(start, end);
    const attendanceFilter = this.dateRangeFilter(start, end);
    const givingFilter = this.dateRangeFilter(start, end);
    const upcomingEndFilter = end ? { lte: end } : undefined;

    const scope = this.branchScope.resolve(viewer);
    const memberWhere: Prisma.MemberWhereInput = {
      church_id: churchId,
      ...(scope.branchId ? { branch_id: scope.branchId } : {}),
    };
    const attendanceWhere: Prisma.AttendanceWhereInput = {
      church_id: churchId,
      ...(attendanceFilter ? { checkin_at: attendanceFilter } : {}),
      ...(scope.branchId ? { branch_id: scope.branchId } : {}),
    };
    const givingWhere: Prisma.TransactionWhereInput = {
      church_id: churchId,
      status: 'success',
      ...(givingFilter ? { giving_date: givingFilter } : {}),
      ...(scope.branchId ? { branch_id: scope.branchId } : {}),
    };
    const now = new Date();
    const eventWhere: Prisma.EventWhereInput = {
      church_id: churchId,
      // Upcoming = future starts + still-live recurring events (same rule as
      // the events list), so a weekly meeting counts even after its first date.
      AND: [
        {
          OR: [
            { start_date: { gte: now, ...(upcomingEndFilter ? upcomingEndFilter : {}) } },
            {
              recurrence: { in: ['weekly', 'multi_day'] },
              start_date: { lt: now },
              OR: [{ end_date: null }, { end_date: { gte: now } }],
            },
          ],
        },
      ],
      ...(scope.branchId ? { branch_id: scope.branchId } : {}),
    };

    // Keep aggregation reads serial to limit per-request Postgres connections.
    const totalMembers = await this.prisma.member.count({ where: memberWhere });
    const activeMembers = await this.prisma.member.count({
      where: { ...memberWhere, status: 'active' },
    });
    const newMembers = await this.prisma.member.count({
      where: {
        ...memberWhere,
        ...(memberSinceFilter ? { member_since: memberSinceFilter } : {}),
      },
    });
    const totalBranches = await this.prisma.branch.count({
      where: {
        church_id: churchId,
        ...(scope.branchId ? { id: scope.branchId } : {}),
      },
    });
    const totalAttendance = await this.prisma.attendance.count({ where: attendanceWhere });
    const givingAggregate = await this.prisma.transaction.aggregate({
      where: givingWhere,
      _sum: { amount: true },
    });
    const atRiskCount = await this.prisma.riskScore.count({
      where: {
        church_id: churchId,
        level: { in: ['high', 'critical'] },
        ...(scope.branchId ? { member: { branch_id: scope.branchId } } : {}),
      },
    });
    const upcomingEvents = await this.prisma.event.count({ where: eventWhere });
    const pendingSubmissions = await this.prisma.formSubmission.count({
      where: { church_id: churchId, status: 'pending' },
    });
    const engagementCounts = await this.getEngagementDistribution(churchId, scope.branchId);

    return {
      totalMembers,
      activeMembers,
      newMembers,
      totalBranches,
      totalAttendance,
      totalGiving: givingAggregate._sum.amount || 0,
      atRiskCount,
      upcomingEvents,
      pendingSubmissions,
      engagementDistribution: engagementCounts,
    };
  }

  /**
   * Buckets engagement scores into standard ranges.
   */
  private async getEngagementDistribution(
    churchId: string,
    branchId?: string,
  ): Promise<Record<string, number>> {
    const where = (score: { gte?: number; lt?: number }) =>
      ({
        church_id: churchId,
        score,
        ...(branchId ? { member: { branch_id: branchId } } : {}),
      }) as Prisma.EngagementScoreWhereInput;
    const highly = await this.prisma.engagementScore.count({ where: where({ gte: 80 }) });
    const moderately = await this.prisma.engagementScore.count({
      where: where({ gte: 50, lt: 80 }),
    });
    const low = await this.prisma.engagementScore.count({ where: where({ gte: 20, lt: 50 }) });
    const disengaged = await this.prisma.engagementScore.count({ where: where({ lt: 20 }) });

    return { highlyEngaged: highly, moderatelyEngaged: moderately, lowEngaged: low, disengaged };
  }

  // ─── Giving Analytics ───────────────────────────────────

  /**
   * Returns giving analytics for a church.
   */
  async getGivingAnalytics(
    churchId: string,
    query: AnalyticsTrendQueryDto,
    viewer?: ViewerScope | null,
  ): Promise<GivingAnalyticsResponseDto> {
    const { start, end } = this.getDateRange(query);
    const branchId = query.branchId;

    const createdFilter = this.dateRangeFilter(start, end);

    const scope = this.branchScope.resolve(viewer);
    const baseWhere: Prisma.TransactionWhereInput = {
      church_id: churchId,
      ...(query.currency ? { currency: query.currency } : {}),
      ...(createdFilter ? { giving_date: createdFilter } : {}),
    };

    if (branchId && scope.churchOnly) {
      baseWhere.branch_id = branchId;
    } else if (!scope.churchOnly && scope.branchId) {
      baseWhere.branch_id = scope.branchId;
    }

    const successWhere: Prisma.TransactionWhereInput = { ...baseWhere, status: 'success' };

    // Keep this aggregation serial. Fanning out eight independent Prisma
    // operations per page request can exhaust the limited Postgres session
    // pool when multiple users open analytics at once.
    const aggregate = await this.prisma.transaction.aggregate({
      where: successWhere,
      _sum: { amount: true },
      _count: { amount: true },
    });
    const byCategoryRaw = await this.prisma.transaction.groupBy({
      by: ['category_id'],
      where: successWhere,
      _sum: { amount: true },
      _count: { amount: true },
    });
    const byBranchRaw = await this.prisma.transaction.groupBy({
      by: ['branch_id'],
      where: successWhere,
      _sum: { amount: true },
      _count: { amount: true },
    });
    const byTypeRaw = await this.prisma.transaction.groupBy({
      by: ['type'],
      where: successWhere,
      _sum: { amount: true },
      _count: { amount: true },
    });
    const byStatusRaw = await this.prisma.transaction.groupBy({
      by: ['status'],
      where: baseWhere,
      _count: { id: true },
    });
    const topDonorsRaw = await this.prisma.transaction.groupBy({
      by: ['member_id'],
      where: { ...successWhere, member_id: { not: null } },
      _sum: { amount: true },
      _count: { amount: true },
      orderBy: { _sum: { amount: 'desc' } },
      take: 10,
    });
    const recurringBranchId = scope.churchOnly ? branchId : scope.branchId;
    const recurringPlans = await this.prisma.recurringGiving.findMany({
      where: {
        church_id: churchId,
        is_active: true,
        ...(query.currency ? { currency: query.currency } : {}),
        ...(recurringBranchId ? { member: { branch_id: recurringBranchId } } : {}),
      },
      select: { amount: true, frequency: true },
    });
    const transactions = await this.prisma.transaction.findMany({
      where: successWhere,
      select: { giving_date: true, amount: true },
      orderBy: { giving_date: 'asc' },
    });

    const categoryIds = byCategoryRaw.map((c) => c.category_id).filter(Boolean) as string[];
    const categories = categoryIds.length
      ? await this.prisma.givingCategory.findMany({
          where: { id: { in: categoryIds } },
          select: { id: true, name: true },
        })
      : [];
    const categoryMap = new Map(categories.map((c) => [c.id, c.name]));

    const branchIds = byBranchRaw.map((b) => b.branch_id).filter(Boolean) as string[];
    const branches = branchIds.length
      ? await this.prisma.branch.findMany({
          where: { id: { in: branchIds } },
          select: { id: true, name: true },
        })
      : [];
    const branchMap = new Map(branches.map((b) => [b.id, b.name]));

    const memberIds = topDonorsRaw.map((d) => d.member_id).filter(Boolean) as string[];
    const donors = memberIds.length
      ? await this.prisma.member.findMany({
          where: { id: { in: memberIds } },
          select: { id: true, first_name: true, last_name: true },
        })
      : [];
    const donorMap = new Map(donors.map((m) => [m.id, `${m.first_name} ${m.last_name}`]));

    const byCategory: CategoryBreakdownDto[] = byCategoryRaw.map((c) => ({
      categoryId: c.category_id || 'uncategorized',
      categoryName: c.category_id ? categoryMap.get(c.category_id) || 'Unknown' : 'Uncategorized',
      total: c._sum.amount || 0,
      count: c._count.amount,
    }));

    const byBranch: BranchBreakdownDto[] = byBranchRaw.map((b) => ({
      branchId: b.branch_id || undefined,
      branchName: b.branch_id ? branchMap.get(b.branch_id) || 'Unknown' : 'No branch',
      total: b._sum.amount || 0,
      count: b._count.amount,
    }));

    const byType: TypeBreakdownDto[] = byTypeRaw.map((t) => ({
      type: t.type,
      total: t._sum.amount || 0,
      count: t._count.amount,
    }));

    const byStatus: Record<string, number> = {};
    for (const s of byStatusRaw) {
      byStatus[s.status] = s._count.id;
    }

    const topDonors: TopDonorDto[] = topDonorsRaw.map((d) => ({
      memberId: d.member_id || '',
      memberName: d.member_id ? donorMap.get(d.member_id) || 'Unknown' : 'Anonymous',
      total: d._sum.amount || 0,
      count: d._count.amount,
    }));

    let totalMonthlyAmount = 0;
    for (const plan of recurringPlans) {
      const amount = plan.amount;
      if (plan.frequency === 'weekly') totalMonthlyAmount += amount * 4;
      else if (plan.frequency === 'quarterly') totalMonthlyAmount += amount / 3;
      else totalMonthlyAmount += amount;
    }

    const trend = this.buildTrend(transactions, query.groupBy || 'day');

    const total = aggregate._sum.amount || 0;
    const count = aggregate._count.amount;

    return {
      total,
      count,
      average: count > 0 ? total / count : 0,
      byCategory,
      byBranch,
      byType,
      byStatus,
      topDonors,
      recurring: {
        active: recurringPlans.length,
        totalMonthlyAmount,
        totalScheduled: recurringPlans.reduce((sum, p) => sum + p.amount, 0),
      },
      trend,
    };
  }

  // ─── Attendance Analytics ───────────────────────────────

  /**
   * Returns attendance analytics for a church.
   */
  async getAttendanceAnalytics(
    churchId: string,
    query: AnalyticsTrendQueryDto,
    viewer?: ViewerScope | null,
  ): Promise<AttendanceAnalyticsResponseDto> {
    const { start, end } = this.getDateRange(query);
    const branchId = query.branchId;

    const checkinFilter = this.dateRangeFilter(start, end);

    const scope = this.branchScope.resolve(viewer);
    const baseWhere: Prisma.AttendanceWhereInput = {
      church_id: churchId,
      ...(checkinFilter ? { checkin_at: checkinFilter } : {}),
    };

    if (branchId && scope.churchOnly) {
      baseWhere.service = { branch_id: branchId };
    } else if (!scope.churchOnly && scope.branchId) {
      baseWhere.service = { branch_id: scope.branchId };
    }

    const total = await this.prisma.attendance.count({ where: baseWhere });
    const members = await this.prisma.attendance.count({
      where: { ...baseWhere, member_id: { not: null } },
    });
    const visitors = await this.prisma.attendance.count({
      where: { ...baseWhere, member_id: null },
    });
    const bySourceRaw = await this.prisma.attendance.groupBy({
      by: ['source'],
      where: baseWhere,
      _count: { id: true },
    });
    const attendanceRecords = await this.prisma.attendance.findMany({
      where: baseWhere,
      select: {
        id: true,
        checkin_at: true,
        member_id: true,
        visitor_name: true,
        service: {
          select: { id: true, name: true, branch_id: true, branch: { select: { name: true } } },
        },
      },
      orderBy: { checkin_at: 'asc' },
    });

    const bySource: Record<string, number> = {};
    for (const s of bySourceRaw) {
      bySource[s.source] = s._count.id;
    }

    const branchMap = new Map<string, BranchBreakdownDto>();
    const serviceMap = new Map<string, ServiceBreakdownDto>();

    for (const record of attendanceRecords) {
      const service = record.service;
      if (service) {
        if (!serviceMap.has(service.id)) {
          serviceMap.set(service.id, {
            serviceId: service.id,
            serviceName: service.name,
            total: 0,
            members: 0,
            visitors: 0,
          });
        }
        const sEntry = serviceMap.get(service.id)!;
        sEntry.total++;
        if (record.member_id) sEntry.members++;
        else sEntry.visitors++;

        const branchKey = service.branch_id || 'none';
        const branchName = service.branch?.name || 'No branch';
        if (!branchMap.has(branchKey)) {
          branchMap.set(branchKey, {
            branchId: service.branch_id || undefined,
            branchName,
            total: 0,
            count: 0,
          });
        }
        const bEntry = branchMap.get(branchKey)!;
        bEntry.total++;
        bEntry.count++;
      }
    }

    const firstTimeVisitors = await this.getFirstTimeVisitorCount(churchId, start, end);
    const returningVisitors = visitors - firstTimeVisitors;

    const trend = this.buildAttendanceTrend(attendanceRecords, query.groupBy || 'day');

    return {
      total,
      members,
      visitors,
      bySource,
      byBranch: Array.from(branchMap.values()),
      byService: Array.from(serviceMap.values()),
      firstTimeVisitors,
      returningVisitors: returningVisitors >= 0 ? returningVisitors : 0,
      trend,
    };
  }

  /**
   * Counts visitors whose first check-in ever falls within the date range.
   * When the range is unbounded (all time) every visitor's first check-in
   * counts, so the earlier-occurrence check is skipped.
   */
  private async getFirstTimeVisitorCount(
    churchId: string,
    start?: Date,
    end?: Date,
  ): Promise<number> {
    if (!start && !end) {
      const result = await this.prisma.$queryRaw<{ count: number }[]>`
        SELECT COUNT(DISTINCT a.visitor_name) as count
        FROM attendance a
        WHERE a.church_id = ${churchId}
          AND a.member_id IS NULL
          AND a.visitor_name IS NOT NULL
      `;
      return Number(result[0]?.count || 0);
    }

    const result = await this.prisma.$queryRaw<{ count: number }[]>`
      SELECT COUNT(DISTINCT a.visitor_name) as count
      FROM attendance a
      WHERE a.church_id = ${churchId}
        AND a.member_id IS NULL
        AND a.visitor_name IS NOT NULL
        AND a.checkin_at BETWEEN ${start} AND ${end}
        AND NOT EXISTS (
          SELECT 1 FROM attendance a2
          WHERE a2.church_id = ${churchId}
            AND a2.member_id IS NULL
            AND a2.visitor_name = a.visitor_name
            AND a2.checkin_at < ${start}
        )
    `;
    return Number(result[0]?.count || 0);
  }

  // ─── Member Analytics ───────────────────────────────────

  /**
   * Returns member demographics and growth analytics.
   */
  async getMemberAnalytics(
    churchId: string,
    viewer?: ViewerScope | null,
    query: MemberAnalyticsQueryDto = {},
  ): Promise<MemberAnalyticsResponseDto> {
    const scope = this.branchScope.resolve(viewer);
    const branchId = scope.churchOnly ? query.branchId : scope.branchId;
    const where: Prisma.MemberWhereInput = {
      church_id: churchId,
      ...(branchId ? { branch_id: branchId } : {}),
    };
    const members = await this.prisma.member.findMany({
      where,
      select: { id: true, status: true, gender: true, date_of_birth: true, member_since: true },
    });
    const statusCounts = await this.prisma.member.groupBy({
      by: ['status'],
      where,
      _count: { id: true },
    });
    const genderCounts = await this.prisma.member.groupBy({
      by: ['gender'],
      where,
      _count: { id: true },
    });

    const total = members.length;

    const byStatus: Record<string, number> = {};
    for (const s of statusCounts) {
      byStatus[s.status] = s._count.id;
    }

    const byGender: Record<string, number> = {};
    for (const g of genderCounts) {
      byGender[g.gender || 'unspecified'] = g._count.id;
    }

    const byAgeGroup: Record<string, number> = {
      under_18: 0,
      age_18_30: 0,
      age_31_45: 0,
      age_46_60: 0,
      age_60_plus: 0,
      unspecified: 0,
    };

    for (const member of members) {
      if (!member.date_of_birth) {
        byAgeGroup.unspecified++;
        continue;
      }
      const age = this.calculateAge(member.date_of_birth);
      if (age < 18) byAgeGroup.under_18++;
      else if (age <= 30) byAgeGroup.age_18_30++;
      else if (age <= 45) byAgeGroup.age_31_45++;
      else if (age <= 60) byAgeGroup.age_46_60++;
      else byAgeGroup.age_60_plus++;
    }

    const growthMap = new Map<string, { total: number; new: number }>();
    for (const member of members) {
      const month = member.member_since.toISOString().slice(0, 7); // YYYY-MM
      if (!growthMap.has(month)) growthMap.set(month, { total: 0, new: 0 });
      growthMap.get(month)!.new++;
    }

    let cumulative = 0;
    const growth: DatePointDto[] = [];
    for (const [month, data] of Array.from(growthMap.entries()).sort((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      cumulative += data.new;
      growth.push({ date: month + '-01', total: cumulative, members: data.new, visitors: 0 });
    }

    return {
      total,
      byStatus,
      byGender,
      byAgeGroup,
      growth,
    };
  }

  // ─── Event Analytics ────────────────────────────────────

  /**
   * Returns event analytics for a church.
   */
  async getEventAnalytics(
    churchId: string,
    query: AnalyticsDateRangeDto,
    viewer?: ViewerScope | null,
  ): Promise<EventAnalyticsResponseDto> {
    const { start, end } = this.getDateRange(query);
    const startDateFilter = this.dateRangeFilter(start, end);

    const scope = this.branchScope.resolve(viewer);
    const eventWhere: Prisma.EventWhereInput = {
      church_id: churchId,
      ...(startDateFilter ? { start_date: startDateFilter } : {}),
      ...(scope.branchId ? { branch_id: scope.branchId } : {}),
    };

    const events = await this.prisma.event.findMany({
      where: eventWhere,
      include: {
        registrations: {
          select: {
            id: true,
            payment_status: true,
            ticket_id: true,
          },
        },
        ticket_tiers: {
          select: { id: true, name: true, price: true, capacity: true },
        },
      },
      orderBy: { start_date: 'asc' },
    });

    const tickets = await this.prisma.ticket.findMany({
      where: {
        event: eventWhere,
      },
      select: { id: true, tier_name: true, price_paid: true, status: true },
    });

    const ticketMap = new Map(tickets.map((t) => [t.id, t]));

    let totalEvents = 0;
    let totalRegistrations = 0;
    let totalCapacity = 0;
    let totalRevenue = 0;
    let freeEvents = 0;
    let paidEvents = 0;
    const eventsSummary: EventSummaryDto[] = [];
    const tierMap = new Map<string, TierBreakdownDto>();

    for (const event of events) {
      totalEvents++;
      const registrations = event.registrations.length;
      const capacity = event.capacity || 0;
      const revenue = event.registrations
        .filter((r) => r.ticket_id && ticketMap.get(r.ticket_id!)?.price_paid)
        .reduce((sum, r) => sum + (ticketMap.get(r.ticket_id!)!.price_paid || 0), 0);

      totalRegistrations += registrations;
      totalCapacity += capacity;
      totalRevenue += revenue;

      if (event.is_free) freeEvents++;
      else paidEvents++;

      eventsSummary.push({
        eventId: event.id,
        title: event.title,
        startDate: event.start_date.toISOString(),
        registrations,
        capacity: capacity || undefined,
        revenue,
        isFree: event.is_free,
      });

      for (const tier of event.ticket_tiers) {
        const tierName = tier.name;
        if (!tierMap.has(tierName)) {
          tierMap.set(tierName, {
            tierName,
            price: tier.price,
            sold: 0,
            revenue: 0,
            capacity: tier.capacity || undefined,
          });
        }
      }
    }

    for (const ticket of tickets) {
      if (
        ticket.tier_name &&
        tierMap.has(ticket.tier_name) &&
        ticket.status !== 'cancelled' &&
        ticket.status !== 'refunded'
      ) {
        const entry = tierMap.get(ticket.tier_name)!;
        entry.sold++;
        entry.revenue += ticket.price_paid || 0;
      }
    }

    return {
      totalEvents,
      totalRegistrations,
      totalCapacity,
      totalRevenue,
      freeEvents,
      paidEvents,
      events: eventsSummary,
      tiers: Array.from(tierMap.values()),
    };
  }

  // ─── Communication Analytics ────────────────────────────

  /**
   * Returns communication analytics for a church.
   */
  async getCommunicationAnalytics(
    churchId: string,
    query: AnalyticsDateRangeDto,
    viewer?: ViewerScope | null,
  ): Promise<CommunicationAnalyticsResponseDto> {
    const { start, end } = this.getDateRange(query);
    const createdFilter = this.dateRangeFilter(start, end);

    const scope = this.branchScope.resolve(viewer);
    const messageWhere: Prisma.MessageWhereInput = {
      church_id: churchId,
      ...(createdFilter ? { created_at: createdFilter } : {}),
      ...(scope.branchId ? { member: { branch_id: scope.branchId } } : {}),
    };
    const broadcastWhere = {
      church_id: churchId,
      ...(createdFilter ? { created_at: createdFilter } : {}),
    };

    const messageStats = await this.prisma.message.groupBy({
      by: ['channel', 'status'],
      where: messageWhere,
      _count: { id: true },
    });
    const broadcasts = await this.prisma.broadcast.findMany({
      where: broadcastWhere,
      select: { status: true, total_recipients: true },
    });

    const channelMap = new Map<string, ChannelStatsDto>();

    for (const stat of messageStats) {
      if (!channelMap.has(stat.channel)) {
        channelMap.set(stat.channel, {
          channel: stat.channel,
          sent: 0,
          delivered: 0,
          read: 0,
          failed: 0,
          total: 0,
        });
      }
      const entry = channelMap.get(stat.channel)!;
      const count = stat._count.id;
      entry.total += count;
      if (stat.status === 'sent') entry.sent += count;
      else if (stat.status === 'delivered') entry.delivered += count;
      else if (stat.status === 'read') entry.read += count;
      else if (stat.status === 'failed') entry.failed += count;
      else entry.sent += count;
    }

    const broadcastSummary: BroadcastSummaryDto = {
      total: broadcasts.length,
      sent: broadcasts.filter((b) => b.status === 'sent').length,
      failed: broadcasts.filter((b) => b.status === 'failed').length,
      totalRecipients: broadcasts.reduce((sum, b) => sum + (b.total_recipients || 0), 0),
    };

    return {
      channels: Array.from(channelMap.values()),
      broadcasts: broadcastSummary,
    };
  }

  // ─── Trend Builders ─────────────────────────────────────

  /**
   * Builds a trend from numeric records with a date field.
   */
  private buildTrend(
    records: { giving_date: Date; amount: number }[],
    groupBy: 'day' | 'week' | 'month',
  ): DatePointDto[] {
    const map = new Map<string, DatePointDto>();
    for (const record of records) {
      const period = this.formatPeriod(record.giving_date, groupBy);
      if (!map.has(period)) {
        map.set(period, { date: period, total: 0, members: 0, visitors: 0 });
      }
      const point = map.get(period)!;
      point.total += record.amount;
    }
    return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
  }

  /**
   * Builds an attendance trend from attendance records.
   */
  private buildAttendanceTrend(
    records: { checkin_at: Date; member_id: string | null }[],
    groupBy: 'day' | 'week' | 'month',
  ): DatePointDto[] {
    const map = new Map<string, DatePointDto>();
    for (const record of records) {
      const period = this.formatPeriod(record.checkin_at, groupBy);
      if (!map.has(period)) {
        map.set(period, { date: period, total: 0, members: 0, visitors: 0 });
      }
      const point = map.get(period)!;
      point.total++;
      if (record.member_id) point.members++;
      else point.visitors++;
    }
    return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
  }
}
