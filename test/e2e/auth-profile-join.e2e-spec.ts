import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../src/prisma/prisma.service';
import { hydratedProfile } from '../../src/auth/services/hydrated-profile';
import { AuthenticatorService } from '../../src/auth/services/authenticator.service';
import { JwtAuthGuard } from '../../src/auth/guards/jwt-auth.guard';
import { queryMetrics } from '../../src/prisma/query-metrics';
import { RequestContextMiddleware } from '../../src/common/middleware/request-context.middleware';
import { RequestContextService } from '../../src/common/services/request-context.service';
import { PermissionsService } from '../../src/auth/services/permissions.service';
import { AuthenticatedRequest } from '../../src/common/decorators/current-user.decorator';
import { ForbiddenException, HttpException } from '@nestjs/common';

process.env.DB_POOL_MAX = '1';
describe('Joined profile hydration', () => {
  const prisma = new PrismaService();
  const churches: string[] = [];
  const users: string[] = [];
  beforeAll(async () => {
    for (let i = 0; i < 2; i++) {
      const church = await prisma.church.create({ data: { name: 'Joined profile test' } });
      churches.push(church.id);
      await prisma.platformSubscription.create({
        data: {
          church_id: church.id,
          plan: i ? 'essentials' : 'enterprise',
          cycle: 'monthly',
          paid_until: new Date('2099-01-01'),
          enterprise_limits: { members: 100, staff: 5, locations: 3 },
        },
      });
      const branch = await prisma.branch.create({ data: { church_id: church.id, name: 'Branch' } });
      const user = randomUUID();
      users.push(user);
      await prisma.profile.create({
        data: {
          user_id: user,
          church_id: church.id,
          branch_id: branch.id,
          first_name: 'Fixture',
          last_name: 'Staff',
          role: ['church_admin'],
          two_factor_enabled: !i,
        },
      });
      if (!i)
        await prisma.profileAuthenticator.create({
          data: {
            user_id: user,
            secret_ciphertext: 'private-fixture-secret',
            revision: randomUUID(),
            recovery_hashes: ['private-fixture-recovery'],
          },
        });
    }
  });
  afterAll(async () => {
    for (const churchId of churches) {
      await prisma.profile.deleteMany({ where: { church_id: churchId } });
      await prisma.branch.deleteMany({ where: { church_id: churchId } });
      await prisma.platformSubscription.deleteMany({ where: { church_id: churchId } });
      await prisma.auditLog.deleteMany({ where: { church_id: churchId } });
      await prisma.church.delete({ where: { id: churchId } });
    }
    await prisma.$disconnect();
  });
  it('matches the prior relation result with one query and omits all secret fields', async () => {
    const before = { queries: 0, milliseconds: 0, startedAt: performance.now() };
    const old = await queryMetrics.run(
      before,
      async () =>
        await prisma.profile.findUnique({
          where: { user_id: users[0] },
          select: {
            id: true,
            church_id: true,
            branch_id: true,
            member_id: true,
            role: true,
            status: true,
            archived_at: true,
            is_admin_hq: true,
            two_factor_enabled: true,
            authenticator: { select: { revision: true } },
            church: { select: { archived_at: true, subscription: true } },
          },
        }),
    );
    const after = { queries: 0, milliseconds: 0, startedAt: performance.now() };
    const joined = await queryMetrics.run(after, () => hydratedProfile(prisma, users[0]));
    expect(joined).toEqual(old);
    expect(after.queries).toBe(1);
    expect(before.queries).toBe(4);
    expect(JSON.stringify(joined)).not.toContain('private-fixture');
    expect((await hydratedProfile(prisma, users[1]))?.church.subscription?.plan).toBe('essentials');
    expect(await hydratedProfile(prisma, randomUUID())).toBeNull();
  });
  it('keeps MFA/session revision, revocation and absolute expiry enforcement with joined data', async () => {
    const user = users[0],
      session = randomUUID();
    const profile = await hydratedProfile(prisma, user);
    await prisma.verifiedMfaSession.create({
      data: {
        user_id: user,
        session_id: session,
        revision: profile!.authenticator!.revision,
        expires_at: new Date('2099-01-01'),
      },
    });
    const authenticator = new AuthenticatorService(prisma, {} as never, {} as never, {} as never);
    let revoked = false;
    const guard = new JwtAuthGuard(
      {} as never,
      { get: async () => (revoked ? true : null) } as never,
      authenticator,
    );
    const context = () =>
      ({
        switchToHttp: () => ({
          getRequest: () => ({
            headers: { authorization: 'Bearer fixture' },
            profile,
            verifiedJwt: { sub: user, session_id: session },
          }),
        }),
      }) as never;
    expect(await guard.canActivate(context())).toBe(true);
    revoked = true;
    await expect(guard.canActivate(context())).rejects.toThrow('Token has been revoked');
    revoked = false;
    await prisma.verifiedMfaSession.update({
      where: { user_id_session_id: { user_id: user, session_id: session } },
      data: { expires_at: new Date('2020-01-01') },
    });
    await expect(guard.canActivate(context())).rejects.toThrow('Session no longer approved');
    await prisma.verifiedMfaSession.update({
      where: { user_id_session_id: { user_id: user, session_id: session } },
      data: { expires_at: new Date('2099-01-01'), revision: 'outdated' },
    });
    await expect(guard.canActivate(context())).rejects.toThrow('Session no longer approved');
  });

  it('reflects account deactivation, subscription expiry and church archive on the next request', async () => {
    const permissions = new PermissionsService(
      prisma,
      { get: async () => null } as never,
      {} as never,
    );
    const middleware = new RequestContextMiddleware(
      new RequestContextService(),
      prisma,
      permissions,
      { verifyToken: async () => ({ payload: { sub: users[1] } }) } as never,
    );
    const run = async (method = 'GET', path = '/api/v1/members') => {
      const next = jest.fn();
      const req = {
        headers: { authorization: 'Bearer fixture' },
        method,
        path,
        originalUrl: path,
      } as AuthenticatedRequest;
      await middleware.use(req, {} as never, next);
      return { next, profile: req.profile };
    };
    const active = await run();
    expect(active.next).toHaveBeenCalledWith();
    expect(active.profile?.subscriptionReadOnly).toBe(false);
    await prisma.profile.update({ where: { user_id: users[1] }, data: { status: 'inactive' } });
    expect((await run()).next).toHaveBeenCalledWith(expect.any(ForbiddenException));
    await prisma.profile.update({ where: { user_id: users[1] }, data: { status: 'active' } });
    await prisma.platformSubscription.update({
      where: { church_id: churches[1] },
      data: { paid_until: new Date('2020-01-01') },
    });
    const expired = await run();
    expect(expired.next).toHaveBeenCalledWith();
    expect(expired.profile?.subscriptionReadOnly).toBe(true);
    expect(expired.profile?.permissions).not.toContain('members:new:create');
    const blocked = await run('POST');
    expect(blocked.next).toHaveBeenCalledWith(expect.any(HttpException));
    const error = blocked.next.mock.calls[0][0] as HttpException;
    expect(error.getStatus()).toBe(403);
    expect(error.getResponse()).toMatchObject({ code: 'SUBSCRIPTION_READ_ONLY' });
    expect((await run('POST', '/api/v1/reports/export')).next).toHaveBeenCalledWith();
    expect((await run('POST', '/api/v1/billing/checkout')).next).toHaveBeenCalledWith();
    // A church that has never paid still does not gain paid read access.
    await prisma.platformSubscription.update({
      where: { church_id: churches[1] },
      data: { paid_until: null },
    });
    const unpaid = await run();
    expect(unpaid.next).toHaveBeenCalledWith(expect.any(HttpException));
    expect((unpaid.next.mock.calls[0][0] as HttpException).getStatus()).toBe(402);
    await prisma.platformSubscription.update({
      where: { church_id: churches[1] },
      data: { paid_until: new Date('2099-01-01') },
    });
    const renewed = await run('POST');
    expect(renewed.next).toHaveBeenCalledWith();
    expect(renewed.profile?.subscriptionReadOnly).toBe(false);
    await prisma.church.update({ where: { id: churches[1] }, data: { archived_at: new Date() } });
    expect((await run()).next).toHaveBeenCalledWith(expect.any(ForbiddenException));
  });
});
