/**
 * @file permissions.service.spec.ts
 * @description Unit tests for PermissionsService — global templates,
 * church-owned custom roles, overrides, and guardrails.
 *
 * @module test/unit/auth/permissions.service.spec
 * @since 1.0.0
 */

import { PermissionsService } from '../../../src/auth/services/permissions.service';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { RedisService } from '../../../src/redis/redis.service';
import { AuditLoggingService } from '../../../src/common/services/audit-logging.service';
import { createPrismaMock } from '../../helpers/prisma-mock.helper';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

describe('PermissionsService', () => {
  let service: PermissionsService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let redis: { get: jest.Mock; set: jest.Mock; del: jest.Mock };
  let audit: { log: jest.Mock };

  const churchId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const otherChurchId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

  const globalTemplate = {
    id: 'rrrrrrrr-0000-0000-0000-000000000001',
    church_id: null,
    name: 'secretary',
    label: 'Secretary',
    description: 'Church secretary',
  };
  const ownedRole = {
    id: 'rrrrrrrr-0000-0000-0000-000000000002',
    church_id: churchId,
    name: 'media_team',
    label: 'Media Team',
    description: 'Media team volunteers',
  };

  const allPerms = [
    { id: 'p-members-read', name: 'members:read', resource: 'members', action: 'read' },
    { id: 'p-members-create', name: 'members:create', resource: 'members', action: 'create' },
    { id: 'p-giving-read', name: 'giving:read', resource: 'giving', action: 'read' },
  ];

  beforeEach(() => {
    prisma = createPrismaMock();
    prisma.platformSubscription.findUnique.mockResolvedValue({
      plan: 'network',
      paid_until: new Date('2099-01-01'),
    });
    redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
    };
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    service = new PermissionsService(
      prisma as unknown as PrismaService,
      redis as unknown as RedisService,
      audit as unknown as AuditLoggingService,
    );
  });

  it('hides the platform role and lists Church Admin first in the church catalog', async () => {
    prisma.role.findMany.mockResolvedValue([
      ...['branch_pastor', 'super_admin', 'senior_pastor', 'church_admin', 'member'].map(
        (name) => ({ ...globalTemplate, name }),
      ),
      ownedRole,
    ]);
    prisma.permission.findMany.mockResolvedValue(allPerms);
    prisma.churchRolePermission.findMany.mockResolvedValue([]);
    prisma.rolePermission.findMany.mockResolvedValue([]);
    const roles = await service.getRolesSummary(churchId);
    expect(roles.map((role) => role.roleName)).toEqual([
      'church_admin',
      'branch_pastor',
      'senior_pastor',
      'media_team',
    ]);
  });

  it('does not expose Super Admin through church role details', async () => {
    await expect(service.getRolePermissions(churchId, 'super_admin')).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.role.findMany).not.toHaveBeenCalled();
  });

  // ─── createRole ───────────────────────────────────────────

  describe('createRole', () => {
    it.each(['essentials', 'community'])(
      'blocks custom role creation on %s before any write',
      async (plan) => {
        prisma.platformSubscription.findUnique.mockResolvedValue({
          plan,
          paid_until: new Date('2099-01-01'),
        });
        await expect(service.createRole(churchId, { label: 'Media Team' })).rejects.toThrow();
        expect(prisma.role.create).not.toHaveBeenCalled();
      },
    );

    it('reserves cell_leader even when a global template is missing', async () => {
      await expect(service.createRole(churchId, { label: 'Cell Leader' })).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.role.findMany).not.toHaveBeenCalled();
      expect(prisma.role.create).not.toHaveBeenCalled();
    });

    it('slugifies the label and creates a church-owned role with initial grants', async () => {
      prisma.role.findMany
        .mockResolvedValueOnce([]) // collision check
        .mockResolvedValueOnce([ownedRole]); // re-read inside getRolePermissions
      prisma.permission.findMany.mockResolvedValue([allPerms[0]]);
      prisma.role.create.mockResolvedValue({
        id: ownedRole.id,
        name: 'media_team',
        label: 'Media Team',
        description: 'Runs slides',
      });
      prisma.rolePermission.findMany.mockResolvedValue([{ permission_id: 'p-members-read' }]);

      const created = await service.createRole(
        churchId,
        { label: 'Media Team', description: 'Runs slides', permissionIds: ['p-members-read'] },
        'user-1',
      );

      expect(prisma.role.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            church_id: churchId,
            name: 'media_team',
            label: 'Media Team',
            description: 'Runs slides',
          }),
        }),
      );
      // The friendly label is echoed back so UIs never show the raw slug.
      expect(created.label).toBe('Media Team');
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'role', action: 'CREATE', userId: 'user-1' }),
      );
    });

    it('rejects labels colliding with reserved role names', async () => {
      await expect(service.createRole(churchId, { label: 'Super Admin!' })).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.role.create).not.toHaveBeenCalled();
    });

    it('rejects duplicates of existing global or own-church roles', async () => {
      prisma.role.findMany.mockResolvedValue([globalTemplate]);
      await expect(service.createRole(churchId, { label: 'Secretary' })).rejects.toThrow(
        ConflictException,
      );
    });

    it('rejects labels that produce invalid slugs', async () => {
      await expect(service.createRole(churchId, { label: '123 Team' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects unknown permission IDs', async () => {
      prisma.role.findMany.mockResolvedValue([]);
      prisma.permission.findMany.mockResolvedValue([]);
      await expect(
        service.createRole(churchId, { label: 'Media Team', permissionIds: ['p-nope'] }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ─── getRolePermissions ───────────────────────────────────

  describe('getRolePermissions', () => {
    it('merges template defaults with additive church overrides', async () => {
      prisma.role.findMany.mockResolvedValue([globalTemplate]);
      prisma.permission.findMany.mockResolvedValue(allPerms);
      prisma.rolePermission.findMany.mockResolvedValue([{ permission_id: 'p-members-read' }]);
      prisma.churchRolePermission.findMany.mockResolvedValue([{ permission_id: 'p-giving-read' }]);

      const result = await service.getRolePermissions(churchId, 'secretary');

      expect(result.isChurchOwned).toBe(false);
      expect(result.isCustomized).toBe(true);
      expect(result.permissions.map((p) => p.name)).toEqual(
        expect.arrayContaining(['members:read', 'giving:read']),
      );
      expect(result.permissions).toHaveLength(2);
      expect(result.defaultPermissionIds).toEqual(['p-members-read']);
    });

    it('returns the absolute stored set for church-owned roles', async () => {
      prisma.role.findMany.mockResolvedValue([ownedRole]);
      prisma.permission.findMany.mockResolvedValue(allPerms);
      prisma.rolePermission.findMany.mockResolvedValue([
        { permission_id: 'p-members-read' },
        { permission_id: 'p-giving-read' },
      ]);

      const result = await service.getRolePermissions(churchId, 'media_team');

      expect(result.isChurchOwned).toBe(true);
      expect(result.defaultPermissionIds).toEqual([]);
      expect(result.isCustomized).toBe(false);
      expect(result.permissions.map((p) => p.name)).toEqual(
        expect.arrayContaining(['members:read', 'giving:read']),
      );
    });

    it('prefers a church-owned role over the global template of the same name', async () => {
      const shadowing = { ...ownedRole, name: 'secretary' };
      prisma.role.findMany.mockResolvedValue([shadowing]);
      prisma.permission.findMany.mockResolvedValue(allPerms);
      prisma.rolePermission.findMany.mockResolvedValue([]);

      const result = await service.getRolePermissions(churchId, 'secretary');

      expect(prisma.churchRolePermission.findMany).not.toHaveBeenCalled();
      expect(result.isChurchOwned).toBe(true);
    });

    it('throws NotFound when neither template nor owned role exists', async () => {
      prisma.role.findMany.mockResolvedValue([]);
      await expect(service.getRolePermissions(churchId, 'ghost')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('never exposes another church’s owned role', async () => {
      prisma.role.findMany.mockResolvedValue([]);
      await expect(service.getRolePermissions(otherChurchId, 'media_team')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ─── setPermissionsForRole ────────────────────────────────

  describe('setPermissionsForRole', () => {
    it('absolutely replaces the permission set of an owned role', async () => {
      prisma.role.findMany.mockResolvedValue([ownedRole]);
      prisma.permission.findMany
        .mockResolvedValueOnce([allPerms[0], allPerms[2]]) // validation lookup
        .mockResolvedValueOnce(allPerms); // not needed but harmless
      (prisma.$transaction as unknown as jest.Mock).mockResolvedValue([]);

      await service.setPermissionsForRole(churchId, 'media_team', [
        'p-members-read',
        'p-giving-read',
      ]);

      expect(prisma.rolePermission.deleteMany).toHaveBeenCalledWith({
        where: { role_id: ownedRole.id },
      });
      expect(prisma.rolePermission.create).toHaveBeenCalledTimes(2);
      expect(prisma.churchRolePermission.deleteMany).not.toHaveBeenCalled();
      expect(redis.del).toHaveBeenCalledWith(`perms:v31:${churchId}:media_team`);
    });

    it('replaces only church overrides for a global template', async () => {
      prisma.role.findMany.mockResolvedValue([globalTemplate]);
      prisma.permission.findMany
        .mockResolvedValueOnce([allPerms[0]]) // validation lookup
        .mockResolvedValueOnce(allPerms); // church_admin check skipped (secretary)
      (prisma.$transaction as unknown as jest.Mock).mockResolvedValue([]);

      await service.setPermissionsForRole(churchId, 'secretary', ['p-members-read']);

      expect(prisma.churchRolePermission.deleteMany).toHaveBeenCalledWith({
        where: { church_id: churchId, role_name: 'secretary' },
      });
      expect(prisma.churchRolePermission.create).toHaveBeenCalledWith({
        data: { church_id: churchId, role_name: 'secretary', permission_id: 'p-members-read' },
      });
      expect(prisma.rolePermission.deleteMany).not.toHaveBeenCalled();
    });

    it('blocks modifying super_admin', async () => {
      await expect(
        service.setPermissionsForRole(churchId, 'super_admin', ['p-members-read']),
      ).rejects.toThrow(BadRequestException);
    });

    it('blocks removing required permissions from the church_admin template', async () => {
      prisma.role.findMany.mockResolvedValue([globalTemplate]);
      prisma.permission.findMany
        .mockResolvedValueOnce([allPerms[2]]) // validation lookup
        .mockResolvedValueOnce(allPerms);

      await expect(
        service.setPermissionsForRole(churchId, 'church_admin', ['p-giving-read']),
      ).rejects.toThrow(/must always have/);
    });

    it('rejects unknown permission IDs', async () => {
      prisma.role.findMany.mockResolvedValue([ownedRole]);
      prisma.permission.findMany.mockResolvedValue([]);
      await expect(
        service.setPermissionsForRole(churchId, 'media_team', ['p-nope']),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ─── resetRoleToDefaults ──────────────────────────────────

  describe('resetRoleToDefaults', () => {
    it('deletes church overrides for a template role', async () => {
      prisma.role.findMany.mockResolvedValue([globalTemplate]);

      await service.resetRoleToDefaults(churchId, 'secretary');

      expect(prisma.churchRolePermission.deleteMany).toHaveBeenCalledWith({
        where: { church_id: churchId, role_name: 'secretary' },
      });
      expect(redis.del).toHaveBeenCalled();
    });

    it('refuses to reset a church-owned role', async () => {
      prisma.role.findMany.mockResolvedValue([ownedRole]);
      await expect(service.resetRoleToDefaults(churchId, 'media_team')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('refuses to reset super_admin', async () => {
      await expect(service.resetRoleToDefaults(churchId, 'super_admin')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ─── Resolution & caching ─────────────────────────────────

  describe('getUserPermissions', () => {
    it.each([
      'senior_pastor',
      'branch_pastor',
      'secretary',
      'treasurer',
      'usher',
      'department_head',
      'cell_leader',
      'custom_admin',
    ])('reserves every analytics permission from %s despite overrides and HQ', async (role) => {
      const analytics = [
        'analytics:view',
        'analytics:read',
        'analytics:dashboard:read',
        'analytics:giving:read',
        'analytics:attendance:read',
        'analytics:members:read',
        'analytics:events:read',
        'analytics:communication:read',
      ];
      jest
        .spyOn(service, 'getPermissionsForRole')
        .mockResolvedValue(['members:read', ...analytics]);
      for (const hq of [false, true])
        expect(await service.getUserPermissions(churchId, [role, 'custom_analytics'], hq)).toEqual([
          'members:read',
        ]);
    });
    it.each(['church_admin', 'super_admin'])(
      'preserves analytics for %s in mixed-role accounts',
      async (role) => {
        const analytics = [
          'analytics:view',
          'analytics:dashboard:read',
          'analytics:giving:read',
          'analytics:attendance:read',
          'analytics:members:read',
          'analytics:events:read',
          'analytics:communication:read',
        ];
        prisma.permission.findMany.mockResolvedValue(analytics.map((name) => ({ name })));
        expect(await service.getUserPermissions(churchId, ['usher', role], true)).toEqual(
          analytics,
        );
      },
    );

    it.each([
      'senior_pastor',
      'branch_pastor',
      'secretary',
      'treasurer',
      'usher',
      'department_head',
      'cell_leader',
      'custom_admin',
    ])(
      'strips integration administration from %s even if custom overrides grant it',
      async (role) => {
        jest
          .spyOn(service, 'getPermissionsForRole')
          .mockResolvedValue([
            'members:read',
            'integrations:read',
            'integrations:update',
            'billing:read',
            'billing:update',
          ]);
        expect(await service.getUserPermissions(churchId, [role])).toEqual(['members:read']);
      },
    );

    it('strips persisted integration grants across multiple non-admin roles', async () => {
      prisma.role.findMany
        .mockResolvedValueOnce([{ ...globalTemplate, name: 'senior_pastor' }])
        .mockResolvedValueOnce([{ ...ownedRole, name: 'custom_admin' }]);
      prisma.churchRolePermission.findMany.mockResolvedValue([]);
      prisma.rolePermission.findMany.mockResolvedValue(
        [
          'members:read',
          'integrations:read',
          'integrations:update',
          'billing:read',
          'billing:update',
        ].map((name) => ({ permission: { name } })),
      );

      expect(await service.getUserPermissions(churchId, ['senior_pastor', 'custom_admin'])).toEqual(
        ['members:read'],
      );
      expect(redis.get).not.toHaveBeenCalled();
    });

    it.each(['church_admin', 'super_admin'])(
      'grants integration management to %s through the permission catalog',
      async (role) => {
        const permissions = [
          'integrations:read',
          'integrations:update',
          'billing:read',
          'billing:update',
        ];
        prisma.permission.findMany.mockResolvedValue(permissions.map((name) => ({ name })));

        expect(await service.getUserPermissions(churchId, ['member', role])).toEqual(permissions);
      },
    );

    it.each([false, true])(
      'derives department creation from own-update and HQ=%s without changing cached role grants',
      async (hq) => {
        jest
          .spyOn(service, 'getPermissionsForRole')
          .mockResolvedValue(['departments:read', 'departments:own:update']);
        const permissions = await service.getUserPermissions(churchId, 'department_head', hq);
        expect(permissions.includes('departments:create')).toBe(hq);
        expect(permissions).not.toContain('departments:delete');
      },
    );

    it('unions permissions across template and owned roles', async () => {
      prisma.role.findMany.mockImplementation(
        (args: { where: { name: string | { in: string[] } } }) => {
          const name =
            typeof args.where.name === 'string' ? args.where.name : (args.where.name.in?.[0] ?? '');
          if (name === 'secretary') return Promise.resolve([globalTemplate]);
          if (name === 'media_team') return Promise.resolve([ownedRole]);
          return Promise.resolve([]);
        },
      );

      prisma.rolePermission.findMany.mockImplementation(
        (args: { where?: { role?: { name?: string }; role_id?: string } }) => {
          if (args.where?.role?.name === 'secretary') {
            return Promise.resolve([{ permission: { name: 'members:read' } }]);
          }
          if (args.where?.role_id) {
            return Promise.resolve([{ permission: { name: 'giving:read' } }]);
          }
          return Promise.resolve([]);
        },
      );
      prisma.churchRolePermission.findMany.mockResolvedValue([]);

      const perms = await service.getUserPermissions(churchId, ['secretary', 'media_team']);

      expect(perms.sort()).toEqual(['giving:read', 'members:read']);
    });
  });

  describe('getPermissionsForRole', () => {
    it('returns every permission for super_admin and caches the catalog', async () => {
      const cache = new Map<string, unknown>();
      redis.get.mockImplementation((key: string) => Promise.resolve(cache.get(key) ?? null));
      redis.set.mockImplementation((key: string, value: unknown) => {
        cache.set(key, value);
        return Promise.resolve(undefined);
      });
      prisma.permission.findMany.mockResolvedValue(allPerms);

      const first = await service.getPermissionsForRole(churchId, 'super_admin');
      const second = await service.getPermissionsForRole(churchId, 'super_admin');

      expect(first).toEqual(['members:read', 'members:create', 'giving:read']);
      expect(second).toEqual(first);
      expect(prisma.permission.findMany).toHaveBeenCalledTimes(1);
      expect(redis.get).not.toHaveBeenCalled();
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('coalesces catalogue misses, expires locally and does not expose a mutable cached array', async () => {
      jest.useFakeTimers();
      try {
        prisma.permission.findMany.mockResolvedValue(allPerms);
        const results = await Promise.all(
          Array.from({ length: 10 }, () => service.getPermissionsForRole(churchId, 'church_admin')),
        );
        results[0].push('injected');
        expect(await service.getPermissionsForRole(churchId, 'church_admin')).not.toContain(
          'injected',
        );
        expect(prisma.permission.findMany).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(30001);
        prisma.permission.findMany.mockResolvedValue([{ name: 'members:read' }]);
        expect(await service.getPermissionsForRole(churchId, 'church_admin')).toEqual([
          'members:read',
        ]);
        expect(prisma.permission.findMany).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    });

    it('retries a failed catalogue load instead of retaining a rejected promise', async () => {
      prisma.permission.findMany
        .mockRejectedValueOnce(new Error('database unavailable'))
        .mockResolvedValueOnce(allPerms);
      await expect(service.getPermissionsForRole(churchId, 'church_admin')).rejects.toThrow(
        'database unavailable',
      );
      expect(await service.getPermissionsForRole(churchId, 'church_admin')).toContain(
        'members:read',
      );
    });

    it('ignores stale grants and observes a committed revocation on the next resolution', async () => {
      redis.get.mockResolvedValue(['members:read', 'members:delete']);
      redis.del.mockRejectedValue(new Error('cache deletion unavailable'));
      prisma.role.findMany.mockResolvedValue([ownedRole]);
      prisma.rolePermission.findMany
        .mockResolvedValueOnce([{ permission: { name: 'members:delete' } }])
        .mockResolvedValueOnce([{ permission: { name: 'members:read' } }]);
      expect(await service.getPermissionsForRole(churchId, ownedRole.name)).toEqual([
        'members:delete',
      ]);
      expect(await service.getPermissionsForRole(churchId, ownedRole.name)).toEqual([
        'members:read',
      ]);
      expect(redis.get).not.toHaveBeenCalled();
      expect(redis.set).not.toHaveBeenCalled();
    });
    it('fails closed when current grants cannot be read instead of using stale Redis permissions', async () => {
      redis.get.mockResolvedValue(['members:delete']);
      prisma.role.findMany.mockRejectedValue(new Error('database unavailable'));
      await expect(service.getPermissionsForRole(churchId, ownedRole.name)).rejects.toThrow(
        'database unavailable',
      );
      expect(redis.get).not.toHaveBeenCalled();
    });
  });
});
