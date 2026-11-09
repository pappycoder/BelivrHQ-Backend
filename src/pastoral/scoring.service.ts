import { RequestContextService } from '../common/services/request-context.service';
/**
 * @file scoring.service.ts
 * @description Service for calculating member engagement and risk scores.
 *
 * Engagement Score (0-100): Measures how actively a member participates.
 * Factors: attendance frequency, giving activity, event participation,
 * communication engagement (WhatsApp messages).
 *
 * Risk Score (0-100): Measures likelihood of member disengagement.
 * Factors: declining attendance, no giving activity, no communication,
 * inactive status, age of last activity.
 *
 * Both scores are recalculated nightly via the BullMQ nightly-jobs queue.
 * Results are stored in the engagement_scores and risk_scores tables.
 *
 * @module pastoral/scoring.service
 * @since 1.0.0
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Prisma } from '@prisma/client';
import { ListRiskScoresDto } from './dto/list-risk-scores.dto';
import { ListEngagementScoresDto } from './dto/list-engagement-scores.dto';
import { RiskScoreResponseDto } from './dto/risk-score-response.dto';
import { EngagementScoreResponseDto } from './dto/engagement-score-response.dto';

/**
 * Weight configuration for engagement score factors.
 */
const ENGAGEMENT_WEIGHTS = {
  attendance: 30,
  giving: 25,
  events: 20,
  communication: 15,
  consistency: 10,
};

/**
 * Weight configuration for risk score factors.
 * Higher risk score = more at risk of leaving.
 */
const RISK_WEIGHTS = {
  attendanceDecline: 25,
  noGiving: 20,
  noCommunication: 20,
  inactiveStatus: 15,
  recentInactivity: 20,
};

/**
 * Number of weeks to look back for scoring calculations.
 */
const LOOKBACK_WEEKS = 12;

@Injectable()
export class ScoringService {
  // Initialize the logger for this service
  private readonly logger = new Logger(ScoringService.name);

  constructor(
    // Inject PrismaService for database access
    private readonly prisma: PrismaService,
    private readonly requestContext: RequestContextService,
    // Inject NotificationsService for risk alerts
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Calculates engagement scores for all active members in a church.
   *
   * @param churchId - Church ID to scope calculations
   * @returns Number of members scored
   */
  async calculateEngagementScores(churchId: string): Promise<number> {
    // Compute the lookback cutoff date (12 weeks ago)
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - LOOKBACK_WEEKS * 7);

    // Fetch all active members for the church
    const members = await this.prisma.member.findMany({
      where: {
        church_id: churchId,
        ...this.requestContext.branchWhere(churchId),
        status: 'active',
      },
      select: { id: true, first_name: true, last_name: true },
    });

    // Initialize the scored counter
    let scored = 0;

    // Iterate over each member to calculate their engagement score
    for (const member of members) {
      try {
        // Calculate individual engagement factor values for the member
        const factors = await this.calculateEngagementFactors(member.id, churchId, cutoffDate);

        // Compute the weighted engagement score from factors
        const score = this.computeWeightedScore(factors, ENGAGEMENT_WEIGHTS);

        // Upsert the engagement score record (update or create)
        await this.prisma.engagementScore.upsert({
          where: { member_id: member.id },
          update: {
            score,
            factors: factors as unknown as Prisma.InputJsonValue,
            calculated_at: new Date(),
          },
          create: {
            church_id: churchId,
            member_id: member.id,
            score,
            factors: factors as unknown as Prisma.InputJsonValue,
          },
        });

        // Increment the scored counter
        scored++;
      } catch (error) {
        // Log errors but continue processing other members
        this.logger.error(`Failed to calculate engagement for ${member.id}: ${error}`);
      }
    }

    // Log the total number of members scored and return the count
    this.logger.log(`Engagement scores calculated for ${scored} members in church ${churchId}`);
    return scored;
  }

  /**
   * Calculates risk scores for all active members in a church.
   *
   * @param churchId - Church ID to scope calculations
   * @returns Number of members scored
   */
  async calculateRiskScores(churchId: string): Promise<number> {
    // Compute the lookback cutoff date (12 weeks ago)
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - LOOKBACK_WEEKS * 7);

    // Fetch all members for the church (including inactive)
    const members = await this.prisma.member.findMany({
      where: { church_id: churchId, ...this.requestContext.branchWhere(churchId) },
      select: { id: true, status: true },
    });

