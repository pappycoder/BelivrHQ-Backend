import { BranchScopeService } from '../../../src/common/services/branch-scope.service';
import { RequestContextService } from '../../../src/common/services/request-context.service';
/**
 * @file templates.service.spec.ts
 * @description Unit tests for TemplatesService.
 *
 * Tests template CRUD with WhatsApp-specific fields and pagination.
 *
 * @module test/unit/templates/templates.service.spec
 * @since 1.0.0
 */

import { TemplatesService } from '../../../src/templates/templates.service';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { AuditLoggingService } from '../../../src/common/services/audit-logging.service';
import { createPrismaMock } from '../../helpers/prisma-mock.helper';
import { NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';

describe('TemplatesService', () => {
  let service: TemplatesService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let audit: { log: jest.Mock };

  const mockChurchId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const mockUserId = '11111111-1111-1111-1111-111111111111';
  const mockTemplateId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

  const mockTemplate = {
    id: mockTemplateId,
    church_id: mockChurchId,
    name: 'Welcome Message',
    content: 'Hello {{name}}, welcome to {{church}}!',
    channel: 'whatsapp',
    language: 'en',
    status: 'published',
    category: 'MARKETING',
    variables: ['name', 'church'],
    external_id: 'churchos:welcome_message',
    external_status: 'APPROVED',
    created_at: new Date('2026-07-20T10:00:00.000Z'),
    updated_at: new Date('2026-07-20T10:00:00.000Z'),
  };

  beforeEach(() => {
    prisma = createPrismaMock();
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    service = new TemplatesService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditLoggingService,
      new BranchScopeService(new RequestContextService()),
    );
  });

  describe('create', () => {
    it('should create a WhatsApp template with new fields', async () => {
      prisma.template.create.mockResolvedValue(mockTemplate);

      const result = await service.create(
        {
          name: 'Welcome Message',
          content: 'Hello {{name}}, welcome to {{church}}!',
          channel: 'whatsapp',
          category: 'MARKETING',
          variables: ['name', 'church'],
          externalId: 'churchos:welcome_message',
        },
        mockChurchId,
        mockUserId,
      );

      expect(result.channel).toBe('whatsapp');
      expect(result.category).toBe('MARKETING');
      expect(result.variables).toEqual(['name', 'church']);
      expect(result.externalId).toBe('churchos:welcome_message');
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'template', action: 'CREATE' }),
      );
    });

    it('should default status to draft when omitted', async () => {
      prisma.template.create.mockResolvedValue({ ...mockTemplate, status: 'draft' });

      await service.create(
        {
          name: 'Draft Template',
          content: 'Hello!',
          channel: 'sms',
        },
        mockChurchId,
        mockUserId,
      );

      expect(prisma.template.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'draft' }),
        }),
      );
    });

    it('should create a template as published when status is set', async () => {
      prisma.template.create.mockResolvedValue({ ...mockTemplate, status: 'published' });

      const result = await service.create(
        {
          name: 'Published Template',
          content: 'Hello!',
          channel: 'sms',
          status: 'published',
        },
        mockChurchId,
        mockUserId,
      );

      expect(result.status).toBe('published');
      expect(prisma.template.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'published' }),
        }),
      );
    });
  });

  describe('findAll', () => {
    it.each([
      ['name', 'name'],
      ['createdAt', 'created_at'],
      ['updatedAt', 'updated_at'],
      ['channel', 'channel'],
      ['status', 'status'],
    ] as const)(
      'sorts %s before pagination while preserving filters and branch scope',
      async (sortBy, field) => {
        prisma.template.findMany.mockResolvedValue([]);
        prisma.template.count.mockResolvedValue(0);
        await service.findAll(
          mockChurchId,
          {
            page: 2,
            limit: 12,
            sortBy,
            sortOrder: 'desc',
            search: 'welcome',
            channel: 'email',
            status: 'published',
            branchId: 'other-branch',
          },
          { church_id: mockChurchId, branch_id: 'own-branch', role: 'secretary' },
        );
        const query = prisma.template.findMany.mock.calls[0][0];
        expect(query).toMatchObject({
          skip: 12,
          take: 12,
          orderBy: [{ [field]: 'desc' }, { id: 'asc' }],
          where: {
            church_id: mockChurchId,
            archived_at: null,
            channel: 'email',
            status: 'published',
            AND: [{ OR: [{ branch_id: 'own-branch' }, { branch_id: null }] }],
            OR: [
              { name: { contains: 'welcome', mode: 'insensitive' } },
              { content: { contains: 'welcome', mode: 'insensitive' } },
            ],
          },
        });
        expect(prisma.template.count).toHaveBeenCalledWith({ where: query.where });
      },
    );

    it('should return paginated templates', async () => {
      prisma.template.findMany.mockResolvedValue([mockTemplate]);
      prisma.template.count.mockResolvedValue(1);

      const result = await service.findAll(mockChurchId, {});

      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.data[0].externalStatus).toBe('APPROVED');
    });

    it('should filter by channel', async () => {
      prisma.template.findMany.mockResolvedValue([]);
      prisma.template.count.mockResolvedValue(0);

      await service.findAll(mockChurchId, { channel: 'whatsapp' });

      expect(prisma.template.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ channel: 'whatsapp' }),
        }),
      );
    });

    it('should exclude archived templates by default', async () => {
      prisma.template.findMany.mockResolvedValue([]);
      prisma.template.count.mockResolvedValue(0);

      await service.findAll(mockChurchId, {});

      expect(prisma.template.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ archived_at: null }) }),
      );
    });

    it('should list only archived templates when archived=true', async () => {
      prisma.template.findMany.mockResolvedValue([
        { ...mockTemplate, archived_at: new Date('2026-08-28T10:00:00.000Z') },
      ]);
      prisma.template.count.mockResolvedValue(1);

      const result = await service.findAll(mockChurchId, { archived: true });

      expect(prisma.template.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ archived_at: { not: null } }) }),
      );
      expect(result.data[0].archivedAt).toBe('2026-08-28T10:00:00.000Z');
    });
  });

  describe('update', () => {
    it('should update WhatsApp template fields', async () => {
      prisma.template.findFirst.mockResolvedValue(mockTemplate);
      prisma.template.update.mockResolvedValue({
        ...mockTemplate,
        external_status: 'PENDING',
      });

      const result = await service.update(
        mockTemplateId,
        { externalStatus: 'PENDING' },
        mockChurchId,
        mockUserId,
      );

      expect(result.externalStatus).toBe('PENDING');
    });

    it('should throw NotFoundException if template not found', async () => {
      prisma.template.findFirst.mockResolvedValue(null);

      await expect(
        service.update(mockTemplateId, { name: 'X' }, mockChurchId, mockUserId),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException when updating an archived template', async () => {
      prisma.template.findFirst.mockResolvedValue({
        ...mockTemplate,
        archived_at: new Date('2026-08-28T10:00:00.000Z'),
      });

      await expect(
        service.update(mockTemplateId, { name: 'X' }, mockChurchId, mockUserId),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('delete', () => {
    it('should delete a template', async () => {
      prisma.template.findFirst.mockResolvedValue(mockTemplate);

      await service.delete(mockTemplateId, mockChurchId, mockUserId);

      expect(prisma.template.delete).toHaveBeenCalledWith({
        where: { id: mockTemplateId },
      });
    });

    it('should still hard-delete (purge) an archived template', async () => {
      prisma.template.findFirst.mockResolvedValue({
        ...mockTemplate,
        archived_at: new Date('2026-08-28T10:00:00.000Z'),
      });

      await service.delete(mockTemplateId, mockChurchId, mockUserId);

      expect(prisma.template.delete).toHaveBeenCalled();
    });
  });

  describe('publish', () => {
    const draftTemplate = { ...mockTemplate, status: 'draft' };

    it('should publish a draft template', async () => {
      prisma.template.findFirst.mockResolvedValue(draftTemplate);
      prisma.template.update.mockResolvedValue({ ...draftTemplate, status: 'published' });

      const result = await service.publish(mockTemplateId, mockChurchId, mockUserId);

      expect(result.status).toBe('published');
      expect(prisma.template.update).toHaveBeenCalledWith({
        include: { branch: { select: { name: true } } },
        where: { id: mockTemplateId },
        data: { status: 'published' },
      });
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entity: 'template',
          action: 'UPDATE',
          oldValues: { status: 'draft' },
          newValues: { status: 'published' },
        }),
      );
    });

    it('should throw BadRequestException if template is already published', async () => {
      prisma.template.findFirst.mockResolvedValue(mockTemplate);

      await expect(service.publish(mockTemplateId, mockChurchId, mockUserId)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException if template is archived', async () => {
      prisma.template.findFirst.mockResolvedValue({ ...mockTemplate, status: 'archived' });

      await expect(service.publish(mockTemplateId, mockChurchId, mockUserId)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw NotFoundException if template not found', async () => {
      prisma.template.findFirst.mockResolvedValue(null);

      await expect(service.publish(mockTemplateId, mockChurchId, mockUserId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('archive', () => {
    it('should set archived_at and audit ARCHIVE', async () => {
      const archivedAt = new Date('2026-08-28T12:00:00.000Z');
      prisma.template.findFirst.mockResolvedValue(mockTemplate);
      prisma.template.update.mockResolvedValue({ ...mockTemplate, archived_at: archivedAt });

      const result = await service.archive(mockTemplateId, mockChurchId, mockUserId);

      expect(prisma.template.update).toHaveBeenCalledWith({
        include: { branch: { select: { name: true } } },
        where: { id: mockTemplateId },
        data: { archived_at: expect.any(Date) },
      });
      expect(result.archivedAt).toBe(archivedAt.toISOString());
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'ARCHIVE', entity: 'template' }),
      );
    });

    it('should throw ConflictException when already archived', async () => {
      prisma.template.findFirst.mockResolvedValue({
        ...mockTemplate,
        archived_at: new Date(),
      });

      await expect(service.archive(mockTemplateId, mockChurchId, mockUserId)).rejects.toThrow(
        ConflictException,
      );
    });

    it('should throw NotFoundException if template not found', async () => {
      prisma.template.findFirst.mockResolvedValue(null);

      await expect(service.archive(mockTemplateId, mockChurchId, mockUserId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('restore', () => {
    it('should clear archived_at and audit RESTORE', async () => {
      prisma.template.findFirst.mockResolvedValue({
        ...mockTemplate,
        archived_at: new Date('2026-08-27T12:00:00.000Z'),
      });
      prisma.template.update.mockResolvedValue(mockTemplate);

      const result = await service.restore(mockTemplateId, mockChurchId, mockUserId);

      expect(prisma.template.update).toHaveBeenCalledWith({
        include: { branch: { select: { name: true } } },
        where: { id: mockTemplateId },
        data: { archived_at: null },
      });
      expect(result.archivedAt).toBeUndefined();
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'RESTORE', entity: 'template' }),
      );
    });

    it('should throw ConflictException when not archived', async () => {
      prisma.template.findFirst.mockResolvedValue(mockTemplate);

      await expect(service.restore(mockTemplateId, mockChurchId, mockUserId)).rejects.toThrow(
        ConflictException,
      );
    });

    it('should throw NotFoundException if template not found', async () => {
      prisma.template.findFirst.mockResolvedValue(null);

      await expect(service.restore(mockTemplateId, mockChurchId, mockUserId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('publish guard on archived templates', () => {
    it('should throw NotFoundException when publishing an archived template', async () => {
      prisma.template.findFirst.mockResolvedValue({
        ...mockTemplate,
        status: 'draft',
        archived_at: new Date(),
      });

      await expect(service.publish(mockTemplateId, mockChurchId, mockUserId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
