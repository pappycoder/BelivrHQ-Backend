// Unit scope tests replace only the joined reader; real SQL is tested separately.
jest.mock('../../../src/auth/services/hydrated-profile', () => ({
  hydratedProfile: (
    prisma: { profile: { findUnique: (query: unknown) => Promise<unknown> } },
    userId: string,
  ) => prisma.profile.findUnique({ where: { user_id: userId } }),
}));
import { PlatformSubscription } from '@prisma/client';
import { requestEntitlements } from '../../../src/billing/entitlements';
import { RequestContextMiddleware } from '../../../src/common/middleware/request-context.middleware';
import { RequestContextService } from '../../../src/common/services/request-context.service';
import { PermissionsService } from '../../../src/auth/services/permissions.service';
import { PlanFeatureGuard } from '../../../src/billing/plan-feature.guard';
import { AuthenticatedRequest } from '../../../src/common/decorators/current-user.decorator';

const subscription = {
  church_id: 'church',
  plan: 'essentials',
  paid_until: new Date('2099-01-01'),
} as PlatformSubscription;
describe('Request-scoped subscription reuse', () => {
  it('hydrates once and performs no extra subscription reads for role or plan checks', async () => {
    const prisma = {
      profile: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'profile',
          church_id: 'church',
          role: ['church_admin'],
          status: 'active',
          is_admin_hq: true,
          church: { archived_at: null, subscription },
        }),
      },
      permission: { findMany: jest.fn().mockResolvedValue([{ name: 'members:read' }]) },
      platformSubscription: { findUnique: jest.fn() },
    };
    const permissions = new PermissionsService(
      prisma as never,
      { get: async () => ['members:read'] } as never,
      {} as never,
    );
    const middleware = new RequestContextMiddleware(
      new RequestContextService(),
      prisma as never,
      permissions,
      { verifyToken: async () => ({ payload: { sub: 'user' } }) } as never,
    );
    const request = {
      headers: { authorization: 'Bearer token' },
      method: 'GET',
      path: '/api/v1/members',
      originalUrl: '/api/v1/members',
    } as AuthenticatedRequest;
    const next = jest.fn();
    await middleware.use(request, {} as never, next);
    expect(next).toHaveBeenCalledWith();
    const guard = new PlanFeatureGuard(prisma as never, { getAllAndOverride: () => [] } as never);
    expect(
      await guard.canActivate({
        switchToHttp: () => ({ getRequest: () => request }),
        getHandler: () => null,
        getClass: () => null,
      } as never),
    ).toBe(true);
    expect(prisma.profile.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.platformSubscription.findUnique).not.toHaveBeenCalled();
  });
  it('applies downgrade policy to freshly resolved grants without a redundant subscription read', async () => {
    const prisma = {
      platformSubscription: { findUnique: jest.fn() },
      role: { findMany: async () => [{ id: 'role', church_id: 'church', name: 'media_team' }] },
      rolePermission: {
        findMany: async () =>
          ['members:read', 'events:read'].map((name) => ({ permission: { name } })),
      },
    };
    const service = new PermissionsService(
      prisma as never,
      { get: async () => ['members:read', 'events:read'] } as never,
      {} as never,
    );
    const snapshot = {
      churchId: 'church',
      subscription: { ...subscription, plan: 'network' as const },
    };
    expect(await service.getUserPermissions('church', 'media_team', false, snapshot)).toContain(
      'events:read',
    );
    expect(
      await service.getUserPermissions('church', 'media_team', false, {
        churchId: 'church',
        subscription,
      }),
    ).toEqual([]);
    expect(prisma.platformSubscription.findUnique).not.toHaveBeenCalled();
  });
  it('never reuses another tenant or a mismatched snapshot', async () => {
    const prisma = {
      platformSubscription: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ ...subscription, church_id: 'other', plan: 'community' }),
      },
    };
    expect(
      (await requestEntitlements(prisma as never, 'other', { churchId: 'church', subscription }))
        .plan,
    ).toBe('community');
    await requestEntitlements(prisma as never, 'other', { churchId: 'other', subscription });
    expect(prisma.platformSubscription.findUnique).toHaveBeenCalledTimes(2);
  });
  it('rechecks expiry as time advances and never stores state across requests', async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-10-24T00:00:00Z'));
      const paid = { ...subscription, paid_until: new Date(Date.now() + 1000) };
      const prisma = {
        platformSubscription: {
          findUnique: jest.fn().mockResolvedValueOnce(paid).mockResolvedValueOnce(null),
        },
      };
      const first = await requestEntitlements(prisma as never, 'church');
      expect(first.active).toBe(true);
      jest.advanceTimersByTime(1001);
      expect(first.active).toBe(false);
      expect((await requestEntitlements(prisma as never, 'church')).active).toBe(false);
      expect(prisma.platformSubscription.findUnique).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });
});
