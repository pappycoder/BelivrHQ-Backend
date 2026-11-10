// Unit scope tests replace only the joined reader; real SQL is tested separately.
jest.mock('../../../src/auth/services/hydrated-profile', () => ({
  hydratedProfile: (
    prisma: { profile: { findUnique: (query: unknown) => Promise<unknown> } },
    userId: string,
  ) => prisma.profile.findUnique({ where: { user_id: userId } }),
}));
import { ForbiddenException, HttpException } from '@nestjs/common';
import { RequestContextMiddleware } from '../../../src/common/middleware/request-context.middleware';
import { RequestContextService } from '../../../src/common/services/request-context.service';
import { ReportsController } from '../../../src/reports/reports.controller';

describe('Hydrated scope and report security', () => {
  it('does not elevate an explicit branch profile from a legacy scope permission', async () => {
    const prisma = {
      profile: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'profile',
          church_id: 'church',
          branch_id: 'branch',
          role: ['church_admin'],
          status: 'active',
          is_admin_hq: false,
          two_factor_enabled: false,
          church: { archived_at: null, subscription: { paid_until: new Date(Date.now() + 60000) } },
        }),
      },
    };
    const middleware = new RequestContextMiddleware(
      new RequestContextService(),
      prisma as never,
      { getUserPermissions: async () => ['data_scope:church:read'] } as never,
      { verifyToken: async () => ({ payload: { sub: 'user' } }) } as never,
    );
    const request = { headers: { authorization: 'Bearer token' } };
    const next = jest.fn();
    await middleware.use(request as never, {} as never, next);
    expect(next).toHaveBeenCalledWith();
    expect(request).toMatchObject({ profile: { is_admin_hq: false, branch_id: 'branch' } });
    expect(prisma.profile.findUnique).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: 'inactive', archived_at: null },
    { status: 'active', archived_at: new Date() },
  ])('rejects disabled or archived profiles: %s', async (state) => {
    const middleware = new RequestContextMiddleware(
      new RequestContextService(),
      {
        profile: {
          findUnique: async () => ({
            ...state,
            id: 'profile',
            church_id: 'church',
            role: ['secretary'],
            is_admin_hq: false,
            church: {
              archived_at: null,
              subscription: { paid_until: new Date(Date.now() + 60000) },
            },
          }),
        },
      } as never,
      { getUserPermissions: async () => [] } as never,
      { verifyToken: async () => ({ payload: { sub: 'user' } }) } as never,
    );
    const next = jest.fn();
    await middleware.use(
      { headers: { authorization: 'Bearer token' } } as never,
      {} as never,
      next,
    );
    expect(next).toHaveBeenCalledWith(expect.any(ForbiddenException));
  });

  it.each([
    ['/api/v1/members', null, 402],
    ['/api/v1/giving/transactions', null, 402],
    ['/api/v1/sync/bootstrap', null, 402],
    ['/api/v1/members', new Date(Date.now() - 60000), 403],
    ['/api/v1/billing/checkout', null, 0],
    ['/api/v1/billing/verify', null, 0],
    ['/api/v1/auth/logout', null, 0],
    ['/api/v1/auth/session', null, 0],
    ['/api/v1/profiles/me', null, 0],
    ['/api/v1/assistant/context', null, 0],
    ['/api/v1/assistant/message', null, 0],
    ['/api/v1/assistant/context/other', null, 402],
    ['/api/v1/assistant/other', null, 402],
    ['/api/v1/profiles/me/other', null, 402],
    ['/api/v1/members?returnTo=/api/v1/billing/checkout', null, 402],
    ['/api/v1/members', new Date(Date.now() + 60000), 0],
  ])(
    'enforces subscription activation/expiry without blocking account recovery: %s',
    async (path, paidUntil, expected) => {
      const middleware = new RequestContextMiddleware(
        new RequestContextService(),
        {
          profile: {
            findUnique: async () => ({
              id: 'profile',
              church_id: 'church',
              role: ['church_admin'],
              status: 'active',
              is_admin_hq: true,
              church: { archived_at: null, subscription: { paid_until: paidUntil } },
            }),
          },
        } as never,
        { getUserPermissions: async () => ['billing:read', 'billing:update'] } as never,
        { verifyToken: async () => ({ payload: { sub: 'user' } }) } as never,
      );
      const next = jest.fn();
      await middleware.use(
        { originalUrl: path, headers: { authorization: 'Bearer token' } } as never,
        {} as never,
        next,
      );
      if (expected) {
        expect(next).toHaveBeenCalledWith(expect.any(HttpException));
        expect((next.mock.calls[0][0] as HttpException).getStatus()).toBe(expected);
      } else expect(next).toHaveBeenCalledWith();
    },
  );

  it('never drops branch filters for unassigned report readers or exports', async () => {
    const reports = {
      getFinancialReport: jest.fn(),
      getAttendanceReport: jest.fn(),
      getMemberReport: jest.fn(),
    };
    const controller = new ReportsController(reports as never);
    const request = {
      profile: { church_id: 'church', is_admin_hq: false, permissions: ['reports:financial:read'] },
    } as never;
    await controller.getFinancialReport({ branchId: 'foreign' }, request);
    await controller.getAttendanceReport({}, request);
    await controller.getMemberReport({}, request);
    await controller.exportReport({ type: 'financial' }, request);
    for (const method of Object.values(reports)) {
      expect(method).toHaveBeenCalledWith(
        'church',
        undefined,
        undefined,
        '00000000-0000-0000-0000-000000000000',
        ...(method === reports.getFinancialReport ? [undefined] : []),
      );
    }
  });
});
