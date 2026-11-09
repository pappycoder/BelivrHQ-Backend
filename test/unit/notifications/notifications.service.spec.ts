/**
 * @file notifications.service.spec.ts
 * @description Unit tests for NotificationsService.
 */

import { NotificationsService } from '../../../src/notifications/notifications.service';

function createPrismaMock() {
  const models: Record<string, Record<string, jest.Mock>> = {};
  const $transactionMock = jest.fn();
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_target, prop: string) {
      if (prop === '$transaction') return $transactionMock;
      if (prop === '$queryRaw') return jest.fn().mockResolvedValue([]);
      if (!models[prop]) {
        models[prop] = {
          findMany: jest.fn(),
          findUnique: jest.fn(),
          findFirst: jest.fn(),
          create: jest.fn(),
          update: jest.fn(),
          updateMany: jest.fn(),
          delete: jest.fn(),
          deleteMany: jest.fn(),
          count: jest.fn(),
          aggregate: jest.fn(),
          groupBy: jest.fn(),
          upsert: jest.fn(),
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

let prisma: ReturnType<typeof createPrismaMock>;
let service: NotificationsService;
let resendService: { sendEmail: jest.Mock };
let whatsappService: { sendMessage: jest.Mock };

const mockChurchId = '00000000-0000-0000-0000-000000000001';
const mockProfileId = '22222222-2222-2222-2222-222222222222';
const mockNotificationId = '55555555-5555-5555-5555-555555555555';
const mockNotification = {
  id: mockNotificationId,
  church_id: mockChurchId,
  profile_id: mockProfileId,
  type: 'system',
  title: 'Welcome',
  body: 'Welcome to BelivrHQ',
  data: null,
  read_at: null,
  created_at: new Date('2026-07-22'),
};

beforeEach(() => {
  prisma = createPrismaMock();

  resendService = { sendEmail: jest.fn().mockResolvedValue('message-1') };
  whatsappService = { sendMessage: jest.fn().mockResolvedValue(undefined) };

  service = new NotificationsService(
    prisma as unknown as import('../../../src/prisma/prisma.service').PrismaService,
    resendService as never,
    whatsappService as never,
  );
});

describe('NotificationsService', () => {
  describe('listNotifications', () => {
    it('should return paginated notifications with unread count', async () => {
      model('notification').findMany.mockResolvedValue([mockNotification]);
      model('notification')
        .count.mockResolvedValueOnce(1) // total
        .mockResolvedValueOnce(1); // unreadCount

      const result = await service.listNotifications(mockChurchId, mockProfileId, 1, 20);

      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.unreadCount).toBe(1);
      expect(result.data[0].title).toBe('Welcome');
    });

    it('should filter by type', async () => {
      model('notification').findMany.mockResolvedValue([]);
      model('notification').count.mockResolvedValue(0);

      await service.listNotifications(mockChurchId, mockProfileId, 1, 20, 'giving');

      expect(model('notification').findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ type: 'giving' }),
        }),
      );
    });

    it('should filter unread only', async () => {
      model('notification').findMany.mockResolvedValue([]);
      model('notification').count.mockResolvedValue(0);

      await service.listNotifications(mockChurchId, mockProfileId, 1, 20, undefined, 'unread');

      expect(model('notification').findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ read_at: null }),
        }),
      );
    });

    it('should apply date range bounds to created_at', async () => {
      model('notification').findMany.mockResolvedValue([]);
      model('notification').count.mockResolvedValue(0);

      await service.listNotifications(
        mockChurchId,
        mockProfileId,
        1,
        20,
        undefined,
        undefined,
        '2026-07-01',
        '2026-07-31',
      );

      expect(model('notification').findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            created_at: {
              gte: new Date('2026-07-01T00:00:00.000Z'),
              lte: new Date('2026-07-31T23:59:59.999Z'),
            },
          }),
        }),
      );
    });
  });

  describe('getUnreadCount', () => {
    it('should return unread count', async () => {
      model('notification').count.mockResolvedValue(5);

      const count = await service.getUnreadCount(mockChurchId, mockProfileId);

      expect(count).toBe(5);
    });
  });

  describe('markAsRead', () => {
    it('should mark a notification as read', async () => {
      model('notification').findFirst.mockResolvedValue(mockNotification);
      model('notification').update.mockResolvedValue({
        ...mockNotification,
        read_at: new Date(),
      });

      const result = await service.markAsRead(mockNotificationId, mockChurchId, mockProfileId);

      expect(result.readAt).toBeDefined();
      expect(model('notification').update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ read_at: expect.any(Date) }),
        }),
      );
    });

    it('should throw NotFoundException for unknown notification', async () => {
      model('notification').findFirst.mockResolvedValue(null);

      await expect(service.markAsRead('unknown', mockChurchId, mockProfileId)).rejects.toThrow(
        'Notification not found',
      );
    });
  });

  describe('markAllAsRead', () => {
    it('should mark all notifications as read', async () => {
      model('notification').updateMany.mockResolvedValue({ count: 10 });

      const result = await service.markAllAsRead(mockChurchId, mockProfileId);

      expect(result.updated).toBe(10);
    });
  });

  describe('bulkMarkAsRead', () => {
    it('should update only unread rows scoped to the profile', async () => {
      model('notification').updateMany.mockResolvedValue({ count: 3 });

      const result = await service.bulkMarkAsRead(mockChurchId, mockProfileId, [
        'id-1',
        'id-2',
        'id-3',
      ]);

      expect(result.updated).toBe(3);
      expect(model('notification').updateMany).toHaveBeenCalledWith({
        where: {
          id: { in: ['id-1', 'id-2', 'id-3'] },
          church_id: mockChurchId,
          profile_id: mockProfileId,
          read_at: null,
        },
        data: expect.objectContaining({ read_at: expect.any(Date) }),
      });
    });
  });

  describe('bulkMarkAsUnread', () => {
    it('should clear read_at only on already-read rows scoped to the profile', async () => {
      model('notification').updateMany.mockResolvedValue({ count: 2 });

      const result = await service.bulkMarkAsUnread(mockChurchId, mockProfileId, ['id-1', 'id-2']);

      expect(result.updated).toBe(2);
      expect(model('notification').updateMany).toHaveBeenCalledWith({
        where: {
          id: { in: ['id-1', 'id-2'] },
          church_id: mockChurchId,
          profile_id: mockProfileId,
          read_at: { not: null },
        },
        data: { read_at: null },
      });
    });
  });

  describe('bulkRemove', () => {
    it('should hard-delete rows scoped to the profile', async () => {
      model('notification').deleteMany.mockResolvedValue({ count: 2 });

      const result = await service.bulkRemove(mockChurchId, mockProfileId, ['id-1', 'id-2']);

      expect(result.deleted).toBe(2);
      expect(model('notification').deleteMany).toHaveBeenCalledWith({
        where: {
          id: { in: ['id-1', 'id-2'] },
          church_id: mockChurchId,
          profile_id: mockProfileId,
        },
      });
    });
  });

  describe('getOne', () => {
    it('should return a notification scoped to the profile', async () => {
      model('notification').findFirst.mockResolvedValue(mockNotification);

      const result = await service.getOne(mockNotificationId, mockChurchId, mockProfileId);

      expect(result.id).toBe(mockNotificationId);
      expect(model('notification').findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: mockNotificationId,
            church_id: mockChurchId,
            profile_id: mockProfileId,
          }),
        }),
      );
    });

    it('should throw NotFoundException when the notification is not the profile’s', async () => {
      model('notification').findFirst.mockResolvedValue(null);

      await expect(service.getOne(mockNotificationId, mockChurchId, mockProfileId)).rejects.toThrow(
        'Notification not found',
      );
    });
  });

  describe('remove', () => {
    it('should hard-delete a notification scoped to the profile', async () => {
      model('notification').findFirst.mockResolvedValue(mockNotification);
      model('notification').delete.mockResolvedValue(mockNotification);

      await service.remove(mockNotificationId, mockChurchId, mockProfileId);

      expect(model('notification').delete).toHaveBeenCalledWith({
        where: { id: mockNotificationId },
      });
    });

    it('should throw NotFoundException when the notification is not the profile’s', async () => {
      model('notification').findFirst.mockResolvedValue(null);

      await expect(service.remove(mockNotificationId, mockChurchId, mockProfileId)).rejects.toThrow(
        'Notification not found',
      );
      expect(model('notification').delete).not.toHaveBeenCalled();
    });
  });

  describe('createNotification', () => {
    it('should create a notification', async () => {
      model('notification').create.mockResolvedValue(mockNotification);

      const result = await service.createNotification(
        mockChurchId,
        mockProfileId,
        'system',
        'Welcome',
        'Welcome to BelivrHQ',
      );

      expect(result.title).toBe('Welcome');
      expect(result.type).toBe('system');
    });
  });

  describe('sendEmailWithAttachment', () => {
    it('propagates delivery failure without recording a sent notification', async () => {
      model('member').findMany.mockResolvedValue([]);
      resendService.sendEmail.mockRejectedValue(new Error('provider rejected'));
      await expect(
        service.sendEmailWithAttachment(
          'person@example.org',
          'Receipt',
          'Body',
          Buffer.from('pdf'),
          'receipt.pdf',
          mockChurchId,
        ),
      ).rejects.toThrow('could not be delivered');
      expect(model('notification').create).not.toHaveBeenCalled();
    });

    it('forwards the receipt plain text while retaining the church sender and attachment', async () => {
      model('member').findMany.mockResolvedValue([]);
      const buffer = Buffer.from('pdf');
      await service.sendEmailWithAttachment(
        'member@example.org',
        'Receipt',
        '<p>Receipt</p>',
        buffer,
        'receipt.pdf',
        mockChurchId,
        'Receipt details',
      );
      expect(resendService.sendEmail).toHaveBeenCalledWith(
        'member@example.org',
        'Receipt',
        '<p>Receipt</p>',
        mockChurchId,
        { filename: 'receipt.pdf', content: buffer },
        { text: 'Receipt details' },
      );
    });

    it('should forward attachments to the email service', async () => {
      model('member').findMany.mockResolvedValue([{ id: 'member-1' }]);
      model('profile').findMany.mockResolvedValue([{ id: mockProfileId }]);

      await service.sendEmailWithAttachment(
        'member@example.com',
        'Receipt',
        'Body',
        Buffer.from('pdf'),
        'receipt.pdf',
        mockChurchId,
      );

      expect(resendService.sendEmail).toHaveBeenCalledWith(
        'member@example.com',
        'Receipt',
        'Body',
        mockChurchId,
        expect.objectContaining({
          filename: 'receipt.pdf',
          content: expect.any(Buffer),
        }),
      );
    });

    it('should still attempt delivery when no matching member exists', async () => {
      model('member').findMany.mockResolvedValue([]);

      await service.sendEmailWithAttachment(
        'norecord@example.com',
        'Receipt',
        'Body',
        Buffer.from('pdf'),
        'receipt.pdf',
        mockChurchId,
      );

      expect(resendService.sendEmail).toHaveBeenCalledWith(
        'norecord@example.com',
        'Receipt',
        'Body',
        mockChurchId,
        expect.objectContaining({
          filename: 'receipt.pdf',
          content: expect.any(Buffer),
        }),
      );
    });
  });

  describe('sendWhatsAppWithDocument', () => {
    it('should send document content via the WhatsApp service', async () => {
      model('profile').findMany.mockResolvedValue([{ id: mockProfileId }]);

      await service.sendWhatsAppWithDocument(
        '+2348000000000',
        Buffer.from('doc'),
        'receipt.pdf',
        'Receipt ready',
        mockChurchId,
      );

      expect(whatsappService.sendMessage).toHaveBeenCalledWith(
        '+2348000000000',
        expect.stringContaining('Receipt ready'),
        mockChurchId,
      );
    });
  });

  describe('broadcastToChurch', () => {
    it('should send notifications to all profiles', async () => {
      model('profile').findMany.mockResolvedValue([
        { id: mockProfileId },
        { id: '66666666-6666-6666-6666-666666666666' },
      ]);
      model('notification').create.mockResolvedValue(mockNotification);

      const result = await service.broadcastToChurch(
        mockChurchId,
        'system',
        'Announcement',
        'System maintenance tonight',
      );

      expect(result.sent).toBe(2);
      expect(model('notification').create).toHaveBeenCalledTimes(2);
    });
  });
});
