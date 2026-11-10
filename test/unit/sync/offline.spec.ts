import { DEFAULT_PERMISSION_MATRIX } from '../../../prisma/seeds/shared/permissions.seed';
import { ValidationPipe } from '@nestjs/common';
import { OfflineService, offlineHash } from '../../../src/sync/offline.service';
import { OfflinePushDto, OfflineSnapshotDto } from '../../../src/sync/dto/offline.dto';
import { OfflineController } from '../../../src/sync/offline.controller';
import { AuthenticatedRequest } from '../../../src/common/decorators/current-user.decorator';
import { randomUUID } from 'crypto';

describe('Offline API contract', () => {
  it.each(['secretary', 'treasurer'])(
    'allows %s to archive and delete giving categories',
    (role) => {
      expect(DEFAULT_PERMISSION_MATRIX[role]).toEqual(
        expect.arrayContaining(['giving:categories:update', 'giving:categories:delete']),
      );
    },
  );
  it('allows department heads to browse media and sermons without creating them', () => {
    expect(DEFAULT_PERMISSION_MATRIX.department_head).toEqual(
      expect.arrayContaining(['media:read', 'sermons:read']),
    );
    expect(DEFAULT_PERMISSION_MATRIX.department_head).not.toContain('media:upload:create');
    expect(DEFAULT_PERMISSION_MATRIX.department_head).not.toContain('sermons:new:create');
    expect(DEFAULT_PERMISSION_MATRIX.department_head).not.toContain('departments:create');
    expect(DEFAULT_PERMISSION_MATRIX.department_head).toContain('events:tickets:read');
    expect(DEFAULT_PERMISSION_MATRIX.department_head).not.toContain('events:tickets:create');
  });
  it('keeps cell leaders calendar and tickets without event management grants', () => {
    expect(DEFAULT_PERMISSION_MATRIX.cell_leader).toEqual(
      expect.arrayContaining([
        'events:view',
        'events:calendar:read',
        'events:list:read',
        'events:tickets:read',
        'cell_groups:own:update',
      ]),
    );
    for (const permission of [
      'events:all:read',
      'events:registrations:read',
      'events:checkin:read',
    ])
      expect(DEFAULT_PERMISSION_MATRIX.cell_leader).not.toContain(permission);
  });
  it('has no member login grants and retains staff offline access', () => {
    expect(DEFAULT_PERMISSION_MATRIX.member).toBeUndefined();
    expect(DEFAULT_PERMISSION_MATRIX.cell_leader).toContain('offline:read');
  });

  const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
  const body = () => ({
    profileId: randomUUID(),
    churchId: randomUUID(),
    mutations: [
      {
        mutationId: randomUUID(),
        entityId: randomUUID(),
        branchId: randomUUID(),
        entity: 'member',
        action: 'create',
        data: { firstName: 'Ada', lastName: 'Obi' },
      },
    ],
  });
  const validate = (value: unknown) =>
    pipe.transform(value, { type: 'body', metatype: OfflinePushDto });
  it('requires a dedicated offline permission even with entity permissions', async () => {
    const service = new OfflineService({} as never, {} as never);
    const viewer = {
      church_id: randomUUID(),
      branch_id: randomUUID(),
      permissions: ['members:all:read', 'members:new:create'],
    } as never;
    await expect(service.snapshot(viewer, randomUUID())).rejects.toThrow(
      'Offline workspace access',
    );
    const [ack] = await service.push(viewer, randomUUID(), body().mutations as never);
    expect(ack.status).toBe('rejected');
  });
  it('requires a bounded validated batch and explicit original account', async () => {
    expect(await validate(body())).toBeInstanceOf(OfflinePushDto);
    await expect(validate({ ...body(), profileId: undefined })).rejects.toThrow();
    await expect(validate({ ...body(), mutations: [] })).rejects.toThrow();
    const large = body();
    large.mutations = Array.from({ length: 26 }, () => body().mutations[0]);
    await expect(validate(large)).rejects.toThrow();
  });
  it('rejects invalid identifiers, unsupported entities, actions and extra envelope fields', async () => {
    for (const patch of [
      { mutationId: 'invalid' },
      { branchId: 'all' },
      { entity: 'transaction' },
      { action: 'delete' },
      { baseVersion: 'invalid' },
      { data: [] },
      { role: 'super_admin' },
    ]) {
      const input = body();
      Object.assign(input.mutations[0], patch);
      await expect(validate(input)).rejects.toThrow();
    }
    await expect(validate({ ...body(), token: 'secret' })).rejects.toThrow();
  });
  it('requires a concrete branch for offline preparation', async () => {
    await expect(
      pipe.transform({ branchId: 'all' }, { type: 'query', metatype: OfflineSnapshotDto }),
    ).rejects.toThrow();
  });
  it('hashes equivalent nested JSON identically but different content differently', () => {
    expect(offlineHash({ a: 1, b: { x: 2, y: 3 } })).toBe(offlineHash({ b: { y: 3, x: 2 }, a: 1 }));
    expect(offlineHash({ a: 1 })).not.toBe(offlineHash({ a: 2 }));
  });
  it('refuses a queued batch after the active account changes', () => {
    const service = { push: jest.fn() };
    const controller = new OfflineController(service as never);
    const input = body();
    const request = {
      profile: { id: 'different', church_id: input.churchId },
      user: { sub: randomUUID() },
    } as AuthenticatedRequest;
    expect(() => controller.push(request, input as OfflinePushDto)).toThrow('different account');
    expect(service.push).not.toHaveBeenCalled();
  });
  it('bounds offline writes by paid expiry and keeps expired snapshots read-only', async () => {
    const branchId = randomUUID();
    const prisma = {
      branch: { findFirst: jest.fn().mockResolvedValue({ id: branchId, name: 'Branch' }) },
      member: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new OfflineService(prisma as never, {} as never);
    const until = new Date(Date.now() + 60000).toISOString();
    const viewer = {
      id: randomUUID(),
      church_id: randomUUID(),
      role: 'church_admin',
      is_admin_hq: true,
      permissions: ['offline:read', 'members:all:read', 'members:new:create'],
      subscriptionPaidUntil: until,
    };
    const active = await service.snapshot(viewer, branchId);
    expect(active.expiresAt).toBe(until);
    const expired = await service.snapshot(
      { ...viewer, subscriptionPaidUntil: undefined, subscriptionReadOnly: true },
      branchId,
    );
    expect(expired.permissions).toEqual(['offline:read', 'members:all:read']);
  });
});
