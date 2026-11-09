import type { PlatformSubscription, Profile } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

type ProfileFields = Pick<
  Profile,
  | 'id'
  | 'church_id'
  | 'branch_id'
  | 'member_id'
  | 'role'
  | 'status'
  | 'archived_at'
  | 'is_admin_hq'
  | 'two_factor_enabled'
>;
type Row = ProfileFields & {
  authenticator_revision: string | null;
  church_archived_at: Date | null;
  subscription_church_id: string | null;
  subscription_plan: PlatformSubscription['plan'];
  subscription_cycle: PlatformSubscription['cycle'];
  subscription_paid_until: Date | null;
  subscription_period_started_at: Date | null;
  subscription_scheduled_plan: PlatformSubscription['scheduled_plan'];
  subscription_scheduled_cycle: PlatformSubscription['scheduled_cycle'];
  subscription_access_grants: PlatformSubscription['access_grants'];
  subscription_enterprise_limits: PlatformSubscription['enterprise_limits'];
  subscription_created_at: Date;
};

/** One fresh joined read; never selects authenticator secrets or recovery codes. */
export async function hydratedProfile(prisma: PrismaService, userId: string) {
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT p.id, p.church_id, p.branch_id, p.member_id, p.role, p.status,
      p.archived_at, p.is_admin_hq, p.two_factor_enabled,
      a.revision AS authenticator_revision, c.archived_at AS church_archived_at,
      s.church_id AS subscription_church_id, s.plan::text AS subscription_plan,
      s.cycle::text AS subscription_cycle, s.paid_until AS subscription_paid_until,
      s.period_started_at AS subscription_period_started_at,
      s.scheduled_plan::text AS subscription_scheduled_plan,
      s.scheduled_cycle::text AS subscription_scheduled_cycle,
      s.access_grants AS subscription_access_grants,
      s.enterprise_limits AS subscription_enterprise_limits,
      s.created_at AS subscription_created_at
    FROM profiles p JOIN churches c ON c.id = p.church_id
    LEFT JOIN profile_authenticators a ON a.user_id = p.user_id
    LEFT JOIN platform_subscriptions s ON s.church_id = p.church_id
    WHERE p.user_id = ${userId}
  `;
  const row = rows[0];
  if (!row) return null;
  const subscription: PlatformSubscription | null = row.subscription_church_id
    ? {
        church_id: row.subscription_church_id,
        plan: row.subscription_plan,
        cycle: row.subscription_cycle,
        paid_until: row.subscription_paid_until,
        period_started_at: row.subscription_period_started_at,
        scheduled_plan: row.subscription_scheduled_plan,
        scheduled_cycle: row.subscription_scheduled_cycle,
        access_grants: row.subscription_access_grants,
        enterprise_limits: row.subscription_enterprise_limits,
        created_at: row.subscription_created_at,
      }
    : null;
  return {
    id: row.id,
    church_id: row.church_id,
    branch_id: row.branch_id,
    member_id: row.member_id,
    role: row.role,
    status: row.status,
    archived_at: row.archived_at,
    is_admin_hq: row.is_admin_hq,
    two_factor_enabled: row.two_factor_enabled,
    authenticator: row.authenticator_revision ? { revision: row.authenticator_revision } : null,
    church: { archived_at: row.church_archived_at, subscription },
  };
}
