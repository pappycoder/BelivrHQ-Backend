import type { BillingCycle, SubscriptionPlan, PlatformSubscription } from '@prisma/client';
import { record } from '../giving/services/payment-lifecycle';

export interface AccessGrant {
  reference: string;
  plan: SubscriptionPlan;
  cycle: BillingCycle;
  start: string;
  end: string;
  state: 'clear' | 'review' | 'revoked';
  upgrade?: boolean;
}
export interface PaymentAccess {
  grants: AccessGrant[];
}
export function accessGrants(value: unknown): AccessGrant[] {
  const grants = record(value).grants;
  return Array.isArray(grants) ? (grants as AccessGrant[]) : [];
}
/** A refund changes only its own grant. Later renewals keep their original paid dates. */
export function resolvePaymentAccess(value: unknown, now = new Date()) {
  const grants = accessGrants(value);
  const covering = grants.filter(
    (grant) => Date.parse(grant.start) <= +now && Date.parse(grant.end) > +now,
  );
  // An upgrade replaces the base plan only while that upgrade remains valid.
  const valid = covering.filter((grant) => grant.state === 'clear');
  const base = valid.filter((grant) => !grant.upgrade).at(-1);
  const selected = base ? (valid.filter((grant) => grant.upgrade).at(-1) ?? base) : undefined;
  return {
    tracked: grants.length > 0,
    selected,
    held: covering.some((grant) => grant.state === 'review'),
    active: !!selected,
  };
}
export function projectSubscription<T extends PlatformSubscription | null>(subscription: T): T {
  if (!subscription) return subscription;
  const access = resolvePaymentAccess(subscription.access_grants);
  if (!access.tracked) return subscription;
  return {
    ...subscription,
    ...(access.selected ? { plan: access.selected.plan, cycle: access.selected.cycle } : {}),
    paid_until: access.selected ? new Date(access.selected.end) : null,
    period_started_at: access.selected ? new Date(access.selected.start) : null,
  };
}
export function appendAccessGrant(
  value: unknown,
  baseline: {
    plan: SubscriptionPlan;
    cycle: BillingCycle;
    paid_until: Date | null;
    period_started_at?: Date | null;
  },
  grant: AccessGrant,
): PaymentAccess {
  const grants = accessGrants(value);
  if (!grants.length && baseline.paid_until)
    grants.push({
      reference: 'legacy',
      plan: baseline.plan,
      cycle: baseline.cycle,
      start: (baseline.period_started_at ?? new Date(0)).toISOString(),
      end: baseline.paid_until.toISOString(),
      state: 'clear',
    });
  return { grants: [...grants.filter((item) => item.reference !== grant.reference), grant] };
}
