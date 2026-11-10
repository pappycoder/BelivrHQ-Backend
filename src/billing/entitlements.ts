import { accessGrants, projectSubscription, resolvePaymentAccess } from './payment-access';
import { ForbiddenException, ConflictException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { PlatformSubscription } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PLAN_CAPACITIES, planFeatures, PlanFeature } from './plans';

export function entitlementsFromSubscription(subscription: PlatformSubscription | null) {
  const original = subscription;
  const now = new Date();
  const access = resolvePaymentAccess(subscription?.access_grants, now);
  const grants = accessGrants(subscription?.access_grants);
  // Only legitimately paid, naturally expired periods retain read access.
  // Current review/refund holds must never be bypassed by this fallback.
  const restricted = grants.some(
    (g) => g.state !== 'clear' && Date.parse(g.start) <= +now && Date.parse(g.end) > +now,
  );
  const past = grants
    .filter((g) => g.state === 'clear' && Date.parse(g.end) <= +now)
    .sort((a, b) => Date.parse(b.end) - Date.parse(a.end));
  const previous = past
    .map(
      (g) =>
        resolvePaymentAccess(original?.access_grants, new Date(Date.parse(g.end) - 1)).selected,
    )
    .find((g) => !!g && Date.parse(g.end) <= +now);
  const readOnly =
    !access.active &&
    !restricted &&
    (access.tracked ? !!previous : !!(original?.paid_until && original.paid_until <= now));
  subscription = projectSubscription(subscription);
  if (subscription && access.selected)
    subscription = { ...subscription, plan: access.selected.plan, cycle: access.selected.cycle };
  const plan = (readOnly ? (previous?.plan ?? original?.plan) : subscription?.plan) ?? 'essentials';
  const agreement = subscription?.enterprise_limits as Record<string, unknown> | null;
  const enterpriseLimit = (key: string) =>
    Number.isSafeInteger(agreement?.[key]) && Number(agreement?.[key]) >= 0
      ? Number(agreement?.[key])
      : 0;
  const limits =
    plan === 'enterprise'
      ? {
          members: enterpriseLimit('members'),
          staff: enterpriseLimit('staff'),
          locations: enterpriseLimit('locations'),
        }
      : PLAN_CAPACITIES[plan];
  return {
    subscription,
    readOnly,
    plan,
    limits,
    features: planFeatures(plan),
    get active() {
      return access.tracked
        ? access.active
        : !!(subscription?.paid_until && subscription.paid_until > new Date());
    },
  };
}
/** Internal snapshot from this HTTP request only; never cache across requests. */
export interface SubscriptionSnapshot {
  churchId: string;
  subscription: PlatformSubscription | null;
}

export async function churchEntitlements(prisma: PrismaService, churchId: string) {
  return entitlementsFromSubscription(
    await prisma.platformSubscription.findUnique({
      where: { church_id: churchId },
    }),
  );
}

/** Guards may reuse hydration; business writes continue to fetch fresh state. */
export async function requestEntitlements(
  prisma: PrismaService,
  churchId: string,
  snapshot?: SubscriptionSnapshot,
) {
  if (
    snapshot?.churchId === churchId &&
    (!snapshot.subscription || snapshot.subscription.church_id === churchId)
  )
    return entitlementsFromSubscription(snapshot.subscription);
  return churchEntitlements(prisma, churchId);
}

export async function assertPlanFeature(
  prisma: PrismaService,
  churchId: string,
  feature: PlanFeature,
) {
  const entitlement = await churchEntitlements(prisma, churchId);
  if (!entitlement.active || !entitlement.features.includes(feature))
    throw new ForbiddenException({
      code: 'PLAN_FEATURE_REQUIRED',
      message:
        'This feature is not available on your church subscription. Contact your church administrator.',
      details: { feature },
    });
}
export async function reserveStaffSeat(prisma: PrismaService, churchId: string, email: string) {
  const normalized = email.trim().toLowerCase();
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM churches WHERE id=${churchId} FOR UPDATE`;
    await tx.staffInvitationReservation.deleteMany({
      where: { church_id: churchId, expires_at: { lte: new Date() } },
    });
    if (
      await tx.staffInvitationReservation.findUnique({
        where: { church_id_email: { church_id: churchId, email: normalized } },
      })
    )
      throw new ConflictException(
        'An invitation for this email is already being prepared. Please retry shortly.',
      );
    return tx.staffInvitationReservation.create({
      data: {
        id: randomUUID(),
        church_id: churchId,
        email: normalized,
        expires_at: new Date(Date.now() + 15 * 60 * 1000),
      },
    });
  });
}
export async function releaseStaffSeat(prisma: PrismaService, id: string) {
  await prisma.staffInvitationReservation.deleteMany({ where: { id } });
}

/** Read/download paths may retain expired paid access; writes use assertPlanFeature. */
export async function assertPlanReadableFeature(
  prisma: PrismaService,
  churchId: string,
  feature: PlanFeature,
) {
  const entitlement = await churchEntitlements(prisma, churchId);
  if (!(entitlement.active || entitlement.readOnly) || !entitlement.features.includes(feature))
    throw new ForbiddenException({
      code: 'PLAN_FEATURE_REQUIRED',
      message: 'This feature is not available on your church subscription.',
      details: { feature },
    });
}
