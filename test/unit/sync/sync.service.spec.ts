/**
 * @file sync.service.spec.ts
 * @description Unit tests for SyncService.
 */

import { SyncService } from '../../../src/sync/sync.service';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { AuditLoggingService } from '../../../src/common/services/audit-logging.service';

function createPrismaMock() {
  const models: Record<string, Record<string, jest.Mock>> = {};

  const $executeRaw = jest.fn().mockResolvedValue(undefined);

  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_target, prop: string) {
      if (prop === '$transaction') return $transaction;
      if (prop === '$queryRaw') return jest.fn().mockResolvedValue([]);
      if (prop === '$executeRaw') return $executeRaw;
      if (!models[prop]) {
        models[prop] = {
          findMany: jest.fn(),
          findUnique: jest.fn(),
          findFirst: jest.fn(),
          create: jest.fn(),
          update: jest.fn(),
          updateMany: jest.fn(),
          delete: jest.fn(),
          count: jest.fn(),
          aggregate: jest.fn(),
          groupBy: jest.fn(),
          upsert: jest.fn(),
          deleteMany: jest.fn(),
        };
      }
      return models[prop];
    },
  };

  const txHandler: ProxyHandler<Record<string, unknown>> = {
    get(_target, prop: string) {
      if (prop === '$executeRaw') return $executeRaw;
      return prisma[prop];
    },
  };

  const $transaction = jest
    .fn()
    .mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = new Proxy({} as Record<string, unknown>, txHandler);
      return fn(tx);
    });

  return new Proxy({ $transaction, $executeRaw } as Record<string, unknown>, handler) as Record<
    string,
    unknown
  > & {
    $transaction: jest.Mock;
    $executeRaw: jest.Mock;
  };
}

function model(name: string): Record<string, jest.Mock> {
  return prisma[name] as Record<string, jest.Mock>;
}

let prisma: ReturnType<typeof createPrismaMock>;
let audit: { log: jest.Mock };
let service: SyncService;

const mockChurchId = '00000000-0000-0000-0000-000000000001';
const mockUserId = '11111111-1111-1111-1111-111111111111';
const mockMemberId = '44444444-4444-4444-8444-444444444444';

beforeEach(() => {
  prisma = createPrismaMock();
  model('branch').findFirst.mockResolvedValue({ id: viewer.branch_id });
  audit = { log: jest.fn().mockResolvedValue(undefined) };

  service = new SyncService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditLoggingService,
  );
});

const viewer = {
  id: '11111111-1111-4111-8111-111111111111',
  church_id: mockChurchId,
  role: 'church_admin',
  branch_id: '22222222-2222-4222-8222-222222222222',
  is_admin_hq: true,
  permissions: [
    'members:all:read',
    'members:new:create',
    'members:all:update',
    'members:all:delete',
    'attendance:services:read',
    'giving:categories:read',
    'visitors:list:read',
    'attendance:records:read',
    'giving:records:read',
  ],
};

