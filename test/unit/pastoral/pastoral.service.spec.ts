import { RequestContextService } from '../../../src/common/services/request-context.service';
import { Test, TestingModule } from '@nestjs/testing';
import { PastoralService } from '../../../src/pastoral/pastoral.service';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { AuditLoggingService } from '../../../src/common/services/audit-logging.service';
import { NotFoundException, ForbiddenException, ConflictException } from '@nestjs/common';
import { createPrismaMock } from '../../helpers/prisma-mock.helper';

describe('PastoralService', () => {
  let service: PastoralService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let auditLog: jest.Mock;

  const mockChurchId = 'church-1';
  const mockUserId = 'user-1';
  const mockMemberId = 'member-1';

  const mockNote = {
    id: 'note-1',
    church_id: mockChurchId,
    member_id: mockMemberId,
    author_id: mockMemberId,
    content: 'encrypted-content',
    confidentiality: 'standard',
    tags: ['prayer'],
    created_at: new Date('2024-06-01'),
    updated_at: new Date('2024-06-01'),
    member: { first_name: 'John', last_name: 'Doe' },
    author: { first_name: 'Pastor', last_name: 'Smith' },
  };

  beforeEach(async () => {
    prisma = createPrismaMock();
    auditLog = jest.fn();

    // Mock profile lookup for resolveMemberId (user.sub → member_id)
    prisma.profile.findUnique.mockResolvedValue({
      id: 'profile-1',
      member_id: mockMemberId,
      first_name: 'Pastor',
      last_name: 'Smith',
      church_id: mockChurchId,
      branch_id: null,
    });

    // Mock subject member lookup for church-scoped validation
    prisma.member.findFirst.mockResolvedValue({ id: mockMemberId });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RequestContextService,
        PastoralService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditLoggingService, useValue: { log: auditLog } },
      ],
    }).compile();

    service = module.get<PastoralService>(PastoralService);
  });

  describe('Encryption/Decryption', () => {
    it('should encrypt and decrypt content correctly', () => {
      const plaintext = 'This is a confidential pastoral note';
      const encrypted = service.encrypt(plaintext);
      const decrypted = service.decrypt(encrypted);

      expect(decrypted).toBe(plaintext);
      expect(encrypted).not.toBe(plaintext);
      expect(encrypted.split(':')).toHaveLength(3); // iv:authTag:ciphertext
    });

    it('should handle empty strings gracefully', () => {
      const encrypted = service.encrypt('');
      const decrypted = service.decrypt(encrypted);
      expect(typeof decrypted).toBe('string');
    });

    it('should handle long content', () => {
      const plaintext = 'A'.repeat(5000);
      const encrypted = service.encrypt(plaintext);
      const decrypted = service.decrypt(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it('should fail gracefully on tampered data', () => {
      const encrypted = service.encrypt('test');
      const parts = encrypted.split(':');
      parts[2] = 'tampered';
      const result = service.decrypt(parts.join(':'));
      expect(result).toBe('[Decryption failed]');
    });

    it('should fail gracefully on invalid format', () => {
      const result = service.decrypt('invalid');
      expect(result).toBe('[Decryption failed: invalid format]');
    });
  });

  describe('createNote', () => {
    it('should create a pastoral note with encrypted content', async () => {
      prisma.pastoralNote.create.mockResolvedValue(mockNote);

      const result = await service.createNote(
        { memberId: mockMemberId, content: 'Test content', tags: ['prayer'] },
        mockChurchId,
        mockUserId,
      );

      expect(result.id).toBe('note-1');
      expect(result.memberId).toBe(mockMemberId);
      expect(result.content).toBe('Test content');
      expect(result.tags).toEqual(['prayer']);
      expect(prisma.pastoralNote.create).toHaveBeenCalled();
      expect(auditLog).toHaveBeenCalled();
    });

    it('should set default confidentiality to standard', async () => {
      prisma.pastoralNote.create.mockResolvedValue({
        ...mockNote,
        confidentiality: 'standard',
      });

      await service.createNote(
        { memberId: mockMemberId, content: 'Test' },
        mockChurchId,
        mockUserId,
      );

      const createCall = prisma.pastoralNote.create.mock.calls[0][0];
      expect(createCall.data.confidentiality).toBe('standard');
    });

    it('should auto-create a Member record when profile has no member_id', async () => {
      // Profile without member_id
      prisma.profile.findUnique.mockResolvedValue({
        id: 'profile-no-member',
        member_id: null,
        first_name: 'Admin',
        last_name: 'User',
        church_id: mockChurchId,
        branch_id: null,
      });

      const newMember = {
        id: 'auto-member-1',
        church_id: mockChurchId,
        first_name: 'Admin',
        last_name: 'User',
      };
      prisma.member.create.mockResolvedValue(newMember);
      prisma.profile.update.mockResolvedValue({
        id: 'profile-no-member',
        member_id: 'auto-member-1',
      });
      prisma.pastoralNote.create.mockResolvedValue({
        ...mockNote,
        author_id: 'auto-member-1',
      });

      const result = await service.createNote(
        { memberId: mockMemberId, content: 'Test content', tags: ['prayer'] },
        mockChurchId,
        mockUserId,
      );

      expect(prisma.member.create).toHaveBeenCalled();
      expect(prisma.profile.update).toHaveBeenCalledWith({
        where: { id: 'profile-no-member' },
        data: { member_id: 'auto-member-1' },
      });
      expect(result.id).toBe('note-1');
    });
  });

  describe('getNoteById', () => {
    it('should return a note with decrypted content', async () => {
      const plaintext = 'Test pastoral note content';
      const noteWithEncrypted = {
        ...mockNote,
        content: service.encrypt(plaintext),
      };
      prisma.pastoralNote.findFirst.mockResolvedValue(noteWithEncrypted);

      const result = await service.getNoteById(
        'note-1',
        mockChurchId,
        ['pastoral_confidential:read'],
        mockUserId,
      );

      expect(result.content).toBe(plaintext);
    });

    it('should throw NotFoundException for non-existent note', async () => {
      prisma.pastoralNote.findFirst.mockResolvedValue(null);

      await expect(
        service.getNoteById(
          'non-existent',
          mockChurchId,
          ['pastoral_confidential:read'],
          mockUserId,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException for restricted notes (non-admin)', async () => {
      prisma.pastoralNote.findFirst.mockResolvedValue({
        ...mockNote,
        confidentiality: 'restricted',
        author_id: 'other-member',
      });

      await expect(
        service.getNoteById('note-1', mockChurchId, ['pastoral_confidential:read'], mockUserId),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should allow admin to access restricted notes', async () => {
      const plaintext = 'Restricted content';
      prisma.pastoralNote.findFirst.mockResolvedValue({
        ...mockNote,
        content: service.encrypt(plaintext),
        confidentiality: 'restricted',
        author_id: 'other-member',
      });

      const result = await service.getNoteById(
        'note-1',
        mockChurchId,
        [
          'pastoral_confidential:read',
          'pastoral_restricted:read',
          'pastoral_moderation:update',
          'pastoral_moderation:delete',
        ],
        mockUserId,
      );
      expect(result.content).toBe(plaintext);
    });

    it('should allow author to access their own restricted notes', async () => {
      const plaintext = 'My restricted note';
      prisma.pastoralNote.findFirst.mockResolvedValue({
        ...mockNote,
        content: service.encrypt(plaintext),
        confidentiality: 'restricted',
        author_id: mockMemberId,
      });

      const result = await service.getNoteById(
        'note-1',
        mockChurchId,
        ['pastoral_confidential:read'],
        mockUserId,
      );
      expect(result.content).toBe(plaintext);
    });
  });

  describe('updateNote', () => {
    it('should update note content (author)', async () => {
      prisma.pastoralNote.findFirst.mockResolvedValue(mockNote);
      prisma.pastoralNote.update.mockResolvedValue({
        ...mockNote,
        content: service.encrypt('Updated content'),
      });

      const result = await service.updateNote(
        'note-1',
        { content: 'Updated content' },
        mockChurchId,
        mockUserId,
        ['pastoral_confidential:read'],
      );

      expect(result.content).toBe('Updated content');
      expect(auditLog).toHaveBeenCalled();
    });

    it('should allow admin to update any note', async () => {
      prisma.pastoralNote.findFirst.mockResolvedValue({
        ...mockNote,
        author_id: 'other-member',
      });
      prisma.pastoralNote.update.mockResolvedValue(mockNote);

      await expect(
        service.updateNote('note-1', { content: 'Admin update' }, mockChurchId, mockUserId, [
          'pastoral_confidential:read',
          'pastoral_restricted:read',
          'pastoral_moderation:update',
          'pastoral_moderation:delete',
        ]),
      ).resolves.toBeDefined();
    });

    it('should throw ForbiddenException for non-author/non-admin', async () => {
      prisma.pastoralNote.findFirst.mockResolvedValue({
        ...mockNote,
        author_id: 'other-member',
      });

      await expect(
        service.updateNote('note-1', { content: 'Unauthorized update' }, mockChurchId, mockUserId, [
          'pastoral_confidential:read',
        ]),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw NotFoundException when updating an archived note', async () => {
      prisma.pastoralNote.findFirst.mockResolvedValue({
        ...mockNote,
        archived_at: new Date('2026-07-25T10:00:00.000Z'),
      });

      await expect(
        service.updateNote('note-1', { content: 'Attempted update' }, mockChurchId, mockUserId, [
          'pastoral_confidential:read',
          'pastoral_restricted:read',
          'pastoral_moderation:update',
          'pastoral_moderation:delete',
        ]),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('deleteNote', () => {
    it('should delete a note (author)', async () => {
      prisma.pastoralNote.findFirst.mockResolvedValue(mockNote);
      prisma.pastoralNote.delete.mockResolvedValue(mockNote);

      await service.deleteNote('note-1', mockChurchId, mockUserId, ['pastoral_confidential:read']);

      expect(prisma.pastoralNote.delete).toHaveBeenCalled();
      expect(auditLog).toHaveBeenCalled();
    });

    it('should throw ForbiddenException for restricted notes (non-admin)', async () => {
      prisma.pastoralNote.findFirst.mockResolvedValue({
        ...mockNote,
        confidentiality: 'restricted',
      });

      await expect(
        service.deleteNote('note-1', mockChurchId, mockUserId, ['pastoral_confidential:read']),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('listNotes', () => {
    it('should return paginated notes', async () => {
      prisma.pastoralNote.findMany.mockResolvedValue([mockNote]);
      prisma.pastoralNote.count.mockResolvedValue(1);

      const result = await service.listNotes(
        { page: 1, limit: 10 },
        mockChurchId,
        ['pastoral_confidential:read'],
        mockUserId,
      );

      expect(result.data).toHaveLength(1);
      expect(result.meta.total).toBe(1);
    });

    it('should exclude archived notes from the default (active-only) list', async () => {
      prisma.pastoralNote.findMany.mockResolvedValue([]);
      prisma.pastoralNote.count.mockResolvedValue(0);

      await service.listNotes(
        { page: 1, limit: 10 },
        mockChurchId,
        ['pastoral_confidential:read'],
        mockUserId,
      );

      expect(prisma.pastoralNote.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ church_id: mockChurchId, archived_at: null }),
        }),
      );
    });

    it('should list archived notes only when archived is true', async () => {
      prisma.pastoralNote.findMany.mockResolvedValue([
        { ...mockNote, archived_at: new Date('2026-07-25T10:00:00.000Z') },
      ]);
      prisma.pastoralNote.count.mockResolvedValue(1);

      const result = await service.listNotes(
        { page: 1, limit: 10, archived: true },
        mockChurchId,
        ['pastoral_confidential:read'],
        mockUserId,
      );

      expect(prisma.pastoralNote.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ archived_at: { not: null } }),
        }),
      );
      expect(result.data[0].archivedAt).toBeDefined();
    });
  });

  describe('archiveNote', () => {
    it('should archive a note and audit the ARCHIVE action', async () => {
      const plaintext = 'Note to archive';
      prisma.pastoralNote.findFirst.mockResolvedValue({
        ...mockNote,
        content: service.encrypt(plaintext),
      });
      prisma.pastoralNote.update.mockResolvedValue({
        ...mockNote,
        content: service.encrypt(plaintext),
        archived_at: new Date('2026-07-25T10:00:00.000Z'),
      });

      const result = await service.archiveNote('note-1', mockChurchId, mockUserId);

      expect(result.archivedAt).toBeDefined();
      expect(result.content).toBe(plaintext);
      expect(prisma.pastoralNote.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'note-1' },
          data: expect.objectContaining({ archived_at: expect.any(Date) }),
        }),
      );
      expect(auditLog).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'pastoral_note', action: 'ARCHIVE' }),
      );
    });

    it('should throw NotFoundException if note is missing or not in this church', async () => {
      prisma.pastoralNote.findFirst.mockResolvedValue(null);

      await expect(service.archiveNote('note-1', mockChurchId, mockUserId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw ConflictException if note is already archived', async () => {
      prisma.pastoralNote.findFirst.mockResolvedValue({
        ...mockNote,
        archived_at: new Date('2026-07-25T10:00:00.000Z'),
      });

      await expect(service.archiveNote('note-1', mockChurchId, mockUserId)).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('restoreNote', () => {
    it('should restore an archived note and audit the RESTORE action', async () => {
      const plaintext = 'Note to restore';
      prisma.pastoralNote.findFirst.mockResolvedValue({
        ...mockNote,
        content: service.encrypt(plaintext),
        archived_at: new Date('2026-07-25T10:00:00.000Z'),
      });
      prisma.pastoralNote.update.mockResolvedValue({
        ...mockNote,
        content: service.encrypt(plaintext),
      });

      const result = await service.restoreNote('note-1', mockChurchId, mockUserId);

      expect(result.archivedAt).toBeUndefined();
      expect(result.content).toBe(plaintext);
      expect(prisma.pastoralNote.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'note-1' },
          data: expect.objectContaining({ archived_at: null }),
        }),
      );
      expect(auditLog).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'pastoral_note', action: 'RESTORE' }),
      );
    });

    it('should throw NotFoundException if note is missing or not in this church', async () => {
      prisma.pastoralNote.findFirst.mockResolvedValue(null);

      await expect(service.restoreNote('note-1', mockChurchId, mockUserId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw ConflictException if note is not archived', async () => {
      prisma.pastoralNote.findFirst.mockResolvedValue(mockNote);

      await expect(service.restoreNote('note-1', mockChurchId, mockUserId)).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('life-event archive', () => {
    const mockLifeEvent = {
      id: 'event-1',
      church_id: mockChurchId,
      member_id: mockMemberId,
      type: 'birthday',
      date: new Date('2026-08-01'),
      details: {},
      notified: false,
      created_at: new Date('2026-07-01'),
      member: { first_name: 'John', last_name: 'Doe' },
    };

    it('should archive a life event and audit the ARCHIVE action', async () => {
      prisma.lifeEvent.findFirst.mockResolvedValue(mockLifeEvent);
      prisma.lifeEvent.update.mockResolvedValue({
        ...mockLifeEvent,
        archived_at: new Date('2026-07-25T10:00:00.000Z'),
      });

      const result = await service.archiveLifeEvent('event-1', mockChurchId, mockUserId);

      expect(result.archivedAt).toBeDefined();
      expect(prisma.lifeEvent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'event-1' },
          data: expect.objectContaining({ archived_at: expect.any(Date) }),
        }),
      );
      expect(auditLog).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'life_event', action: 'ARCHIVE' }),
      );
    });

    it('should throw NotFoundException if life event is missing', async () => {
      prisma.lifeEvent.findFirst.mockResolvedValue(null);

      await expect(service.archiveLifeEvent('event-1', mockChurchId, mockUserId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw ConflictException if life event is already archived', async () => {
      prisma.lifeEvent.findFirst.mockResolvedValue({
        ...mockLifeEvent,
        archived_at: new Date('2026-07-25T10:00:00.000Z'),
      });

      await expect(service.archiveLifeEvent('event-1', mockChurchId, mockUserId)).rejects.toThrow(
        ConflictException,
      );
    });

    it('should restore a life event and audit the RESTORE action', async () => {
      prisma.lifeEvent.findFirst.mockResolvedValue({
        ...mockLifeEvent,
        archived_at: new Date('2026-07-25T10:00:00.000Z'),
      });
      prisma.lifeEvent.update.mockResolvedValue(mockLifeEvent);

      const result = await service.restoreLifeEvent('event-1', mockChurchId, mockUserId);

      expect(result.archivedAt).toBeUndefined();
      expect(prisma.lifeEvent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'event-1' },
          data: expect.objectContaining({ archived_at: null }),
        }),
      );
      expect(auditLog).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'life_event', action: 'RESTORE' }),
      );
    });

    it('should throw ConflictException if life event is not archived', async () => {
      prisma.lifeEvent.findFirst.mockResolvedValue(mockLifeEvent);

      await expect(service.restoreLifeEvent('event-1', mockChurchId, mockUserId)).rejects.toThrow(
        ConflictException,
      );
    });

    it('should filter archived life events out of getUpcomingLifeEvents', async () => {
      prisma.lifeEvent.findMany.mockResolvedValue([]);

      await service.getUpcomingLifeEvents(mockChurchId, 30);

      expect(prisma.lifeEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ archived_at: null }),
        }),
      );
    });
  });
  describe('pastoral visibility and historical data contracts', () => {
    it.each([
      ['pastoral_confidential:read'],
      ['pastoral_restricted:read'],
      ['pastoral_confidential:read', 'pastoral_restricted:read'],
    ])(
      'applies explicit confidentiality grants to filtered note pages (%j)',
      async (...permissions) => {
        prisma.pastoralNote.findMany.mockResolvedValue([
          {
            ...mockNote,
            content: service.encrypt('Private note'),
            member: null,
            author: null,
            tags: null,
          },
        ]);
        prisma.pastoralNote.count.mockResolvedValue(1);
        const result = await service.listNotes(
          {
            page: 2,
            limit: 5,
            archived: true,
            memberId: mockMemberId,
            authorId: 'author',
            confidentiality: 'restricted',
            tags: ['care'],
            sortBy: 'updated_at',
            sortOrder: 'asc',
          },
          mockChurchId,
          permissions,
          mockUserId,
        );
        const args = prisma.pastoralNote.findMany.mock.calls[0][0];
        expect(args).toMatchObject({
          skip: 5,
          take: 5,
          orderBy: { updated_at: 'asc' },
          where: {
            church_id: mockChurchId,
            archived_at: { not: null },
            member_id: mockMemberId,
            author_id: 'author',
            confidentiality: 'restricted',
            tags: { hasSome: ['care'] },
          },
        });
        expect(args.where.AND.OR).toContainEqual({ confidentiality: 'standard' });
        if (permissions.includes('pastoral_restricted:read'))
          expect(args.where.AND.OR).toContainEqual({ confidentiality: 'restricted' });
        expect(result.data[0]).toMatchObject({
          content: 'Private note',
          memberFirstName: '',
          memberLastName: '',
          authorFirstName: '',
          authorLastName: '',
          tags: [],
        });
      },
    );
    it('updates confidentiality and clears tags without corrupting stored encrypted content', async () => {
      const content = service.encrypt('Original');
      prisma.pastoralNote.findFirst.mockResolvedValue({ ...mockNote, content });
      prisma.pastoralNote.update.mockResolvedValue({
        ...mockNote,
        content,
        confidentiality: 'confidential',
        tags: [],
      });
      const result = await service.updateNote(
        'note-1',
        { confidentiality: 'confidential', tags: [] },
        mockChurchId,
        mockUserId,
        [],
      );
      expect(prisma.pastoralNote.update.mock.calls[0][0].data).toEqual({
        confidentiality: 'confidential',
        tags: [],
      });
      expect(result.content).toBe('Original');
      expect(auditLog).toHaveBeenCalledWith(
        expect.objectContaining({ newValues: { updatedFields: ['confidentiality', 'tags'] } }),
      );
    });
    it('permits a confidential note detail only with its explicit grant', async () => {
      prisma.pastoralNote.findFirst.mockResolvedValue({
        ...mockNote,
        confidentiality: 'confidential',
        author_id: 'different-author',
        content: service.encrypt('Sensitive'),
      });
      expect(
        (
          await service.getNoteById(
            'note-1',
            mockChurchId,
            ['pastoral_confidential:read'],
            mockUserId,
          )
        ).content,
      ).toBe('Sensitive');
      await expect(service.getNoteById('note-1', mockChurchId, [], mockUserId)).rejects.toThrow(
        ForbiddenException,
      );
    });
    it.each(['update', 'delete'])('hides a missing note before %s mutations', async (operation) => {
      prisma.pastoralNote.findFirst.mockResolvedValue(null);
      await expect(
        operation === 'update'
          ? service.updateNote('missing', { tags: [] }, mockChurchId, mockUserId, [])
          : service.deleteNote('missing', mockChurchId, mockUserId, []),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.pastoralNote.update).not.toHaveBeenCalled();
      expect(prisma.pastoralNote.delete).not.toHaveBeenCalled();
    });
    it.each([
      {},
      {
        page: 2,
        limit: 5,
        memberId: mockMemberId,
        type: 'birthday',
        upcoming: 'true',
        archived: true,
        sortBy: 'created_at',
        sortOrder: 'desc' as const,
      },
    ])('keeps nullable historical life events readable with filters (%j)', async (query) => {
      prisma.lifeEvent.findMany.mockResolvedValue([
        {
          id: 'life',
          church_id: mockChurchId,
          member_id: mockMemberId,
          type: 'birthday',
          date: new Date('2026-01-01'),
          details: null,
          member: null,
          created_at: new Date('2026-01-01'),
        },
      ]);
      prisma.lifeEvent.count.mockResolvedValue(1);
      const result = await service.listLifeEvents(query, mockChurchId);
      expect(result.data[0]).toMatchObject({
        memberFirstName: '',
        memberLastName: '',
        details: {},
      });
      const args = prisma.lifeEvent.findMany.mock.calls[0][0];
      expect(args.where.church_id).toBe(mockChurchId);
      expect(args.where.archived_at).toEqual(query.archived ? { not: null } : null);
      if (query.upcoming) expect(args.where.date.gte).toBeInstanceOf(Date);
      expect(result.meta.page).toBe(query.page ?? 1);
      expect(result.meta.limit).toBe(query.limit ?? 20);
    });
    it('rejects life events for missing or foreign members', async () => {
      prisma.member.findFirst.mockResolvedValue(null);
      await expect(
        service.createLifeEvent(
          { memberId: 'foreign', type: 'birthday', date: '2026-01-01' },
          mockChurchId,
          mockUserId,
        ),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.lifeEvent.create).not.toHaveBeenCalled();
    });
  });
});
