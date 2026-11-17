import { RequestContextService } from '../../../src/common/services/request-context.service';
/**
 * @file email.service.spec.ts
 * @description Unit tests for EmailService.
 */

import { EmailService, MAIN_ROLES } from '../../../src/email/email.service';
import { EmailBox } from '../../../src/email/dto/list-emails.dto';

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
          createMany: jest.fn(),
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
let audit: { log: jest.Mock };
let service: EmailService;

const mockChurchId = '00000000-0000-0000-0000-000000000001';
const mockSenderId = '11111111-1111-1111-1111-111111111111';
const mockRecipientId = '22222222-2222-2222-2222-222222222222';
const mockMessageId = '99999999-9999-9999-9999-999999999999';

function recipientRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: mockRecipientId,
    first_name: 'Bola',
    last_name: 'Okonkwo',
    email: 'bola@church.org',
    role: ['branch_pastor'],
    status: 'active',
    branch_id: '33333333-3333-3333-3333-333333333333',
    avatar_url: null,
    branch: { id: '33333333-3333-3333-3333-333333333333', name: 'Main Campus' },
    ...overrides,
  };
}

function messageRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: mockMessageId,
    church_id: mockChurchId,
    sender_id: mockSenderId,
    sender_name: 'Pastor John Adebayo',
    subject: 'Quarterly Review',
    body: 'Hi team, please review the figures.',
    reply_to_id: null,
    deleted_at: null,
    created_at: new Date('2026-08-30T08:00:00.000Z'),
    ...overrides,
  };
}

beforeEach(() => {
  prisma = createPrismaMock();
  audit = { log: jest.fn().mockResolvedValue(undefined) };
  service = new EmailService(prisma as never, new RequestContextService(), audit as never);
});

