import { Test, TestingModule } from '@nestjs/testing';
import { RequestContextService } from '../../../src/common/services/request-context.service';
import { ScoringService } from '../../../src/pastoral/scoring.service';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { NotificationsService } from '../../../src/notifications/notifications.service';
import { createPrismaMock } from '../../helpers/prisma-mock.helper';

describe('ScoringService', () => {
  let service: ScoringService;
  let prisma: ReturnType<typeof createPrismaMock>;

  const mockChurchId = 'church-1';
  const mockMemberId = 'member-1';

  beforeEach(async () => {
    prisma = createPrismaMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RequestContextService,
        ScoringService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: NotificationsService,
          useValue: {
            createNotification: jest.fn().mockResolvedValue({}),
            broadcastToChurch: jest.fn().mockResolvedValue({ sent: 0 }),
          },
        },
      ],
    }).compile();

    service = module.get<ScoringService>(ScoringService);
  });

  describe('calculateEngagementScores', () => {
    it('should calculate engagement scores for all active members', async () => {
      prisma.member.findMany.mockResolvedValue([
        { id: mockMemberId, first_name: 'John', last_name: 'Doe' },
      ]);

      prisma.attendance.count.mockResolvedValue(6);
      prisma.transaction.count.mockResolvedValue(2);
      prisma.transaction.aggregate.mockResolvedValue({ _sum: { amount: 50000 } });
      prisma.eventRegistration.count.mockResolvedValue(2);
      prisma.message.count.mockResolvedValue(5);

      (prisma.engagementScore.upsert as jest.Mock).mockResolvedValue({ id: 'es-1', score: 65 });

      const result = await service.calculateEngagementScores(mockChurchId);

      expect(result).toBe(1);
      expect(prisma.engagementScore.upsert).toHaveBeenCalled();
    });

    it('should handle zero active members', async () => {
      prisma.member.findMany.mockResolvedValue([]);

      const result = await service.calculateEngagementScores(mockChurchId);

      expect(result).toBe(0);
    });
  });

  describe('calculateRiskScores', () => {
    it('should calculate risk scores for all members', async () => {
      prisma.member.findMany.mockResolvedValue([{ id: mockMemberId, status: 'active' }]);

      prisma.attendance.count.mockResolvedValue(10);
      prisma.transaction.count.mockResolvedValue(3);
      prisma.message.count.mockResolvedValue(8);
      prisma.attendance.findFirst.mockResolvedValue({
        checkin_at: new Date(),
      });

      (prisma.riskScore.upsert as jest.Mock).mockResolvedValue({
        id: 'rs-1',
        score: 75,
        level: 'high',
      });
      prisma.riskScore.findMany.mockResolvedValue([
        {
          member_id: mockMemberId,
          level: 'high',
          member: { id: mockMemberId, first_name: 'John', last_name: 'Doe' },
        },
      ]);
      prisma.profile.findMany.mockResolvedValue([]);

      const result = await service.calculateRiskScores(mockChurchId);

      expect(result).toBe(1);
      expect(prisma.riskScore.upsert).toHaveBeenCalled();
    });
  });

  describe('getMembersNeedingAttention', () => {
    it('should return members with high/critical risk', async () => {
      prisma.riskScore.findMany.mockResolvedValue([
        {
          score: 85,
          level: 'critical',
          member: { id: mockMemberId, first_name: 'John', last_name: 'Doe' },
        },
      ]);

      const result = await service.getMembersNeedingAttention(mockChurchId);

      expect(result).toHaveLength(1);
      expect(result[0].level).toBe('critical');
    });
  });

  describe('getEngagementDistribution', () => {
    it('should return engagement distribution counts', async () => {
      prisma.engagementScore.count
        .mockResolvedValueOnce(10) // highly_engaged
        .mockResolvedValueOnce(20) // moderately_engaged
        .mockResolvedValueOnce(5) // low_engagement
        .mockResolvedValueOnce(2); // disengaged

      const result = await service.getEngagementDistribution(mockChurchId);

      expect(result.highly_engaged).toBe(10);
      expect(result.moderately_engaged).toBe(20);
      expect(result.low_engagement).toBe(5);
      expect(result.disengaged).toBe(2);
    });
  });

  describe('getRisingStars', () => {
    it('should return top engaging members', async () => {
      prisma.engagementScore.findMany.mockResolvedValue([
        {
          score: 90,
          member: { id: mockMemberId, first_name: 'John', last_name: 'Doe' },
        },
      ]);

      const result = await service.getRisingStars(mockChurchId);

      expect(result).toHaveLength(1);
      expect(result[0].score).toBe(90);
    });
  });

  describe('listRiskScores', () => {
    const scoreRow = {
      id: 'rs-1',
      church_id: mockChurchId,
      member_id: mockMemberId,
      score: 80,
      level: 'high',
      factors: { attendanceDecline: 0.7, noGiving: 0.2 },
      calculated_at: new Date('2026-08-27T00:00:00Z'),
      member: {
        id: mockMemberId,
        first_name: 'John',
        last_name: 'Doe',
        email: 'john@example.com',
        phone: '+2348012345678',
        status: 'active',
      },
    };

    it('should return paginated risk scores mapped to response DTOs', async () => {
      prisma.riskScore.findMany.mockResolvedValue([scoreRow]);
      prisma.riskScore.count.mockResolvedValue(1);

      const result = await service.listRiskScores(mockChurchId, { page: 1, limit: 20 });

      expect(result.meta).toEqual({ total: 1, page: 1, limit: 20, totalPages: 1 });
      expect(result.data[0]).toMatchObject({
        memberFirstName: 'John',
        memberLastName: 'Doe',
        memberPhone: '+2348012345678',
        score: 80,
        level: 'high',
        factors: { attendanceDecline: 0.7, noGiving: 0.2 },
      });
      expect(result.data[0].calculatedAt).toBe('2026-08-27T00:00:00.000Z');
    });

    it('should apply level and search filters', async () => {
      prisma.riskScore.findMany.mockResolvedValue([]);
      prisma.riskScore.count.mockResolvedValue(0);

      await service.listRiskScores(mockChurchId, { level: 'critical', search: 'Doe' });

      const [findManyArgs] = (prisma.riskScore.findMany as jest.Mock).mock.calls[0];
      expect(findManyArgs.where.level).toBe('critical');
      expect(findManyArgs.where.member.OR).toHaveLength(2);
      expect(findManyArgs.where.member.OR[0]).toMatchObject({
        first_name: { contains: 'Doe', mode: 'insensitive' },
      });
    });

    it('should default sort to score descending', async () => {
      prisma.riskScore.findMany.mockResolvedValue([]);
      prisma.riskScore.count.mockResolvedValue(0);

      await service.listRiskScores(mockChurchId, {});

      const [findManyArgs] = (prisma.riskScore.findMany as jest.Mock).mock.calls[0];
      expect(findManyArgs.orderBy).toEqual([{ score: 'desc' }]);
    });
  });

  describe('listEngagementScores', () => {
    const scoreRow = {
      id: 'es-1',
      church_id: mockChurchId,
      member_id: mockMemberId,
      score: 75,
      factors: { attendance: 0.8, giving: 0.5, events: 0.6, communication: 0.4, consistency: 0.7 },
      calculated_at: new Date('2026-08-27T00:00:00Z'),
      member: {
        id: mockMemberId,
        first_name: 'Jane',
        last_name: 'Smith',
        email: 'jane@example.com',
      },
    };

    it('should return paginated engagement scores mapped to response DTOs', async () => {
      prisma.engagementScore.findMany.mockResolvedValue([scoreRow]);
      prisma.engagementScore.count.mockResolvedValue(1);

      const result = await service.listEngagementScores(mockChurchId, { page: 1, limit: 20 });

      expect(result.meta).toEqual({ total: 1, page: 1, limit: 20, totalPages: 1 });
      expect(result.data[0].memberFirstName).toBe('Jane');
      expect(result.data[0].score).toBe(75);
      expect(result.data[0].factors.attendance).toBe(0.8);
    });

    it('should translate bucket filters into score ranges', async () => {
      prisma.engagementScore.findMany.mockResolvedValue([]);
      prisma.engagementScore.count.mockResolvedValue(0);

      await service.listEngagementScores(mockChurchId, { bucket: 'moderately_engaged' });

      const [findManyArgs] = (prisma.engagementScore.findMany as jest.Mock).mock.calls[0];
      expect(findManyArgs.where.score).toEqual({ gte: 40, lt: 70 });
    });
  });

  describe('getMemberScoring', () => {
    it('should return combined scores with suggestions for a valid member', async () => {
      prisma.member.findFirst.mockResolvedValue({ id: mockMemberId });
      prisma.riskScore.findUnique.mockResolvedValue({
        id: 'rs-1',
        member_id: mockMemberId,
        church_id: mockChurchId,
        score: 85,
        level: 'critical',
        factors: { attendanceDecline: 0.9 },
        calculated_at: new Date('2026-08-27T00:00:00Z'),
      });
      prisma.engagementScore.findUnique.mockResolvedValue({
        id: 'es-1',
        member_id: mockMemberId,
        church_id: mockChurchId,
        score: 30,
        factors: { attendance: 0.2 },
        calculated_at: new Date('2026-08-27T00:00:00Z'),
      });

      const result = await service.getMemberScoring(mockMemberId, mockChurchId);

      expect(result.risk).toMatchObject({ score: 85, level: 'critical' });
      expect(result.engagement).toMatchObject({ score: 30 });
      expect(result.suggestions.length).toBeGreaterThan(0);
    });

    it('should throw NotFoundException when the member is not in this church', async () => {
      prisma.member.findFirst.mockResolvedValue(null);

      await expect(service.getMemberScoring(mockMemberId, mockChurchId)).rejects.toThrow(
        'Member not found in this church',
      );
    });

    it('should return null scores when the member has no scores yet', async () => {
      prisma.member.findFirst.mockResolvedValue({ id: mockMemberId });
      prisma.riskScore.findUnique.mockResolvedValue(null);
      prisma.engagementScore.findUnique.mockResolvedValue(null);

      const result = await service.getMemberScoring(mockMemberId, mockChurchId);

      expect(result.risk).toBeNull();
      expect(result.engagement).toBeNull();
      expect(result.suggestions).toEqual([]);
    });
  });
});
