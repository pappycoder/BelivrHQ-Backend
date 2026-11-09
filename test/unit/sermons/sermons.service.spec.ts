import { BranchScopeService } from '../../../src/common/services/branch-scope.service';
import { RequestContextService } from '../../../src/common/services/request-context.service';
/**
 * @file sermons.service.spec.ts
 * @description Unit tests for SermonsService.
 *
 * Tests sermon CRUD, search, filtering, and pagination.
 *
 * @module test/unit/sermons/sermons.service.spec
 * @since 1.0.0
 */

import { SermonsService } from '../../../src/sermons/sermons.service';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { AuditLoggingService } from '../../../src/common/services/audit-logging.service';
import { NotFoundException, ConflictException } from '@nestjs/common';
import { createPrismaMock } from '../../helpers/prisma-mock.helper';

describe('SermonsService', () => {
  let service: SermonsService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let audit: { log: jest.Mock };

  const mockChurchId = '11111111-1111-1111-1111-111111111111';
  const mockUserId = '22222222-2222-2222-2222-222222222222';
  const mockSermonId = '77777777-7777-7777-7777-777777777777';

  const mockSermon = {
    id: mockSermonId,
    church_id: mockChurchId,
    title: 'Walking in Faith',
    speaker: 'Pastor John Doe',
    sermon_date: new Date('2026-07-20T09:00:00.000Z'),
    scripture_reference: 'Hebrews 11:1-6',
    series_name: 'Faith Foundations',
    tags: ['faith', 'trust'],
    audio_url: null,
    duration_seconds: 2400,
    description: 'A sermon about faith',
    archived_at: null,
    created_at: new Date('2026-07-20T10:00:00.000Z'),
    updated_at: new Date('2026-07-20T10:00:00.000Z'),
  };

  it('returns only distinct names for form suggestions using the same viewer scope', async () => {
    const viewer = { church_id: 'church', branch_id: 'branch', role: 'media_team' };
    const speakers = jest.spyOn(service, 'listSpeakers').mockResolvedValue([
      { name: 'Pastor John', count: 4, lastDate: '2026-01-01' },
      { name: ' Pastor Ada ', count: 2, lastDate: '2026-01-02' },
      { name: 'Pastor John', count: 1, lastDate: '2026-01-01' },
      { name: '  ', count: 1, lastDate: '' },
    ]);
    const series = jest
      .spyOn(service, 'listSeries')
      .mockResolvedValue([{ name: 'Faith Foundations', count: 3, lastDate: '2026-01-01' }]);
    expect(await service.formOptions('church', viewer)).toEqual({
      speakers: ['Pastor Ada', 'Pastor John'],
      series: ['Faith Foundations'],
    });
    expect(speakers).toHaveBeenCalledWith('church', viewer);
    expect(series).toHaveBeenCalledWith('church', viewer);
  });

  beforeEach(() => {
    prisma = createPrismaMock();
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    service = new SermonsService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditLoggingService,
      new BranchScopeService(new RequestContextService()),
    );
  });

  describe('createSermon', () => {
    it('should create a sermon and return SermonResponseDto', async () => {
      prisma.sermon.create.mockResolvedValue(mockSermon);

      const result = await service.createSermon(
        {
          title: 'Walking in Faith',
          speaker: 'Pastor John Doe',
          sermonDate: '2026-07-20T09:00:00.000Z',
          scriptureReference: 'Hebrews 11:1-6',
          seriesName: 'Faith Foundations',
          tags: ['faith', 'trust'],
          durationSeconds: 2400,
        },
        mockChurchId,
        mockUserId,
      );

      expect(result.sermonId).toBe(mockSermonId);
      expect(result.title).toBe('Walking in Faith');
      expect(result.speaker).toBe('Pastor John Doe');
      expect(result.tags).toEqual(['faith', 'trust']);
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'sermon', action: 'CREATE' }),
      );
    });
  });

  describe('listSermons', () => {
    it('should return paginated sermons', async () => {
      prisma.sermon.findMany.mockResolvedValue([mockSermon]);
      prisma.sermon.count.mockResolvedValue(1);

      const result = await service.listSermons({}, mockChurchId);

      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.data[0].sermonId).toBe(mockSermonId);
    });

    it('should filter by speaker', async () => {
      prisma.sermon.findMany.mockResolvedValue([]);
      prisma.sermon.count.mockResolvedValue(0);

      await service.listSermons({ speaker: 'Pastor John' }, mockChurchId);

      expect(prisma.sermon.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            speaker: expect.objectContaining({ contains: 'Pastor John' }),
          }),
        }),
      );
    });

    it('should filter by tag', async () => {
      prisma.sermon.findMany.mockResolvedValue([]);
      prisma.sermon.count.mockResolvedValue(0);

      await service.listSermons({ tag: 'faith' }, mockChurchId);

      expect(prisma.sermon.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ tags: { has: 'faith' } }),
        }),
      );
    });

    it('should search across multiple fields', async () => {
      prisma.sermon.findMany.mockResolvedValue([]);
      prisma.sermon.count.mockResolvedValue(0);

      await service.listSermons({ search: 'faith' }, mockChurchId);

      expect(prisma.sermon.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.arrayContaining([
              expect.objectContaining({ title: expect.objectContaining({ contains: 'faith' }) }),
            ]),
          }),
        }),
      );
    });

    it('should default to excluding archived sermons (archived_at null)', async () => {
      prisma.sermon.findMany.mockResolvedValue([]);
      prisma.sermon.count.mockResolvedValue(0);

      await service.listSermons({}, mockChurchId);

      expect(prisma.sermon.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ archived_at: null }),
        }),
      );
    });

    it('should list only archived sermons when archived=true and map archivedAt', async () => {
      const archived = { ...mockSermon, archived_at: new Date('2026-08-01T00:00:00.000Z') };
      prisma.sermon.findMany.mockResolvedValue([archived]);
      prisma.sermon.count.mockResolvedValue(1);

      const result = await service.listSermons({ archived: true }, mockChurchId);

      expect(prisma.sermon.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ archived_at: { not: null } }),
        }),
      );
      expect(result.data[0].archivedAt).toBe('2026-08-01T00:00:00.000Z');
    });
  });

  describe('getSermon', () => {
    it('should return sermon by ID', async () => {
      prisma.sermon.findFirst.mockResolvedValue(mockSermon);

      const result = await service.getSermon(mockSermonId, mockChurchId);

      expect(result.sermonId).toBe(mockSermonId);
      expect(result.title).toBe('Walking in Faith');
    });

    it('should throw NotFoundException if sermon not found', async () => {
      prisma.sermon.findFirst.mockResolvedValue(null);

      await expect(service.getSermon('nonexistent', mockChurchId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('updateSermon', () => {
    it('should update sermon fields', async () => {
      prisma.sermon.findFirst.mockResolvedValue(mockSermon);
      prisma.sermon.update.mockResolvedValue({ ...mockSermon, title: 'Updated Title' });

      const result = await service.updateSermon(
        mockSermonId,
        { title: 'Updated Title' },
        mockChurchId,
        mockUserId,
      );

      expect(result.title).toBe('Updated Title');
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'sermon', action: 'UPDATE' }),
      );
    });

    it('should throw NotFoundException if sermon not found', async () => {
      prisma.sermon.findFirst.mockResolvedValue(null);

      await expect(
        service.updateSermon('nonexistent', { title: 'X' }, mockChurchId, mockUserId),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException when updating an archived sermon', async () => {
      prisma.sermon.findFirst.mockResolvedValue({
        ...mockSermon,
        archived_at: new Date('2026-08-01T00:00:00.000Z'),
      });

      await expect(
        service.updateSermon(mockSermonId, { title: 'X' }, mockChurchId, mockUserId),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.sermon.update).not.toHaveBeenCalled();
    });
  });

  describe('deleteSermon', () => {
    it('should delete a sermon', async () => {
      prisma.sermon.findFirst.mockResolvedValue(mockSermon);
      prisma.sermon.delete.mockResolvedValue(mockSermon);

      await service.deleteSermon(mockSermonId, mockChurchId, mockUserId);

      expect(prisma.sermon.delete).toHaveBeenCalledWith({ where: { id: mockSermonId } });
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'sermon', action: 'DELETE' }),
      );
    });

    it('should throw NotFoundException if sermon not found', async () => {
      prisma.sermon.findFirst.mockResolvedValue(null);

      await expect(service.deleteSermon('nonexistent', mockChurchId, mockUserId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should purge (hard delete) an archived sermon', async () => {
      const archived = { ...mockSermon, archived_at: new Date('2026-08-01T00:00:00.000Z') };
      prisma.sermon.findFirst.mockResolvedValue(archived);
      prisma.sermon.delete.mockResolvedValue(archived);

      await service.deleteSermon(mockSermonId, mockChurchId, mockUserId);

      expect(prisma.sermon.delete).toHaveBeenCalledWith({ where: { id: mockSermonId } });
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'sermon', action: 'DELETE' }),
      );
    });
  });

  describe('archiveSermon', () => {
    it('should archive a sermon and audit ARCHIVE', async () => {
      prisma.sermon.findFirst.mockResolvedValue(mockSermon);
      const archived = { ...mockSermon, archived_at: new Date('2026-08-01T00:00:00.000Z') };
      prisma.sermon.update.mockResolvedValue(archived);

      const result = await service.archiveSermon(mockSermonId, mockChurchId, mockUserId);

      expect(prisma.sermon.update).toHaveBeenCalledWith({
        include: { branch: { select: { name: true } } },
        where: { id: mockSermonId },
        data: { archived_at: expect.any(Date) },
      });
      expect(result.archivedAt).toBe('2026-08-01T00:00:00.000Z');
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'sermon', action: 'ARCHIVE' }),
      );
    });

    it('should throw ConflictException when already archived', async () => {
      prisma.sermon.findFirst.mockResolvedValue({
        ...mockSermon,
        archived_at: new Date('2026-08-01T00:00:00.000Z'),
      });

      await expect(service.archiveSermon(mockSermonId, mockChurchId, mockUserId)).rejects.toThrow(
        ConflictException,
      );
    });

    it('should throw NotFoundException when missing', async () => {
      prisma.sermon.findFirst.mockResolvedValue(null);

      await expect(service.archiveSermon('nonexistent', mockChurchId, mockUserId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('restoreSermon', () => {
    it('should restore an archived sermon and audit RESTORE', async () => {
      prisma.sermon.findFirst.mockResolvedValue({
        ...mockSermon,
        archived_at: new Date('2026-08-01T00:00:00.000Z'),
      });
      prisma.sermon.update.mockResolvedValue(mockSermon);

      const result = await service.restoreSermon(mockSermonId, mockChurchId, mockUserId);

      expect(prisma.sermon.update).toHaveBeenCalledWith({
        include: { branch: { select: { name: true } } },
        where: { id: mockSermonId },
        data: { archived_at: null },
      });
      expect(result.archivedAt).toBeUndefined();
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'sermon', action: 'RESTORE' }),
      );
    });

    it('should throw ConflictException when not archived', async () => {
      prisma.sermon.findFirst.mockResolvedValue(mockSermon);

      await expect(service.restoreSermon(mockSermonId, mockChurchId, mockUserId)).rejects.toThrow(
        ConflictException,
      );
    });

    it('should throw NotFoundException when missing', async () => {
      prisma.sermon.findFirst.mockResolvedValue(null);

      await expect(service.restoreSermon('nonexistent', mockChurchId, mockUserId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('setAudioUrl', () => {
    it('should set the audio URL on a sermon', async () => {
      prisma.sermon.findFirst.mockResolvedValue(mockSermon);
      prisma.sermon.update.mockResolvedValue({
        ...mockSermon,
        audio_url: 'https://storage.example.com/audio.mp3',
      });

      const result = await service.setAudioUrl(
        mockSermonId,
        'https://storage.example.com/audio.mp3',
        mockChurchId,
        mockUserId,
      );

      expect(result.audioUrl).toBe('https://storage.example.com/audio.mp3');
    });

    it('should throw NotFoundException if sermon not found', async () => {
      prisma.sermon.findFirst.mockResolvedValue(null);

      await expect(
        service.setAudioUrl('nonexistent', 'url', mockChurchId, mockUserId),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException when setting audio on an archived sermon', async () => {
      prisma.sermon.findFirst.mockResolvedValue({
        ...mockSermon,
        archived_at: new Date('2026-08-01T00:00:00.000Z'),
      });

      await expect(
        service.setAudioUrl(mockSermonId, 'url', mockChurchId, mockUserId),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.sermon.update).not.toHaveBeenCalled();
    });
  });
});