describe('EmailService', () => {
  it('MAIN_ROLES excludes member and cell_leader', () => {
    expect(MAIN_ROLES).not.toContain('member');
    expect(MAIN_ROLES).toContain('church_admin');
    expect(MAIN_ROLES).not.toContain('cell_leader');
  });

  describe('send', () => {
    it('creates a message + recipient copies and audit-logs', async () => {
      model('profile').findFirst.mockResolvedValueOnce({
        first_name: 'Pastor John',
        last_name: 'Adebayo',
      });
      model('profile').findMany.mockResolvedValueOnce([recipientRow()]);
      model('emailMessage').create.mockResolvedValueOnce(messageRow());
      model('emailRecipient').createMany.mockResolvedValueOnce({ count: 1 });
      model('profile').findFirst.mockResolvedValueOnce({
        first_name: 'Pastor John',
        last_name: 'Adebayo',
      });

      const result = await service.send(
        { recipientIds: [mockRecipientId], subject: 'Quarterly Review', body: 'Hi' },
        mockChurchId,
        mockSenderId,
        'user-1',
      );

      expect(result.id).toBe(mockMessageId);
      expect(model('emailMessage').create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            church_id: mockChurchId,
            sender_id: mockSenderId,
            subject: 'Quarterly Review',
            body: 'Hi',
          }),
        }),
      );
      expect(model('emailRecipient').createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.arrayContaining([
            expect.objectContaining({ message_id: mockMessageId, profile_id: mockRecipientId }),
          ]),
        }),
      );
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          churchId: mockChurchId,
          userId: 'user-1',
          entity: 'email',
          action: 'CREATE',
          entityId: mockMessageId,
        }),
      );
    });

    it('dedupes recipients and rejects sending to self', async () => {
      await expect(
        service.send(
          { recipientIds: [mockSenderId], subject: 'S', body: 'B' },
          mockChurchId,
          mockSenderId,
          'u',
        ),
      ).rejects.toThrow('cannot send an email to yourself');
      expect(model('emailMessage').create).not.toHaveBeenCalled();
    });

    it('throws when no valid recipients selected', async () => {
      model('profile').findMany.mockResolvedValueOnce([]);
      await expect(
        service.send(
          { recipientIds: [mockRecipientId], subject: 'S', body: 'B' },
          mockChurchId,
          mockSenderId,
          'u',
        ),
      ).rejects.toThrow('No valid recipients');
    });
  });

  describe('list (inbox)', () => {
    it('returns mapped inbox items with unread count and church scoping', async () => {
      const copy = {
        id: 'copy-1',
        message_id: mockMessageId,
        profile_id: mockRecipientId,
        read_at: null,
        deleted_at: null,
        created_at: new Date('2026-08-30'),
      };
      model('emailRecipient').findMany.mockResolvedValueOnce([copy]);
      model('emailRecipient').count.mockResolvedValueOnce(1); // total
      model('emailRecipient').count.mockResolvedValueOnce(1); // unread
      model('emailMessage').findMany.mockResolvedValueOnce([messageRow()]);
      model('profile').findMany.mockResolvedValueOnce([{ id: mockRecipientId, avatar_url: null }]);

      const result = await service.list(mockChurchId, mockRecipientId, 1, 30);

      expect(result.total).toBe(1);
      expect(result.unreadCount).toBe(1);
      expect(result.data[0].id).toBe(mockMessageId);
      // recipient copies are scoped to the message church
      const where = model('emailRecipient').findMany.mock.calls[0][0].where;
      expect(where.profile_id).toBe(mockRecipientId);
      expect(where.message.church_id).toBe(mockChurchId);
    });
  });

  describe('list (sent)', () => {
    it('maps sent items with joined recipient names', async () => {
      model('emailMessage').findMany.mockResolvedValueOnce([messageRow()]);
      model('emailMessage').count.mockResolvedValueOnce(1);
      model('emailRecipient').findMany.mockResolvedValueOnce([
        { message_id: mockMessageId, profile_id: mockRecipientId },
      ]);
      model('profile').findMany.mockResolvedValueOnce([recipientRow({ role: ['secretary'] })]);
      model('profile').findMany.mockResolvedValueOnce([{ id: mockSenderId, avatar_url: null }]);

      const result = await service.list(mockChurchId, mockSenderId, 1, 30, EmailBox.Sent);

      expect(result.data[0].recipientName).toContain('Bola Okonkwo');
      expect(model('emailMessage').findMany.mock.calls[0][0].where.sender_id).toBe(mockSenderId);
    });
  });

  describe('getOne', () => {
    it('fetches a message and marks it read when unread', async () => {
      const copy = {
        id: 'copy-1',
        message_id: mockMessageId,
        profile_id: mockRecipientId,
        read_at: null,
        deleted_at: null,
        created_at: new Date(),
      };
      model('emailMessage').findFirst.mockResolvedValueOnce(messageRow());
      model('emailRecipient').findMany.mockResolvedValueOnce([copy]);
      model('emailRecipient').update.mockImplementationOnce(async ({ data }) => ({
        ...copy,
        read_at: data.read_at,
      }));
      model('profile').findMany.mockResolvedValueOnce([recipientRow()]);
      model('profile').findFirst.mockResolvedValueOnce({ first_name: 'P', last_name: 'A' });

      const result = await service.getOne(mockMessageId, mockChurchId, mockRecipientId);

      expect(result.id).toBe(mockMessageId);
      expect(result.readAt).toBeDefined();
      expect(model('emailRecipient').update).toHaveBeenCalled();
    });

    it('404s when the message is not in the church', async () => {
      model('emailMessage').findFirst.mockResolvedValueOnce(null);
      await expect(service.getOne(mockMessageId, mockChurchId, mockRecipientId)).rejects.toThrow(
        'not found',
      );
    });

    it('404s when the user is neither sender nor recipient', async () => {
      model('emailMessage').findFirst.mockResolvedValueOnce(messageRow());
      model('emailRecipient').findMany.mockResolvedValueOnce([]);
      await expect(service.getOne(mockMessageId, mockChurchId, mockRecipientId)).rejects.toThrow(
        'not found',
      );
    });
  });

  describe('markRead / markUnread', () => {
    it('marks read only when currently unread', async () => {
      model('emailRecipient').findFirst.mockResolvedValueOnce({
        id: 'copy-1',
        read_at: null,
        message_id: mockMessageId,
        profile_id: mockRecipientId,
        deleted_at: null,
        created_at: new Date(),
      });
      const result = await service.markRead(mockMessageId, mockChurchId, mockRecipientId);
      expect(result).toEqual({ success: true });
      expect(model('emailRecipient').update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ read_at: expect.any(Date) }) }),
      );
    });

    it('marks unread', async () => {
      model('emailRecipient').findFirst.mockResolvedValueOnce({
        id: 'copy-1',
        read_at: new Date(),
        message_id: mockMessageId,
        profile_id: mockRecipientId,
        deleted_at: null,
        created_at: new Date(),
      });
      await service.markUnread(mockMessageId, mockChurchId, mockRecipientId);
      expect(model('emailRecipient').update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ read_at: null }) }),
      );
    });

    it('404s when the copy is missing', async () => {
      model('emailRecipient').findFirst.mockResolvedValueOnce(null);
      await expect(service.markRead(mockMessageId, mockChurchId, mockRecipientId)).rejects.toThrow(
        'not found',
      );
    });
  });

  describe('trash / restore / deleteForever', () => {
    it('trashes an inbox copy via the recipient row', async () => {
      model('emailMessage').findFirst.mockResolvedValueOnce(messageRow());
      model('emailRecipient').findFirst.mockResolvedValueOnce({
        id: 'copy-1',
        message_id: mockMessageId,
        profile_id: mockRecipientId,
        read_at: null,
        deleted_at: null,
        created_at: new Date(),
      });
      await service.trash(mockMessageId, mockChurchId, mockRecipientId);
      expect(model('emailRecipient').update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ deleted_at: expect.any(Date) }),
        }),
      );
    });

    it('trashes a sent copy via the message row', async () => {
      model('emailMessage').findFirst.mockResolvedValueOnce(messageRow());
      model('emailRecipient').findFirst.mockResolvedValueOnce(null);
      await service.trash(mockMessageId, mockChurchId, mockSenderId);
      expect(model('emailMessage').update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ deleted_at: expect.any(Date) }),
        }),
      );
    });

    it('restores a trashed inbox copy', async () => {
      model('emailMessage').findFirst.mockResolvedValueOnce(messageRow());
      model('emailRecipient').findFirst.mockResolvedValueOnce({
        id: 'copy-1',
        deleted_at: new Date(),
      });
      await service.restore(mockMessageId, mockChurchId, mockRecipientId);
      expect(model('emailRecipient').update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ deleted_at: null }) }),
      );
    });

    it('hard-deletes an inbox copy only when it was trashed', async () => {
      model('emailMessage').findFirst.mockResolvedValue(messageRow());
      // untrashed copy → refuse
      model('emailRecipient').findFirst.mockResolvedValueOnce({
        id: 'copy-1',
        deleted_at: null,
      });
      await expect(
        service.deleteForever(mockMessageId, mockChurchId, mockRecipientId),
      ).rejects.toThrow('must be trashed');
      // trashed copy → delete
      model('emailRecipient').findFirst.mockResolvedValueOnce({
        id: 'copy-1',
        deleted_at: new Date(),
      });
      await service.deleteForever(mockMessageId, mockChurchId, mockRecipientId);
      expect(model('emailRecipient').delete).toHaveBeenCalledWith({ where: { id: 'copy-1' } });
    });

    it('trash 404s when neither recipient nor sender', async () => {
      model('emailMessage').findFirst.mockResolvedValueOnce(messageRow());
      model('emailRecipient').findFirst.mockResolvedValueOnce(null);
      await expect(service.trash(mockMessageId, mockChurchId, mockRecipientId)).rejects.toThrow(
        'not found',
      );
    });
  });

  describe('listContacts', () => {
    it('filters to main roles in the same church, excluding self by default', async () => {
      model('profile').findMany.mockResolvedValueOnce([recipientRow()]);
      const result = await service.listContacts(mockChurchId, mockSenderId);
      const where = model('profile').findMany.mock.calls[0][0].where;
      expect(where.church_id).toBe(mockChurchId);
      expect(where.id.not).toBe(mockSenderId);
      expect(where.role).toEqual(expect.objectContaining({ hasSome: expect.any(Array) }));
      expect(result.total).toBe(1);
      expect(result.data[0].name).toBe('Bola Okonkwo');
      expect(result.data[0].role).toBe('branch_pastor');
      expect(result.data[0].branchName).toBe('Main Campus');
    });

    it('applies search and includes self when requested', async () => {
      model('profile').findMany.mockResolvedValueOnce([recipientRow()]);
      await service.listContacts(mockChurchId, mockSenderId, 'bola', undefined, undefined, true);
      const where = model('profile').findMany.mock.calls[0][0].where;
      expect(where.id).toBeUndefined();
      expect(where.OR).toBeDefined();
    });
  });
});