    // Initialize the scored counter
    let scored = 0;

    // Iterate over each member to calculate their risk score
    for (const member of members) {
      try {
        // Calculate individual risk factor values for the member
        const factors = await this.calculateRiskFactors(
          member.id,
          churchId,
          member.status,
          cutoffDate,
        );

        // Compute the weighted risk score from factors
        const score = this.computeWeightedScore(factors, RISK_WEIGHTS);
        // Map the numeric score to a risk level label
        const level = this.getRiskLevel(score);

        // Upsert the risk score record (update or create)
        await this.prisma.riskScore.upsert({
          where: { member_id: member.id },
          update: {
            score,
            level,
            factors: factors as unknown as Prisma.InputJsonValue,
            calculated_at: new Date(),
          },
          create: {
            church_id: churchId,
            member_id: member.id,
            score,
            level,
            factors: factors as unknown as Prisma.InputJsonValue,
          },
        });

        // Increment the scored counter
        scored++;
      } catch (error) {
        // Log errors but continue processing other members
        this.logger.error(`Failed to calculate risk for ${member.id}: ${error}`);
      }
    }

    // Log the total number of members scored and return the count
    this.logger.log(`Risk scores calculated for ${scored} members in church ${churchId}`);

    const highRiskMembers = await this.prisma.riskScore.findMany({
      where: {
        church_id: churchId,
        member: this.requestContext.branchWhere(churchId),
        level: { in: ['high', 'critical'] },
      },
      include: { member: { select: { id: true, first_name: true, last_name: true } } },
    });

    if (highRiskMembers.length > 0) {
      const adminProfiles = await this.prisma.profile.findMany({
        where: { church_id: churchId, role: { hasSome: ['church_admin', 'senior_pastor'] } },
      });
      for (const admin of adminProfiles) {
        await this.notifications
          .createNotification(
            churchId,
            admin.id,
            'risk',
            'Pastoral Attention Needed',
            `${highRiskMembers.length} member(s) have been flagged as high risk and may need pastoral follow-up.`,
            { highRiskCount: highRiskMembers.length },
          )
          .catch((err) => this.logger.warn(`Risk notification failed: ${(err as Error).message}`));
      }
    }

