import {
  FEATURE_MINIMUM_PLAN,
  featureForPermission as clientPermissionFeature,
} from '../../../src/assistant/routes.generated';
import { generateAllPermissions } from '../../../prisma/seeds/shared/permissions.seed';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PlanFeatureGuard } from '../../../src/billing/plan-feature.guard';
import {
  FEATURE_LEVELS,
  PLAN_RANK,
  planFeatures,
  SubscriptionPlan,
} from '../../../src/billing/plans';
import { featureForPermission, filterPlanPermissions } from '../../../src/billing/feature-policy';
import { PERMISSIONS_KEY } from '../../../src/auth/decorators/permissions.decorator';

function requestContext(request: Record<string, unknown>, permissions: string[] = []) {
  const handler = () => {};
  Reflect.defineMetadata(PERMISSIONS_KEY, permissions, handler);
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
    getClass: () => PlanFeatureGuard,
  } as unknown as ExecutionContext;
}
const routes = [
  ['/giving/categories', 'giving'],
  ['/giving/dashboard', 'giving'],
  ['/giving/cell-groups/id', 'groups'],
  ['/members/id/giving', 'giving'],
  ['/events', 'events'],
  ['/events/management/tickets', 'tickets'],
  ['/events/id/tiers', 'tickets'],
  ['/events/id/check-in', 'events'],
  ['/events/id/attendance', 'events'],
  ['/events/id/check-in/walk-in', 'events'],
  ['/events/id/attendance-sessions', 'events'],
  ['/events/id/tickets/validate', 'tickets'],
  ['/admin/departments', 'groups'],
  ['/admin/cell-groups', 'groups'],
  ['/forms', 'forms'],
  ['/reports/financial', 'giving'],
  ['/reports/attendance', 'reports'],
  ['/reports/members', 'reports'],
  ['/assets/categories', 'assets'],
  ['/pastoral/notes', 'pastoral'],
  ['/admin/dashboard/engagement', 'pastoral'],
  ['/appointments', 'pastoral'],
  ['/analytics', 'analytics'],
  ['/church/integrations', 'giving'],
  ['/calls', 'calls'],
  ['/templates', 'email'],
  ['/broadcasts', 'email'],
  ['/messages', 'email'],
  ['/sermons', 'media'],
  ['/media/library', 'media'],
  ['/webhooks', 'webhooks'],
] as const;

describe.each(Object.keys(PLAN_RANK) as SubscriptionPlan[])('%s plan boundaries', (plan) => {
  const prisma = {
    platformSubscription: {
      findUnique: jest.fn(async () => ({ plan, paid_until: new Date(Date.now() + 86400000) })),
    },
  };
  const guard = new PlanFeatureGuard(prisma as never, new Reflector());
  it.each(routes)('%s requires %s on every read/write method', async (path, feature) => {
    for (const method of ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE']) {
      const request = {
        method,
        path: '/api/v1' + path,
        profile: { church_id: 'church', role: 'super_admin', is_admin_hq: true },
      };
      const result = guard.canActivate(requestContext(request));
      if (FEATURE_LEVELS[feature] <= PLAN_RANK[plan]) await expect(result).resolves.toBe(true);
      else await expect(result).rejects.toBeInstanceOf(ForbiddenException);
    }
  });
});