describe('Email copy ownership and trash edge cases', () => {
  it.each(['restore', 'deleteForever'] as const)(
    'hides missing and unrelated email during %s',
    async (operation) => {
      model('emailMessage').findFirst.mockResolvedValue(null);
      await expect(service[operation](mockMessageId, mockChurchId, mockSenderId)).rejects.toThrow(
        'Email not found',
      );
      model('emailMessage').findFirst.mockResolvedValue(messageRow({ sender_id: 'other' }));
      model('emailRecipient').findFirst.mockResolvedValue(null);
      await expect(service[operation](mockMessageId, mockChurchId, mockSenderId)).rejects.toThrow(
        'Email not found',
      );
      expect(model('emailMessage').update).not.toHaveBeenCalled();
      expect(model('emailMessage').delete).not.toHaveBeenCalled();
    },
  );
  it('restores the sender copy without modifying recipient copies', async () => {
    model('emailMessage').findFirst.mockResolvedValue(messageRow({ deleted_at: new Date() }));
    model('emailRecipient').findFirst.mockResolvedValue(null);
    expect(await service.restore(mockMessageId, mockChurchId, mockSenderId)).toEqual({
      success: true,
    });
    expect(model('emailMessage').update).toHaveBeenCalledWith({
      where: { id: mockMessageId },
      data: { deleted_at: null },
    });
    expect(model('emailRecipient').update).not.toHaveBeenCalled();
  });
  it.each([true, false])(
    'requires a trashed sender copy for permanent deletion (trashed=%s)',
    async (trashed) => {
      model('emailMessage').findFirst.mockResolvedValue(
        messageRow({ deleted_at: trashed ? new Date() : null }),
      );
      model('emailRecipient').findFirst.mockResolvedValue(null);
      if (trashed) {
        expect(await service.deleteForever(mockMessageId, mockChurchId, mockSenderId)).toEqual({
          success: true,
        });
        expect(model('emailMessage').delete).toHaveBeenCalledWith({ where: { id: mockMessageId } });
      } else {
        await expect(
          service.deleteForever(mockMessageId, mockChurchId, mockSenderId),
        ).rejects.toThrow('must be trashed');
        expect(model('emailMessage').delete).not.toHaveBeenCalled();
      }
      expect(model('emailRecipient').delete).not.toHaveBeenCalled();
    },
  );
  it('returns an empty default inbox without unnecessary sender lookups', async () => {
    model('emailRecipient').findMany.mockResolvedValue([]);
    model('emailRecipient').count.mockResolvedValue(0);
    const result = await service.list(mockChurchId, mockSenderId);
    expect(result).toMatchObject({ data: [], total: 0 });
    expect(model('profile').findMany).not.toHaveBeenCalled();
  });
  it('maps a trashed historical sent message with no recipients or saved sender name', async () => {
    model('emailMessage').findMany.mockResolvedValue([
      messageRow({ sender_name: null, deleted_at: new Date('2026-01-01'), body: 'x'.repeat(200) }),
    ]);
    model('emailMessage').count.mockResolvedValue(1);
    model('emailRecipient').findMany.mockResolvedValue([]);
    model('profile').findMany.mockResolvedValue([]);
    const result = await service.list(mockChurchId, mockSenderId, 1, 30, EmailBox.Sent, true);
    expect(result.data[0]).toMatchObject({
      senderName: undefined,
      recipientId: '',
      deletedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(model('emailMessage').findMany.mock.calls[0][0].where).toMatchObject({
      church_id: mockChurchId,
      sender_id: mockSenderId,
      deleted_at: { not: null },
    });
  });
});
