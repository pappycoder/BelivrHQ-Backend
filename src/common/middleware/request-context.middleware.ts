import { entitlementsFromSubscription } from '../../billing/entitlements';
import {
  isSubscriptionRead,
  subscriptionWriteExempt,
  readOnlyPermission,
} from '../../billing/subscription-access';
import { hydratedProfile } from '../../auth/services/hydrated-profile';
/**
 * @file request-context.middleware.ts
 * @description Middleware that populates RequestContext from the authenticated request.
 *
 * Runs on every request at the Express layer (before NestJS guards).
 * Extracts the Bearer token, verifies it to get the user's Supabase ID, then looks up the Profile
 * from the database to get church_id/branch_id/role. Attaches both user
 * and profile to the request so downstream guards, controllers, and the
 * RequestContextService all have access to the tenant context.
 *
 * @module common/middleware/request-context
 * @since 1.0.0
 */

import { Injectable, NestMiddleware, ForbiddenException, HttpException } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { RequestContextService } from '../services/request-context.service';
import { AuthenticatedRequest } from '../decorators/current-user.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { SupabaseJwtPayload } from '../../auth/strategies/jwt.strategy';
import { PermissionsService } from '../../auth/services/permissions.service';
import { JwksService } from '../../auth/services/jwks.service';
import { queryMetrics, measureStage } from '../../prisma/query-metrics';
import { errors } from 'jose';
import { accessRoles } from '../../auth/role-policy';

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(
    private readonly requestContext: RequestContextService,
    private readonly prisma: PrismaService,
    private readonly permissionsService: PermissionsService,
    private readonly jwks: JwksService,
  ) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    return queryMetrics.run({ queries: 0, milliseconds: 0, startedAt: performance.now() }, () =>
      this.hydrate(req, res, next),
    );
  }

  private async hydrate(req: Request, _res: Response, next: NextFunction): Promise<void> {
    // Public price conversion must work even with an expired browser session.
    if (
      req.method === 'GET' &&
      (req.originalUrl ?? req.url ?? '').split('?')[0] === '/api/v1/pricing/subscriptions'
    ) {
      next();
      return;
    }
    const authReq = req as AuthenticatedRequest;

    // Extract Bearer token from Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      next();
      return;
    }

    const token = authHeader.slice(7);
    if (!token) {
      next();
      return;
    }

    // Verify identity before any tenant lookup; the guard reuses this result.
    let sub: string;
    try {
      const { payload } = await measureStage('jwt', () => this.jwks.verifyToken(token));
      authReq.verifiedJwt = payload;
      sub = payload.sub ?? '';
      if (!sub) {
        next();
        return;
      }
    } catch (error) {
      if (error instanceof errors.JOSEError) next();
      else next(error);
      return;
    }

    // Set minimal user info — JwtAuthGuard will overwrite with full verified data
    if (!authReq.user) {
      authReq.user = {
        id: sub,
        sub,
        email: undefined,
        phone: undefined,
        app_metadata: {},
        user_metadata: {},
        role: undefined,
      } as SupabaseJwtPayload;
    }

    // Look up the user's profile to get church_id, branch_id, and roles.
    // role is a text array ordered by rank desc; expose the primary role
    // as `role` and the full set as `roles` for downstream consumers.
    if (!authReq.profile) {
      const profile = await measureStage('profile', () => hydratedProfile(this.prisma, sub));
      if (profile) {
        profile.role = accessRoles(profile.role);
        if (profile.role.length === 0) {
          next(
            new ForbiddenException('No staff role assigned. Contact your church administrator.'),
          );
          return;
        }
        const subscription = profile.church?.subscription;
        authReq.subscriptionSnapshot = {
          churchId: profile.church_id,
          subscription: subscription ?? null,
        };
        const entitlement = entitlementsFromSubscription(subscription ?? null);
        const route = (req.originalUrl ?? req.url ?? req.path ?? '')
          .split('?')[0]
          .replace(/^\/api\/v1(?=\/|$)/, '');
        const readAllowed =
          entitlement.readOnly &&
          (isSubscriptionRead(req.method, route) || subscriptionWriteExempt(route));
        const billingExempt =
          /^\/api\/v1\/(?:auth(?:\/|$)|billing(?:\/|$)|profiles\/me$|assistant\/(?:context|message)$)/.test(
            (req.originalUrl ?? req.url ?? req.path ?? '').split('?')[0],
          );
        if (
          profile.status === 'active' &&
          !profile.archived_at &&
          !profile.church?.archived_at &&
          !entitlement.active &&
          !readAllowed &&
          !entitlement.readOnly &&
          !billingExempt
        ) {
          next(
            new HttpException(
              'A BelivrHQ subscription is required. Your administrator can complete checkout.',
              402,
            ),
          );
          return;
        }
        if (
          entitlement.readOnly &&
          !isSubscriptionRead(req.method, route) &&
          !subscriptionWriteExempt(route)
        ) {
          next(
            new HttpException(
              {
                code: 'SUBSCRIPTION_READ_ONLY',
                message:
                  'Your subscription has ended. You can view and export records, or renew through billing.',
              },
              403,
            ),
          );
          return;
        }
        const permissions = await measureStage('permissions', () =>
          this.permissionsService.getUserPermissions(
            profile.church_id,
            profile.role,
            profile.is_admin_hq,
            authReq.subscriptionSnapshot,
          ),
        );
        authReq.profile = {
          id: profile.id,
          two_factor_enabled: profile.two_factor_enabled,
          authenticator: profile.authenticator,
          church_id: profile.church_id,
          branch_id: profile.branch_id ?? undefined,
          member_id: profile.member_id ?? undefined,
          role: profile.role[0] ?? '',
          roles: profile.role,
          status: profile.status,
          profile_archived_at: profile.archived_at?.toISOString(),
          is_admin_hq: profile.is_admin_hq,
          permissions: entitlement.readOnly ? permissions.filter(readOnlyPermission) : permissions,
          subscriptionReadOnly: entitlement.readOnly,
          subscriptionPaidUntil: entitlement.active
            ? entitlement.subscription?.paid_until?.toISOString()
            : undefined,
          church_archived_at: profile.church?.archived_at?.toISOString(),
        };
      }
    }

    const profile = authReq.profile;

    // Reject requests from deactivated accounts before they reach any handler
    if (profile && (profile.status !== 'active' || profile.profile_archived_at)) {
      next(new ForbiddenException('Account deactivated. Contact your church administrator.'));
      return;
    }

    // Reject requests from accounts whose church has been archived, except the
    // restore route — an admin session must be able to restore their own church.
    const isChurchRestore = req.method === 'POST' && req.path.endsWith('/church/restore');
    if (profile && profile.church_archived_at && !isChurchRestore) {
      next(new ForbiddenException('This church has been archived.'));
      return;
    }

    const context = {
      userId: authReq.user.id,
      churchId: profile?.church_id || '',
      branchId: profile?.branch_id,
      role: profile?.role || '',
      viewer: profile,
    };

    this.requestContext.run(context, () => {
      next();
    });
  }
}