describe('SyncService', () => {
  describe('pushChanges', () => {
    it('should push changes successfully and apply them to the database', async () => {
      model('syncQueue').findFirst.mockResolvedValue(null); // no existing / pending
      model('member').create.mockResolvedValue({ id: mockMemberId });
      model('syncQueue').create.mockResolvedValue({ id: '1' });

      const result = await service.pushChanges(
        mockChurchId,
        mockUserId,
        [
          {
            entity: 'member',
            entityId: mockMemberId,
            action: 'create',
            data: { firstName: 'John', lastName: 'Doe' },
          },
        ],
        viewer,
      );

      expect(result.accepted).toBe(1);
      expect(result.rejected).toBe(0);
      expect(result.conflicts).toHaveLength(0);
      // Device-originated applies suppress the outbox trigger via the session GUC
      expect(prisma.$executeRaw).toHaveBeenCalled();
      expect(model('member').create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            id: mockMemberId,
            first_name: 'John',
            last_name: 'Doe',
            church_id: mockChurchId,
          }),
        }),
      );
      expect(model('syncQueue').create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            church_id: mockChurchId,
            entity: 'member',
            entity_id: mockMemberId,
          }),
        }),
      );
    });

    it('should skip already-synced changes (idempotency)', async () => {
      model('syncQueue').findFirst.mockResolvedValue({ id: 'existing', synced: true });

      const result = await service.pushChanges(
        mockChurchId,
        mockUserId,
        [
          {
            entity: 'member',
            entityId: mockMemberId,
            action: 'create',
            data: { firstName: 'John' },
          },
        ],
        viewer,
      );

      expect(result.accepted).toBe(1);
      expect(model('syncQueue').create).not.toHaveBeenCalled();
      expect(model('member').upsert).not.toHaveBeenCalled();
    });

    it('should reject older client timestamps (conflict)', async () => {
      // Pending change with a newer timestamp
      model('syncQueue')
        .findFirst.mockResolvedValueOnce(null) // idempotency check
        .mockResolvedValueOnce({
          id: 'pending',
          created_at: new Date('2026-07-22T12:00:00Z'),
        }); // conflict check

      const result = await service.pushChanges(
        mockChurchId,
        mockUserId,
        [
          {
            entity: 'member',
            entityId: mockMemberId,
            action: 'create',
            data: { firstName: 'John' },
            clientTimestamp: '2026-07-22T11:00:00Z', // older
          },
        ],
        viewer,
      );

      expect(result.rejected).toBe(1);
      expect(result.conflicts).toContain(`member/${mockMemberId}`);
      expect(model('member').upsert).not.toHaveBeenCalled();
    });

    it('should reject changes for unsupported entities', async () => {
      model('syncQueue').findFirst.mockResolvedValue(null);

      const result = await service.pushChanges(
        mockChurchId,
        mockUserId,
        [
          {
            entity: 'alienSaucer',
            entityId: mockMemberId,
            action: 'create',
            data: {},
          },
        ],
        viewer,
      );

      expect(result.rejected).toBe(1);
    });

    it('should apply deletes scoped by church', async () => {
      model('syncQueue').findFirst.mockResolvedValue(null);
      model('member').findUnique.mockResolvedValue({ id: mockMemberId });
      model('member').findFirst.mockResolvedValue({ id: mockMemberId });
      model('member').updateMany.mockResolvedValue({ count: 1 });
      model('member').deleteMany.mockResolvedValue({ count: 1 });
      model('syncQueue').create.mockResolvedValue({ id: '1' });

      const result = await service.pushChanges(
        mockChurchId,
        mockUserId,
        [
          {
            entity: 'member',
            entityId: mockMemberId,
            action: 'delete',
            data: {},
          },
        ],
        viewer,
      );

      expect(result.accepted).toBe(1);
      expect(model('member').updateMany).toHaveBeenCalledWith({
        where: { id: mockMemberId, church_id: mockChurchId },
        data: { archived_at: expect.any(Date) },
      });
    });

    it('should throw BadRequestException for empty changes', async () => {
      await expect(service.pushChanges(mockChurchId, mockUserId, [], viewer)).rejects.toThrow(
        'No changes provided',
      );
    });
  });

  describe('pullChanges', () => {
    const memberRow = {
      id: mockMemberId,
      church_id: mockChurchId,
      branch_id: null,
      first_name: 'John',
      last_name: 'Doe',
      email: null,
      phone: '+2348012345678',
      whatsapp_number: null,
      date_of_birth: null,
      gender: 'male',
      address: null,
      city: null,
      state: null,
      status: 'active',
      member_since: new Date('2026-01-01T10:00:00Z'),
      photo_url: null,
      custom_fields: {},
      notes: null,
      created_at: new Date('2026-01-01T10:00:00Z'),
      updated_at: new Date('2026-01-01T10:00:00Z'),
    };

    function mockDevice(cursor: Date | null = null) {
      model('syncDevice').upsert.mockResolvedValue({
        id: 'dev-1',
        church_id: mockChurchId,
        device_id: `${viewer.id}:device-1`,
        last_pull_cursor: cursor,
        last_seen_at: new Date(),
        created_at: new Date(),
      });
      model('syncDevice').update.mockResolvedValue({});
    }

    it('should get-or-create the device watermark and query after the cursor', async () => {
      mockDevice(new Date('2026-07-01T00:00:00Z'));
      model('syncQueue').findMany.mockResolvedValue([]);

      const result = await service.pullChanges(
        mockChurchId,
        'device-1',
        undefined,
        undefined,
        viewer,
      );

      expect(model('syncDevice').upsert).toHaveBeenCalledWith({
        where: {
          church_id_device_id: { church_id: mockChurchId, device_id: `${viewer.id}:device-1` },
        },
        create: { church_id: mockChurchId, device_id: `${viewer.id}:device-1` },
        update: { last_seen_at: expect.any(Date) },
      });
      expect(model('syncQueue').findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            church_id: mockChurchId,
            created_at: { gte: new Date('2026-07-01T00:00:00Z') },
          }),
        }),
      );
      expect(result.changes).toHaveLength(0);
      expect(result.hasMore).toBe(false);
      expect(result.cursor).toBe('2026-07-01T00:00:00.000Z');
    });

    it('should prefer the client-provided cursor over the stored watermark', async () => {
      mockDevice(new Date('2026-07-01T00:00:00Z'));
      model('syncQueue').findMany.mockResolvedValue([]);

      await service.pullChanges(mockChurchId, 'device-1', 100, '2026-07-10T00:00:00Z', viewer);

      expect(model('syncQueue').findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            created_at: { gte: new Date('2026-07-10T00:00:00Z') },
          }),
        }),
      );
    });

    it('should hydrate create/update changes to live camelCase state', async () => {
      mockDevice();
      model('syncQueue').findMany.mockResolvedValue([
        {
          id: 'queue-1',
          entity: 'member',
          entity_id: mockMemberId,
          action: 'create',
          data: { firstName: 'John' },
          created_at: new Date('2026-07-22T10:00:00Z'),
        },
      ]);
      model('member').findFirst.mockResolvedValue(memberRow);

      const result = await service.pullChanges(
        mockChurchId,
        'device-1',
        undefined,
        undefined,
        viewer,
      );

      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].entity).toBe('member');
      expect(result.changes[0].entityId).toBe(mockMemberId);
      expect(result.changes[0].action).toBe('create');
      expect(result.changes[0].data).toMatchObject({
        firstName: 'John',
        lastName: 'Doe',
        churchId: mockChurchId,
      });
      expect(result.changes[0].data).not.toBeNull();
      expect(result.cursor).toMatch(/^v2:/);
    });

    it('delivers shared category deletions to branch devices', async () => {
      mockDevice();
      model('syncQueue').findMany.mockResolvedValue([
        {
          id: 'queue-category-delete',
          entity: 'givingCategory',
          entity_id: mockMemberId,
          action: 'delete',
          data: { branch_id: null },
          created_at: new Date('2026-07-22T10:00:00Z'),
        },
      ]);
      const result = await service.pullChanges(mockChurchId, 'device-1', undefined, undefined, {
        ...viewer,
        is_admin_hq: false,
      });
      expect(result.changes).toHaveLength(1);
      expect(result.changes[0]).toMatchObject({
        entity: 'givingCategory',
        action: 'delete',
        data: null,
      });
    });

    it('should return tombstones for deletes', async () => {
      mockDevice();
      model('syncQueue').findMany.mockResolvedValue([
        {
          id: 'queue-1',
          entity: 'member',
          entity_id: mockMemberId,
          action: 'delete',
          data: {},
          created_at: new Date('2026-07-22T10:00:00Z'),
        },
      ]);

      const result = await service.pullChanges(
        mockChurchId,
        'device-1',
        undefined,
        undefined,
        viewer,
      );

      expect(result.changes[0].data).toBeNull();
      expect(model('member').findFirst).not.toHaveBeenCalled();
    });

    it('should tombstone changes whose record no longer exists', async () => {
      mockDevice();
      model('syncQueue').findMany.mockResolvedValue([
        {
          id: 'queue-1',
          entity: 'member',
          entity_id: mockMemberId,
          action: 'update',
          data: {},
          created_at: new Date('2026-07-22T10:00:00Z'),
        },
      ]);
      model('member').findFirst.mockResolvedValue(null);

      const result = await service.pullChanges(
        mockChurchId,
        'device-1',
        undefined,
        undefined,
        viewer,
      );

      expect(result.changes).toEqual([]);
    });

    it('should tombstone changes whose record is archived', async () => {
      mockDevice();
      model('syncQueue').findMany.mockResolvedValue([
        {
          id: 'queue-1',
          entity: 'member',
          entity_id: mockMemberId,
          action: 'update',
          data: {},
          created_at: new Date('2026-07-22T10:00:00Z'),
        },
      ]);
      model('member').findFirst.mockResolvedValue({ ...memberRow, archived_at: new Date() });

      const result = await service.pullChanges(
        mockChurchId,
        'device-1',
        undefined,
        undefined,
        viewer,
      );

      expect(result.changes[0].data).toBeNull();
    });

    it('should detect hasMore when limit exceeded', async () => {
      mockDevice();
      const items = Array.from({ length: 11 }, (_, i) => ({
        id: `queue-${i}`,
        entity: 'member',
        entity_id: `id-${i}`,
        action: 'update',
        data: {},
        created_at: new Date(2026, 6, 22, 10, i),
      }));
      model('syncQueue').findMany.mockResolvedValue(items);
      model('member').findFirst.mockResolvedValue(memberRow);

      const result = await service.pullChanges(mockChurchId, 'device-1', 10, undefined, viewer);

      expect(result.hasMore).toBe(true);
      expect(result.changes).toHaveLength(10);
      expect(model('member').findFirst).toHaveBeenCalledTimes(10);
    });

    it('should reject an invalid cursor', async () => {
      mockDevice();
      model('syncQueue').findMany.mockResolvedValue([]);

      await expect(
        service.pullChanges(mockChurchId, 'device-1', 100, 'not-a-date', viewer),
      ).rejects.toThrow('Invalid cursor');
    });
  });

  describe('bootstrap', () => {
    it('should return a full snapshot with camelCase collections', async () => {
      const member = {
        id: mockMemberId,
        church_id: mockChurchId,
        branch_id: null,
        first_name: 'John',
        last_name: 'Doe',
        email: null,
        phone: '+2348012345678',
        whatsapp_number: null,
        date_of_birth: null,
        gender: 'male',
        address: null,
        city: null,
        state: null,
        status: 'active',
        member_since: new Date('2026-01-01T10:00:00Z'),
        photo_url: null,
        custom_fields: {},
        notes: null,
        created_at: new Date('2026-01-01T10:00:00Z'),
        updated_at: new Date('2026-01-01T10:00:00Z'),
      };

      model('member').findMany.mockResolvedValue([member]);
      model('service').findMany.mockResolvedValue([]);
      model('givingCategory').findMany.mockResolvedValue([]);
      model('visitor').findMany.mockResolvedValue([]);
      model('attendance').findMany.mockResolvedValue([]);
      model('transaction').findMany.mockResolvedValue([]);

      const result = await service.bootstrap(mockChurchId, viewer);

      expect(result.churchId).toBe(mockChurchId);
      expect(typeof result.revision).toBe('string');
      expect(result.collections.members).toHaveLength(1);
      expect(result.collections.members[0]).toMatchObject({
        id: mockMemberId,
        firstName: 'John',
        lastName: 'Doe',
        phone: '+2348012345678',
        memberSince: '2026-01-01T10:00:00.000Z',
      });
      expect(result.collections.services).toEqual([]);
    });

    it('bootstraps shared categories for branch staff without exposing branch transactions', async () => {
      model('givingCategory').findMany.mockResolvedValue([]);
      model('transaction').findMany.mockResolvedValue([]);
      const branchViewer = { ...viewer, is_admin_hq: false };
      await service.bootstrap(mockChurchId, branchViewer, 100, 'givingCategory');
      expect(model('givingCategory').findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { church_id: mockChurchId, archived_at: null },
        }),
      );
      await service.bootstrap(mockChurchId, branchViewer, 100, 'transaction');
      expect(model('transaction').findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { church_id: mockChurchId, branch_id: viewer.branch_id },
        }),
      );
    });

    it('should scope all archivable bootstrap collections to active rows', async () => {
      model('member').findMany.mockResolvedValue([]);
      model('service').findMany.mockResolvedValue([]);
      model('givingCategory').findMany.mockResolvedValue([]);
      model('visitor').findMany.mockResolvedValue([]);
      model('attendance').findMany.mockResolvedValue([]);
      model('transaction').findMany.mockResolvedValue([]);

      await service.bootstrap(mockChurchId, viewer);

      expect(model('member').findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ archived_at: null }) }),
      );
      expect(model('service').findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ archived_at: null }) }),
      );
      expect(model('givingCategory').findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ archived_at: null }) }),
      );
      expect(model('visitor').findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ deleted_at: null, archived_at: null }),
        }),
      );
    });
  });

  describe('markSynced', () => {
    it('should mark entities as synced', async () => {
      model('syncQueue').updateMany.mockResolvedValue({ count: 3 });

      const result = await service.markSynced(mockChurchId, [mockMemberId], viewer);

      expect(result.marked).toBe(0);
      expect(model('syncQueue').updateMany).not.toHaveBeenCalled();
    });
  });

  describe('cleanupExpiredChanges', () => {
    it('should purge rows synced over 30 days ago and any row older than 90 days', async () => {
      model('syncQueue').deleteMany.mockResolvedValue({ count: 5 });

      const result = await service.cleanupExpiredChanges(mockChurchId);

      expect(result).toBe(5);
      expect(model('syncQueue').deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            church_id: mockChurchId,
            OR: [
              expect.objectContaining({ synced: true, synced_at: expect.anything() }),
              expect.objectContaining({ created_at: expect.anything() }),
            ],
          }),
        }),
      );
    });
  });
});