describe('Composite routes, missing entitlements and narrow payment exceptions', () => {
  const make = (
    plan: SubscriptionPlan = 'essentials',
    paid_until: Date | null = new Date(Date.now() + 86400000),
  ) =>
    new PlanFeatureGuard({
      platformSubscription: { findUnique: async () => ({ plan, paid_until }) },
    } as never);
  it.each([
    ['/attendance/summary', 'attendance:dashboard:read'],
    ['/attendance/trends', 'attendance:reports:read'],
    ['/attendance/attendance', 'attendance:records:read'],
    ['/services', 'attendance:services:read'],
  ])('keeps core attendance %s available on Essentials', async (path, permission) => {
    await expect(
      make().canActivate(
        requestContext(
          {
            method: 'GET',
            path,
            profile: { church_id: 'church', permissions: [permission] },
          },
          [permission],
        ),
      ),
    ).resolves.toBe(true);
  });

  it('keeps financial report reads/exports available on Essentials alongside the other standard reports', async () => {
    const permissions = [
      'reports:view',
      'reports:financial:read',
      'reports:attendance:read',
      'reports:members:read',
    ];
    const request = {
      method: 'GET',
      path: '/reports/financial',
      profile: { church_id: 'church', permissions },
    };
    await expect(
      make().canActivate(requestContext(request, ['reports:financial:read'])),
    ).resolves.toBe(true);
    expect(request.profile.permissions).toEqual(permissions);
    await expect(
      make().canActivate(
        requestContext(
          {
            method: 'POST',
            path: '/reports/export',
            body: { type: 'financial' },
            profile: { church_id: 'church', permissions },
          },
          ['reports:view'],
        ),
      ),
    ).resolves.toBe(true);
    for (const type of ['attendance', 'members']) {
      await expect(
        make().canActivate(
          requestContext(
            {
              method: 'POST',
              path: '/reports/export',
              body: { type },
              profile: { church_id: 'church', permissions },
            },
            ['reports:view'],
          ),
        ),
      ).resolves.toBe(true);
    }
  });

  it('strips all premium read/view/delete grants before sync and offline handlers run', async () => {
    for (const path of ['/sync/bootstrap', '/sync/pull', '/offline/snapshot']) {
      const request = {
        method: 'GET',
        path,
        profile: {
          church_id: 'church',
          permissions: [
            'members:all:read',
            'giving:records:read',
            'giving:view',
            'giving:categories:delete',
            'forms:list:read',
            'events:checkin:read',
          ],
        },
      };
      await expect(make().canActivate(requestContext(request))).resolves.toBe(true);
      expect(request.profile.permissions).toEqual([
        'members:all:read',
        'giving:records:read',
        'giving:view',
        'giving:categories:delete',
      ]);
    }
  });
  it('uses permission metadata for premium data in another controller', async () => {
    await expect(
      make().canActivate(
        requestContext(
          { method: 'GET', path: '/some-composite-route', profile: { church_id: 'church' } },
          ['pastoral:engagement:read'],
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
  it.each(['GET', 'POST'])(
    'includes generic event attendance on Community for %s, while denying Essentials',
    async (method) => {
      for (const plan of ['essentials', 'community'] as const) {
        const request = {
          method,
          path: '/attendance/attendance',
          query: method === 'GET' ? { eventId: 'event' } : {},
          body: method === 'POST' ? { eventId: 'event' } : {},
          profile: { church_id: 'church' },
        };
        const result = make(plan).canActivate(requestContext(request));
        if (plan === 'community') await expect(result).resolves.toBe(true);
        else await expect(result).rejects.toBeInstanceOf(ForbiddenException);
      }
    },
  );
  it('retains Community check-in grants but strips ticket management grants', async () => {
    const grants = ['events:checkin:read', 'events:checkin:create', 'events:checkin:update'];
    const request = {
      method: 'POST',
      path: '/events/id/check-in',
      profile: { church_id: 'church', permissions: [...grants, 'events:tickets:create'] },
    };
    await expect(
      make('community').canActivate(requestContext(request, ['events:checkin:create'])),
    ).resolves.toBe(true);
    expect(request.profile.permissions).toEqual(grants);
    await expect(
      make('community', new Date(0)).canActivate(
        requestContext(
          {
            method: 'POST',
            path: '/events/id/check-in',
            profile: { church_id: 'church' },
          },
          ['events:checkin:create'],
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('requires Network for paid event creation through the basic event API', async () => {
    await expect(
      make('community').canActivate(
        requestContext({
          method: 'POST',
          path: '/events',
          body: { isFree: false, price: 100 },
          profile: { church_id: 'church' },
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      make('network').canActivate(
        requestContext({
          method: 'POST',
          path: '/events',
          body: { isFree: false, price: 100 },
          profile: { church_id: 'church' },
        }),
      ),
    ).resolves.toBe(true);
  });
  it('does not allow Community to configure SMS through the shared broadcast API', async () => {
    await expect(
      make('community').canActivate(
        requestContext({
          method: 'POST',
          path: '/broadcasts',
          body: { channel: 'sms' },
          profile: { church_id: 'church' },
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
  it.each(['/giving/verify/ref', '/giving/recurring/id/cancel', '/giving/recurring/id/pause'])(
    'preserves settlement/reduction at %s',
    async (path) => {
      await expect(
        make().canActivate(
          requestContext({
            method: path.includes('verify') ? 'GET' : 'PATCH',
            path,
            profile: { church_id: 'church' },
          }),
        ),
      ).resolves.toBe(true);
    },
  );
  it.each(['/forms/id/verify', '/forms/id/archive', '/events/id/cancel', '/events/id/restore'])(
    'does not bypass plan checks using action suffix %s',
    async (path) => {
      await expect(
        make().canActivate(
          requestContext({ method: 'POST', path, profile: { church_id: 'church' } }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    },
  );
  it('keeps core directory, services, account and billing accessible on Essentials', async () => {
    for (const path of [
      '/members',
      '/visitors',
      '/attendance/services',
      '/profiles/me',
      '/billing/status',
      '/church/roles',
    ])
      await expect(
        make().canActivate(
          requestContext({ method: 'GET', path, profile: { church_id: 'church' } }),
        ),
      ).resolves.toBe(true);
  });
  it('includes downloadable receipts on Essentials while respecting email and WhatsApp channel tiers', async () => {
    await expect(
      make().canActivate(
        requestContext({
          method: 'GET',
          path: '/giving/transactions/id/receipt',
          profile: { church_id: 'church' },
        }),
      ),
    ).resolves.toBe(true);
    for (const channel of ['email', 'whatsapp'])
      await expect(
        make().canActivate(
          requestContext({
            method: 'POST',
            path: '/giving/transactions/id/send-receipt',
            body: { channel },
            profile: { church_id: 'church' },
          }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
  });
  it.each([
    ['essentials', '/giving/transactions'],
    ['network', '/forms'],
  ])('retains %s read access after natural expiry', async (plan, path) => {
    await expect(
      make(plan as never, new Date(0)).canActivate(
        requestContext({ method: 'GET', path, profile: { church_id: 'church' } }),
      ),
    ).resolves.toBe(true);
    await expect(
      make(plan as never, new Date(0)).canActivate(
        requestContext({ method: 'POST', path, profile: { church_id: 'church' } }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('maps ticket/check-in permissions separately and keeps giving on Essentials without ticket or group access', () => {
    expect(planFeatures('essentials')).toEqual(['giving', 'reports']);
    expect(featureForPermission('cell_groups:giving:read')).toBe('groups');
    expect(featureForPermission('events:checkin:read')).toBe('events');
    expect(
      filterPlanPermissions(['events:list:read', 'events:tickets:read'], planFeatures('community')),
    ).toEqual(['events:list:read']);
  });
});

describe('Server/client catalog parity', () => {
  it('keeps every feature and permission mapped to the same minimum tier', () => {
    expect(Object.keys(FEATURE_MINIMUM_PLAN).sort()).toEqual(Object.keys(FEATURE_LEVELS).sort());
    for (const feature of Object.keys(FEATURE_LEVELS) as (keyof typeof FEATURE_LEVELS)[]) {
      expect(PLAN_RANK[FEATURE_MINIMUM_PLAN[feature]]).toBe(FEATURE_LEVELS[feature]);
    }
    for (const permission of generateAllPermissions())
      expect(featureForPermission(permission.name)).toBe(clientPermissionFeature(permission.name));
  });
});
