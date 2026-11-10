import { isSubscriptionRead, subscriptionWriteExempt } from './subscription-access';
import { measureStage } from '../prisma/query-metrics';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from '../auth/decorators/permissions.decorator';
import { CanActivate, ExecutionContext, Injectable, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedRequest } from '../common/decorators/current-user.decorator';
import { requestEntitlements } from './entitlements';
import { featureForApiPath, featureForPermission, filterPlanPermissions } from './feature-policy';

/** Staff permissions run first; plan eligibility applies to reads and writes alike. */
@Injectable()
export class PlanFeatureGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector = new Reflector(),
  ) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!req.profile || req.method === 'OPTIONS') return true;
    const path = req.path.replace(/^\/api\/v1(?=\/|$)/, '');
    const entitlement = await measureStage('entitlements', () =>
      requestEntitlements(this.prisma, req.profile!.church_id, req.subscriptionSnapshot),
    );
    if (
      entitlement.readOnly &&
      !isSubscriptionRead(req.method, path) &&
      !subscriptionWriteExempt(path)
    )
      throw new ForbiddenException({
        code: 'SUBSCRIPTION_READ_ONLY',
        message:
          'Renew your subscription to make changes. Viewing, exports and billing remain available.',
      });
    const features = entitlement.active || entitlement.readOnly ? entitlement.features : [];
    // Composite endpoints (including offline/sync) must not use premium grants
    // from a role to return data outside the church's current subscription.
    req.profile.permissions = filterPlanPermissions(req.profile.permissions ?? [], features);
    // Only these existing-payment/reduction actions bypass feature eligibility.
    // Callbacks without a profile still enforce signatures in their handlers.
    if (
      (req.method === 'GET' && /^\/giving\/verify\/[^/]+$/.test(path)) ||
      (req.method === 'PATCH' && /^\/giving\/recurring\/[^/]+\/(?:cancel|pause)$/.test(path))
    )
      return true;
    const required =
      this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];
    const requiredFeatures = [featureForApiPath(path), ...required.map(featureForPermission)];
    if (path === '/reports/export')
      requiredFeatures.push(req.body?.type === 'financial' ? 'giving' : 'reports');
    if (/^\/attendance\/attendance(?:\/|$)/.test(path) && (req.query?.eventId || req.body?.eventId))
      requiredFeatures.push('events');
    if (
      /^\/events(?:\/[^/]+)?$/.test(path) &&
      (req.body?.isFree === false || Number(req.body?.price) > 0)
    )
      requiredFeatures.push('tickets');
    if (/^\/(?:templates|broadcasts|messages)(?:\/|$)/.test(path)) {
      const channel = req.body?.channel ?? req.query?.channel;
      if (channel === 'sms' || channel === 'whatsapp') requiredFeatures.push(channel);
    }
    if (/^\/giving\/transactions\/[^/]+\/send-receipt$/.test(path)) {
      requiredFeatures.push(req.body?.channel === 'whatsapp' ? 'whatsapp' : 'email');
    }
    const feature = requiredFeatures.find((feature) => feature && !features.includes(feature));
    if (feature) {
      throw new ForbiddenException({
        code: 'PLAN_FEATURE_REQUIRED',
        message:
          'This feature is not available on your church subscription. Contact your church administrator.',
        details: { feature },
      });
    }
    return true;
  }
}
@Injectable()
export class BillingAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const roles = req.profile?.roles ?? [req.profile?.role];
    if (!roles.some((role) => role === 'church_admin' || role === 'super_admin'))
      throw new ForbiddenException('Only church administrators manage subscriptions.');
    return true;
  }
}