    return scored;
  }

  /**
   * Gets members who need pastoral attention (high/critical risk).
   *
   * @param churchId - Church ID
   * @param limit - Max results
   * @returns Members with risk scores
   */
  async getMembersNeedingAttention(churchId: string, limit = 20) {
    // Query risk scores filtered to high/critical levels, ordered by highest score first
    return this.prisma.riskScore.findMany({
      where: {
        church_id: churchId,
        member: this.requestContext.branchWhere(churchId),
        level: { in: ['high', 'critical'] },
      },
      include: {
        member: {
          select: {
            id: true,
            first_name: true,
            last_name: true,
            email: true,
            phone: true,
            status: true,
          },
        },
      },
      orderBy: { score: 'desc' },
      take: limit,
    });
  }

  /**
   * Gets engagement distribution across the church.
   *
   * @param churchId - Church ID
   * @returns Distribution counts by engagement level
   */
  async getEngagementDistribution(churchId: string): Promise<{
    highly_engaged: number;
    moderately_engaged: number;
    low_engagement: number;
    disengaged: number;
  }> {
    // Keep the dashboard aggregate queries serial to limit pool usage.
    const highlyEngaged = await this.prisma.engagementScore.count({
      where: {
        church_id: churchId,
        member: this.requestContext.branchWhere(churchId),
        score: { gte: 70 },
      },
    });
    const moderatelyEngaged = await this.prisma.engagementScore.count({
      where: {
        church_id: churchId,
        member: this.requestContext.branchWhere(churchId),
        score: { gte: 40, lt: 70 },
      },
    });
    const lowEngagement = await this.prisma.engagementScore.count({
      where: {
        church_id: churchId,
        member: this.requestContext.branchWhere(churchId),
        score: { gte: 20, lt: 40 },
      },
    });
    const disengaged = await this.prisma.engagementScore.count({
      where: {
        church_id: churchId,
        member: this.requestContext.branchWhere(churchId),
        score: { lt: 20 },
      },
    });

    // Return the distribution as a structured object
    return {
      highly_engaged: highlyEngaged,
      moderately_engaged: moderatelyEngaged,
      low_engagement: lowEngagement,
      disengaged: disengaged,
    };
  }

  /**
   * Gets "rising stars" — members with rapidly improving engagement.
   *
   * @param churchId - Church ID
   * @param limit - Max results
   * @returns Top engaging members
   */
  async getRisingStars(churchId: string, limit = 10) {
    // Query high-scoring engagement records ordered by score descending
    return this.prisma.engagementScore.findMany({
      where: {
        church_id: churchId,
        member: this.requestContext.branchWhere(churchId),
        score: { gte: 50 },
      },
      include: {
        member: {
          select: {
            id: true,
            first_name: true,
            last_name: true,
            email: true,
          },
        },
      },
      orderBy: { score: 'desc' },
      take: limit,
    });
  }

  // ─── Private: Engagement Factor Calculations ───────────────

  /**
   * Calculates individual engagement factor values for a member.
   *
   * @param memberId - Member ID
   * @param churchId - Church ID
   * @param cutoffDate - Start of lookback period
   * @returns Factor values (0-1 each)
   */
  private async calculateEngagementFactors(
    memberId: string,
    _churchId: string,
    cutoffDate: Date,
  ): Promise<Record<string, number>> {
    // Read member activity serially so scoring does not fan out connections.
    const attendanceCount = await this.prisma.attendance.count({
      where: { member_id: memberId, checkin_at: { gte: cutoffDate } },
    });
    const givingCount = await this.prisma.transaction.count({
      where: { member_id: memberId, status: 'success', created_at: { gte: cutoffDate } },
    });
    const givingTotal = await this.prisma.transaction.aggregate({
      where: { member_id: memberId, status: 'success', created_at: { gte: cutoffDate } },
      _sum: { amount: true },
    });
    const eventCount = await this.prisma.eventRegistration.count({
      where: { member_id: memberId, created_at: { gte: cutoffDate } },
    });
    const messageCount = await this.prisma.message.count({
      where: { member_id: memberId, direction: 'outbound', created_at: { gte: cutoffDate } },
    });

    // Compute the total number of weeks in the lookback window
    const totalWeeks = LOOKBACK_WEEKS;

    // Normalize each raw count to a 0-1 factor value
    return {
      // Attendance: check-ins per expected services (0.5 services/week × 12 weeks = 6)
      attendance: Math.min(attendanceCount / (totalWeeks * 0.5), 1),
      // Giving: weighted by frequency (0.2 per tx) and total amount (÷ 500k)
      giving: Math.min(givingCount * 0.2 + (givingTotal._sum.amount || 0) / 500000, 1),
      // Events: register for up to 5 events in the period
      events: Math.min(eventCount / 5, 1),
      // Communication: up to 10 outbound messages
      communication: Math.min(messageCount / 10, 1),
      // Consistency: attendance relative to 70% of possible services
      consistency: Math.min(attendanceCount / (totalWeeks * 0.7), 1),
    };
  }

  // ─── Private: Risk Factor Calculations ─────────────────────

  /**
   * Calculates individual risk factor values for a member.
   *
   * @param memberId - Member ID
   * @param churchId - Church ID
   * @param memberStatus - Member status
   * @param cutoffDate - Start of lookback period
   * @returns Factor values (0-1 each, higher = more risk)
   */
  private async calculateRiskFactors(
    memberId: string,
    _churchId: string,
    memberStatus: string,
    cutoffDate: Date,
  ): Promise<Record<string, number>> {
    // Keep member risk reads serial to limit concurrent database connections.
    const recentAttendance = await this.prisma.attendance.count({
      where: { member_id: memberId, checkin_at: { gte: cutoffDate } },
    });
    const recentGiving = await this.prisma.transaction.count({
      where: { member_id: memberId, status: 'success', created_at: { gte: cutoffDate } },
    });
    const recentMessages = await this.prisma.message.count({
      where: { member_id: memberId, created_at: { gte: cutoffDate } },
    });
    const lastActivity = await this.prisma.attendance.findFirst({
      where: { member_id: memberId },
      orderBy: { checkin_at: 'desc' },
      select: { checkin_at: true },
    });

    // Compute the total number of weeks in the lookback window
    const totalWeeks = LOOKBACK_WEEKS;

    // Calculate weeks since last attendance, capped at totalWeeks
    const weeksSinceLastActivity = lastActivity
      ? Math.min(
          (Date.now() - lastActivity.checkin_at.getTime()) / (7 * 24 * 60 * 60 * 1000),
          totalWeeks,
        )
      : totalWeeks;

    // Compute risk factors (higher value = more risk)
    return {
      // Attendance decline: inverse of recent attendance ratio
      attendanceDecline: Math.max(1 - recentAttendance / (totalWeeks * 0.5), 0),
      // No giving: binary risk factor (1 if zero giving, 0 otherwise)
      noGiving: recentGiving === 0 ? 1 : 0,
      // No communication: binary risk factor
      noCommunication: recentMessages === 0 ? 1 : 0,
      // Inactive status: binary risk factor (1 if not active)
      inactiveStatus: memberStatus !== 'active' ? 1 : 0,
      // Recent inactivity: fraction of lookback period since last activity
      recentInactivity: weeksSinceLastActivity / totalWeeks,
    };
  }

  // ─── Private: Helpers ──────────────────────────────────────

  /**
   * Computes a weighted score from factors and weights.
   *
   * @param factors - Factor values (0-1)
   * @param weights - Weight percentages (must sum to 100)
   * @returns Score 0-100
   */
  private computeWeightedScore(
    factors: Record<string, number>,
    weights: Record<string, number>,
  ): number {
    // Initialize accumulators for weighted sum and total weight
    let totalWeight = 0;
    let weightedSum = 0;

    // Iterate over each weight factor and accumulate weighted values
    for (const [key, weight] of Object.entries(weights)) {
      const factor = factors[key] || 0;
      weightedSum += factor * weight;
      totalWeight += weight;
    }

    // Normalize by total weight and scale to 0-100, rounded to integer
    return Math.round((weightedSum / totalWeight) * 100);
  }

  /**
   * Generates actionable follow-up suggestions for a member based on
   * their risk score factors.
   *
   * Analyzes the detailed risk factors to produce human-readable
   * suggestions that pastoral staff can act on.
   *
   * @param memberId - Member ID
   * @param churchId - Church ID
   * @returns Array of suggestion strings or empty array if member not found
   */
  async getFollowUpSuggestions(
    memberId: string,
    churchId: string,
  ): Promise<{ riskScore: number; riskLevel: string; suggestions: string[] }> {
    const riskScore = await this.prisma.riskScore.findUnique({
      where: { member_id: memberId, member: this.requestContext.branchWhere(churchId) },
    });

    if (!riskScore || riskScore.church_id !== churchId) {
      return { riskScore: 0, riskLevel: 'unknown', suggestions: [] };
    }

    const factors = riskScore.factors as Record<string, number>;
    const suggestions: string[] = [];

    // Analyze attendance decline
    if (factors.attendanceDecline && factors.attendanceDecline > 0.5) {
      if (factors.attendanceDecline > 0.8) {
        suggestions.push(
          '🔴 Severe attendance decline: member has missed most services in recent weeks. Schedule a personal check-in call or visit.',
        );
      } else {
        suggestions.push(
          '🟡 Irregular attendance: member has missed several services. Send a friendly WhatsApp check-in message.',
        );
      }
    }

    // Analyze giving
    if (factors.noGiving && factors.noGiving > 0) {
      suggestions.push(
        '💰 No recent giving activity: gently remind about giving options and check if there are any financial concerns.',
      );
    }

    // Analyze communication
    if (factors.noCommunication && factors.noCommunication > 0) {
      suggestions.push(
        '📱 No recent communication engagement: consider reaching out via phone call or personalized message.',
      );
    }

    // Analyze membership status
    if (factors.inactiveStatus && factors.inactiveStatus > 0) {
      suggestions.push(
        '📋 Member status is inactive: discuss re-engagement and update membership status if needed.',
      );
    }

    // Analyze recent inactivity
    if (factors.recentInactivity && factors.recentInactivity > 0.4) {
      if (factors.recentInactivity > 0.7) {
        suggestions.push(
          '⏰ Member has been absent for an extended period: assign a follow-up team member for personal outreach.',
        );
      } else {
        suggestions.push(
          "👋 Member hasn't attended recently: send an invitation to the next upcoming service or event.",
        );
      }
    }

    // Add escalation suggestion for high/critical risk
    if (riskScore.level === 'high' || riskScore.level === 'critical') {
      suggestions.push(
        '🚨 Escalate to senior pastor for personal pastoral visit. This member requires immediate attention.',
      );
    }

    // If no specific suggestions, provide a general positive note
    if (suggestions.length === 0) {
      suggestions.push(
        '✅ No immediate concerns. Continue regular check-ins and maintain connection.',
      );
    }

    return {
      riskScore: riskScore.score,
      riskLevel: riskScore.level,
      suggestions,
    };
  }

  /**
   * Gets follow-up suggestions for all high/critical risk members.
   *
   * @param churchId - Church ID
   * @param limit - Max members to return
   * @returns Members with their risk scores and suggestions
   */
  async getBatchFollowUpSuggestions(
    churchId: string,
    limit = 20,
  ): Promise<
    {
      memberId: string;
      memberName: string;
      riskScore: number;
      riskLevel: string;
      suggestions: string[];
    }[]
  > {
    const atRiskMembers = await this.getMembersNeedingAttention(churchId, limit);

    const results: {
      memberId: string;
      memberName: string;
      riskScore: number;
      riskLevel: string;
      suggestions: string[];
    }[] = [];

    for (const risk of atRiskMembers) {
      const suggestions = await this.getFollowUpSuggestions(risk.member.id, churchId);
      results.push({
        memberId: risk.member.id,
        memberName: `${risk.member.first_name} ${risk.member.last_name}`,
        riskScore: risk.score,
        riskLevel: risk.level,
        suggestions: suggestions.suggestions,
      });
    }

    return results;
  }

  // ─── Public: Score Listing & Detail ───────────────────────

  /**
   * Engagement bucket definitions keyed by bucket name.
   */
  private static readonly ENGAGEMENT_BUCKETS: Record<string, { gte?: number; lt?: number }> = {
    highly_engaged: { gte: 70 },
    moderately_engaged: { gte: 40, lt: 70 },
    low_engagement: { gte: 20, lt: 40 },
    disengaged: { lt: 20 },
  };

  /**
   * Lists risk scores across all members with pagination.
   *
   * @param churchId - Church ID to scope queries
   * @param query - List/filter/sort DTO
   * @returns Paginated risk scores with member details
   */
  async listRiskScores(
    churchId: string,
    query: ListRiskScoresDto,
  ): Promise<{
    data: RiskScoreResponseDto[];
    meta: { total: number; page: number; limit: number; totalPages: number };
  }> {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    const where: Prisma.RiskScoreWhereInput = {
      church_id: churchId,
      AND: [{ member: this.requestContext.branchWhere(churchId) }],
    };

    if (query.level) {
      where.level = query.level;
    }

    if (query.search?.trim()) {
      const term = query.search.trim();
      where.member = {
        OR: [
          { first_name: { contains: term, mode: 'insensitive' } },
          { last_name: { contains: term, mode: 'insensitive' } },
        ],
      };
    }

    const orderBy: Prisma.RiskScoreOrderByWithRelationInput[] = [];
    const fieldMap: Record<string, Prisma.RiskScoreScalarFieldEnum> = {
      score: 'score',
      calculated_at: 'calculated_at',
    };
    if (query.sortBy && fieldMap[query.sortBy]) {
      orderBy.push({ [fieldMap[query.sortBy]]: query.sortOrder || 'desc' });
    } else {
      orderBy.push({ score: 'desc' });
    }

    const riskScores = await this.prisma.riskScore.findMany({
      where,
      include: {
        member: {
          select: {
            id: true,
            first_name: true,
            last_name: true,
            email: true,
            phone: true,
            status: true,
          },
        },
      },
      orderBy,
      skip,
      take: limit,
    });
    const total = await this.prisma.riskScore.count({ where });

    const data: RiskScoreResponseDto[] = riskScores.map((row) => ({
      id: row.id,
      churchId: row.church_id,
      memberId: row.member.id,
      memberFirstName: row.member.first_name,
      memberLastName: row.member.last_name,
      memberEmail: row.member.email || undefined,
      memberPhone: row.member.phone || undefined,
      memberStatus: row.member.status,
      score: row.score,
      level: row.level,
      factors: row.factors as Record<string, number>,
      calculatedAt: row.calculated_at.toISOString(),
    }));

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Lists engagement scores across all members with pagination.
   *
   * @param churchId - Church ID to scope queries
   * @param query - List/filter/sort DTO
   * @returns Paginated engagement scores with member details
   */
  async listEngagementScores(
    churchId: string,
    query: ListEngagementScoresDto,
  ): Promise<{
    data: EngagementScoreResponseDto[];
    meta: { total: number; page: number; limit: number; totalPages: number };
  }> {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    const where: Prisma.EngagementScoreWhereInput = {
      church_id: churchId,
      AND: [{ member: this.requestContext.branchWhere(churchId) }],
    };

    if (query.bucket) {
      where.score = ScoringService.ENGAGEMENT_BUCKETS[query.bucket];
    }

    if (query.search?.trim()) {
      const term = query.search.trim();
      where.member = {
        OR: [
          { first_name: { contains: term, mode: 'insensitive' } },
          { last_name: { contains: term, mode: 'insensitive' } },
        ],
      };
    }

    const orderBy: Prisma.EngagementScoreOrderByWithRelationInput[] = [];
    const fieldMap: Record<string, Prisma.EngagementScoreScalarFieldEnum> = {
      score: 'score',
      calculated_at: 'calculated_at',
    };
    if (query.sortBy && fieldMap[query.sortBy]) {
      orderBy.push({ [fieldMap[query.sortBy]]: query.sortOrder || 'desc' });
    } else {
      orderBy.push({ score: 'desc' });
    }

    const engagementScores = await this.prisma.engagementScore.findMany({
      where,
      include: {
        member: {
          select: {
            id: true,
            first_name: true,
            last_name: true,
            email: true,
          },
        },
      },
      orderBy,
      skip,
      take: limit,
    });
    const total = await this.prisma.engagementScore.count({ where });

    const data: EngagementScoreResponseDto[] = engagementScores.map((row) => ({
      id: row.id,
      churchId: row.church_id,
      memberId: row.member.id,
      memberFirstName: row.member.first_name,
      memberLastName: row.member.last_name,
      memberEmail: row.member.email || undefined,
      score: row.score,
      factors: row.factors as Record<string, number>,
      calculatedAt: row.calculated_at.toISOString(),
    }));

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Gets a member's combined risk + engagement scores with follow-up suggestions.
   *
   * @param memberId - Member ID
   * @param churchId - Church ID for scoping
   * @returns Risk, engagement, and follow-up suggestion data
   * @throws NotFoundException if the member is not in this church
   */
  async getMemberScoring(
    memberId: string,
    churchId: string,
  ): Promise<{
    risk: {
      score: number;
      level: string;
      factors: Record<string, number>;
      calculatedAt: string;
    } | null;
    engagement: {
      score: number;
      factors: Record<string, number>;
      calculatedAt: string;
    } | null;
    suggestions: string[];
  }> {
    // Verify the member exists and belongs to this church
    const member = await this.prisma.member.findFirst({
      where: { id: memberId, church_id: churchId, ...this.requestContext.branchWhere(churchId) },
      select: { id: true },
    });

    if (!member) {
      throw new NotFoundException('Member not found in this church');
    }

    const riskScore = await this.prisma.riskScore.findUnique({ where: { member_id: memberId } });
    const engagementScore = await this.prisma.engagementScore.findUnique({
      where: { member_id: memberId },
    });

    const risk =
      riskScore && riskScore.church_id === churchId
        ? {
            score: riskScore.score,
            level: riskScore.level,
            factors: riskScore.factors as Record<string, number>,
            calculatedAt: riskScore.calculated_at.toISOString(),
          }
        : null;

    const engagement =
      engagementScore && engagementScore.church_id === churchId
        ? {
            score: engagementScore.score,
            factors: engagementScore.factors as Record<string, number>,
            calculatedAt: engagementScore.calculated_at.toISOString(),
          }
        : null;

    let suggestions: string[] = [];
    if (risk) {
      suggestions = (await this.getFollowUpSuggestions(memberId, churchId)).suggestions;
    }

    return { risk, engagement, suggestions };
  }

  /**
   * Maps a numeric risk score to a RiskLevel enum value.
   *
   * @param score - Risk score (0-100)
   * @returns Risk level
   */
  private getRiskLevel(score: number): 'low' | 'medium' | 'high' | 'critical' {
    // Map score ranges to discrete risk levels
    if (score >= 75) return 'critical';
    if (score >= 50) return 'high';
    if (score >= 25) return 'medium';
    return 'low';
  }
}
