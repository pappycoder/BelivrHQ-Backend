import { RequestContextService } from '../../../src/common/services/request-context.service';
/**
 * @file broadcast.service.spec.ts
 * @description Unit tests for BroadcastService.
 *
 * Tests broadcast creation, audience filtering, cancellation, and processing.
 *
 * @module test/unit/broadcast/broadcast.service.spec
 * @since 1.0.0
 */

import { BroadcastService } from '../../../src/broadcast/broadcast.service';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { AuditLoggingService } from '../../../src/common/services/audit-logging.service';
import { createPrismaMock } from '../../helpers/prisma-mock.helper';
import { BadRequestException, NotFoundException } from '@nestjs/common';

describe('BroadcastService', () => {
  let service: BroadcastService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let audit: { log: jest.Mock };
  let queues: Record<string, { add: jest.Mock }>;

  const mockChurchId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const mockUserId = '11111111-1111-1111-1111-111111111111';
  const mockTemplateId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const mockBroadcastId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  const mockMemberId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

  const mockTemplate = {
    id: mockTemplateId,
    church_id: mockChurchId,
    name: 'Sunday Reminder',
    content: 'Hello {{name}}, join us tomorrow!',
    channel: 'whatsapp',
    language: 'en',
    status: 'published',
    category: 'MARKETING',
    variables: ['name'],
    external_id: null,
    external_status: null,
    created_at: new Date(),
    updated_at: new Date(),
  };

  const mockMember = {
    id: mockMemberId,
    phone: '+2348012345678',
    whatsapp_number: '+2348012345678',
    email: 'test@example.com',
    first_name: 'Ade',
    last_name: 'Bayo',
    status: 'active',
  };

  const mockBroadcast = {
    id: mockBroadcastId,
    church_id: mockChurchId,
    name: 'Sunday Reminder',
    template_id: mockTemplateId,
    channel: 'whatsapp',
    audience_filter: {},
    status: 'draft',
    scheduled_at: null,
    sent_at: null,
    total_recipients: 1,
    created_at: new Date(),
    updated_at: new Date(),
  };

  beforeEach(() => {
    prisma = createPrismaMock();
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    queues = {
      broadcast: { add: jest.fn().mockResolvedValue(undefined) },
      whatsapp: { add: jest.fn().mockResolvedValue(undefined) },
      sms: { add: jest.fn().mockResolvedValue(undefined) },
      email: { add: jest.fn().mockResolvedValue(undefined) },
    };

    service = new BroadcastService(
      prisma as unknown as PrismaService,
      new RequestContextService(),
      audit as unknown as AuditLoggingService,
      {
        createNotification: jest.fn().mockResolvedValue({}),
        broadcastToChurch: jest.fn().mockResolvedValue({ sent: 0 }),
      } as never,
      queues.broadcast as never,
      queues.whatsapp as never,
      queues.sms as never,
      queues.email as never,
      { resolve: jest.fn().mockResolvedValue({ accountId: 'church-account' }) } as never,
    );
  });

  describe('create', () => {
    it('should create an immediate broadcast and queue it', async () => {
      prisma.template.findFirst.mockResolvedValue(mockTemplate);
      prisma.member.findMany.mockResolvedValue([mockMember]);
      prisma.broadcast.create.mockResolvedValue(mockBroadcast);
      prisma.broadcastRecipient.createMany.mockResolvedValue({ count: 1 });
      prisma.broadcast.update.mockResolvedValue({ ...mockBroadcast, status: 'sending' });

      const result = await service.create(
        {
          name: 'Sunday Reminder',
          templateId: mockTemplateId,
          channel: 'whatsapp',
        },
        mockChurchId,
        mockUserId,
      );

      expect(result.totalRecipients).toBe(1);
      expect(queues.broadcast.add).toHaveBeenCalledWith(
        'send',
        { broadcastId: mockBroadcastId, churchId: mockChurchId },
        { jobId: `broadcast-${mockBroadcastId}` },
      );
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'broadcast', action: 'CREATE' }),
      );
    });

    it('should reject non-published templates', async () => {
      prisma.template.findFirst.mockResolvedValue({ ...mockTemplate, status: 'draft' });

      await expect(
        service.create(
          { name: 'X', templateId: mockTemplateId, channel: 'whatsapp' },
          mockChurchId,
          mockUserId,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject mismatched channel', async () => {
      prisma.template.findFirst.mockResolvedValue(mockTemplate);

      await expect(
        service.create(
          { name: 'X', templateId: mockTemplateId, channel: 'sms' },
          mockChurchId,
          mockUserId,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject empty audience', async () => {
      prisma.template.findFirst.mockResolvedValue(mockTemplate);
      prisma.member.findMany.mockResolvedValue([]);

      await expect(
        service.create(
          { name: 'X', templateId: mockTemplateId, channel: 'whatsapp' },
          mockChurchId,
          mockUserId,
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('findAll', () => {
    it.each([
      ['name', 'name'],
      ['createdAt', 'created_at'],
      ['scheduledAt', 'scheduled_at'],
      ['sentAt', 'sent_at'],
      ['totalRecipients', 'total_recipients'],
      ['channel', 'channel'],
      ['status', 'status'],
    ] as const)(
      'sorts %s before pagination and searches templates without losing branch scope',
      async (sortBy, field) => {
        jest
          .spyOn(RequestContextService.prototype, 'branchWhere')
          .mockReturnValue({ branch_id: 'own-branch' });
        prisma.broadcast.findMany.mockResolvedValue([]);
        prisma.broadcast.count.mockResolvedValue(0);
        prisma.template.findMany.mockResolvedValue([]);
        await service.findAll(mockChurchId, {
          page: 3,
          limit: 12,
          sortBy,
          sortOrder: 'asc',
          search: ' Sunday ',
          channel: 'email',
          status: 'scheduled',
          branchId: 'other-branch',
        });
        const query = prisma.broadcast.findMany.mock.calls[0][0];
        expect(query).toMatchObject({
          skip: 24,
          take: 12,
          orderBy: [{ [field]: 'asc' }, { id: 'asc' }],
          where: {
            church_id: mockChurchId,
            channel: 'email',
            status: 'scheduled',
            audience_filter: { path: ['branchId'], equals: 'own-branch' },
            AND: [
              {
                OR: [
                  { name: { contains: 'Sunday', mode: 'insensitive' } },
                  { template: { name: { contains: 'Sunday', mode: 'insensitive' } } },
                ],
              },
            ],
          },
        });
        expect(prisma.broadcast.count).toHaveBeenCalledWith({ where: query.where });
      },
    );

    it('should return paginated broadcasts', async () => {
      prisma.broadcast.findMany.mockResolvedValue([mockBroadcast]);
      prisma.broadcast.count.mockResolvedValue(1);
      prisma.template.findMany.mockResolvedValue([mockTemplate]);

      const result = await service.findAll(mockChurchId, {});

      expect(result.data).toHaveLength(1);
      expect(result.data[0].templateName).toBe('Sunday Reminder');
    });
  });

  describe('findById', () => {
    it('should return broadcast by ID', async () => {
      prisma.broadcast.findFirst.mockResolvedValue(mockBroadcast);
      prisma.template.findUnique.mockResolvedValue(mockTemplate);

      const result = await service.findById(mockBroadcastId, mockChurchId);

      expect(result.broadcastId).toBe(mockBroadcastId);
    });

    it('should throw NotFoundException if not found', async () => {
      prisma.broadcast.findFirst.mockResolvedValue(null);

      await expect(service.findById('nonexistent', mockChurchId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('cancel', () => {
    it('should cancel a draft broadcast', async () => {
      prisma.broadcast.findFirst.mockResolvedValue(mockBroadcast);
      prisma.broadcast.update.mockResolvedValue({ ...mockBroadcast, status: 'cancelled' });

      await service.cancel(mockBroadcastId, mockChurchId, mockUserId);

      expect(prisma.broadcast.update).toHaveBeenCalledWith({
        where: { id: mockBroadcastId },
        data: { status: 'cancelled' },
      });
    });

    it('should throw BadRequestException if already sent', async () => {
      prisma.broadcast.findFirst.mockResolvedValue({ ...mockBroadcast, status: 'sent' });

      await expect(service.cancel(mockBroadcastId, mockChurchId, mockUserId)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('processBroadcast', () => {
    it('should enqueue messages for all pending recipients', async () => {
      prisma.broadcast.findFirst.mockResolvedValue({
        ...mockBroadcast,
        template: mockTemplate,
      });
      prisma.broadcast.update.mockResolvedValue({ ...mockBroadcast, status: 'sending' });
      prisma.broadcastRecipient.findMany.mockResolvedValue([
        {
          id: 'rr-1',
          broadcast_id: mockBroadcastId,
          member_id: mockMemberId,
          phone: '+2348012345678',
          status: 'pending',
        },
      ]);
      prisma.member.findUnique.mockResolvedValue(mockMember);
      prisma.broadcastRecipient.update.mockResolvedValue({});

      await service.processBroadcast(mockBroadcastId, mockChurchId);

      expect(queues.whatsapp.add).toHaveBeenCalledWith(
        'send',
        expect.objectContaining({
          to: '+2348012345678',
          message: 'Hello Ade Bayo, join us tomorrow!',
          churchId: mockChurchId,
          memberId: mockMemberId,
        }),
      );
    });

    it('should use WhatsApp template when external_id is set', async () => {
      prisma.broadcast.findFirst.mockResolvedValue({
        ...mockBroadcast,
        template: { ...mockTemplate, external_id: 'belivrhq:sunday_reminder' },
      });
      prisma.broadcast.update.mockResolvedValue({ ...mockBroadcast, status: 'sending' });
      prisma.broadcastRecipient.findMany.mockResolvedValue([
        {
          id: 'rr-1',
          broadcast_id: mockBroadcastId,
          member_id: mockMemberId,
          phone: '+2348012345678',
          status: 'pending',
        },
      ]);
      prisma.member.findUnique.mockResolvedValue(mockMember);
      prisma.broadcastRecipient.update.mockResolvedValue({});

      await service.processBroadcast(mockBroadcastId, mockChurchId);

      expect(queues.whatsapp.add).toHaveBeenCalledWith(
        'send-template',
        expect.objectContaining({
          to: '+2348012345678',
          templateName: 'belivrhq:sunday_reminder',
          churchId: mockChurchId,
        }),
      );
    });

    it('should skip cancelled broadcasts', async () => {
      prisma.broadcast.findFirst.mockResolvedValue({
        ...mockBroadcast,
        status: 'cancelled',
        template: mockTemplate,
      });

      await service.processBroadcast(mockBroadcastId, mockChurchId);

      expect(queues.whatsapp.add).not.toHaveBeenCalled();
    });
  });
});
