import { PlanFeature } from './plans';

/** Plan eligibility is independent of staff role, HQ status and CRUD action. */
export function featureForPermission(permission: string): PlanFeature | undefined {
  const [resource, surface] = permission.split(':');
  if (permission === 'roles:create') return 'custom_roles';
  if (resource === 'events' && surface === 'tickets') return 'tickets';
  if (['assets', 'asset_categories'].includes(resource)) return 'assets';
  if (['pastoral', 'pastoral_confidential', 'appointments'].includes(resource)) return 'pastoral';
  if (['departments', 'cell_groups'].includes(resource)) return 'groups';
  if (['sermons', 'media'].includes(resource)) return 'media';
  // The internal inbox ("emails") belongs to the email feature (Community);
  // WhatsApp/SMS message threads are their own Network features. Unmapped
  // resources fall through as plan-free, which let Inbox/Messages leak into
  // Essentials.
  if (['emails', 'templates', 'broadcasts', 'messages'].includes(resource)) return 'email';
  if (resource === 'whatsapp') return 'whatsapp';
  if (resource === 'sms') return 'sms';
  if (resource === 'reports' && (surface === 'financial' || surface === 'view')) return 'giving';
  if (resource === 'integrations') return 'giving';
  if (resource === 'calls') return 'calls';
  if (resource === 'webhooks') return 'webhooks';
  if (['giving', 'events', 'forms', 'reports', 'analytics'].includes(resource))
    return resource as PlanFeature;
  return undefined;
}

export function filterPlanPermissions(
  permissions: readonly string[],
  features: readonly string[],
): string[] {
  return permissions.filter((permission) => {
    const feature = featureForPermission(permission);
    return !feature || features.includes(feature);
  });
}

export function featureForApiPath(path: string): PlanFeature | undefined {
  if (/^\/members\/[^/]+\/giving(?:\/|$)/.test(path)) return 'giving';
  if (/^\/admin\/dashboard(?:\/|$)/.test(path)) return 'pastoral';
  if (/^\/analytics(?:\/|$)/.test(path)) return 'analytics';
  if (/^\/(?:assets|asset-categories)(?:\/|$)/.test(path)) return 'assets';
  if (/^\/(?:pastoral|appointments)(?:\/|$)/.test(path)) return 'pastoral';
  if (/^\/forms(?:\/|$)/.test(path)) return 'forms';
  if (/^\/admin\/(?:departments|cell-groups)(?:\/|$)/.test(path)) return 'groups';
  if (/^\/reports\/financial(?:\/|$)/.test(path)) return 'giving';
  if (path === '/reports/export') return undefined; // Guard resolves the selected report type.
  if (/^\/reports(?:\/|$)/.test(path)) return 'reports';
  if (/^\/events\/(?:management\/tickets|[^/]+\/(?:tiers|tickets))(?:\/|$)/.test(path))
    return 'tickets';
  if (/^\/events(?:\/|$)/.test(path)) return 'events';
  if (/^\/giving\/cell-groups(?:\/|$)/.test(path)) return 'groups';
  if (/^\/church\/integrations(?:\/|$)/.test(path)) return 'giving';
  if (/^\/giving(?:\/|$)/.test(path)) return 'giving';
  if (/^\/(?:templates|broadcasts|messages)(?:\/|$)/.test(path)) return 'email';
  if (/^\/email(?:\/|$)/.test(path)) return 'email';
  if (/^\/whatsapp(?:\/|$)/.test(path)) return 'whatsapp';
  if (/^\/calls(?:\/|$)/.test(path)) return 'calls';
  if (/^\/webhooks(?:\/|$)/.test(path)) return 'webhooks';
  if (/^\/(?:sermons|media\/library)(?:\/|$)/.test(path)) return 'media';
  return undefined;
}

/** Shared uploads must keep profile/church branding available on Essentials. */
export function featureForMediaFolder(folder: string): PlanFeature | undefined {
  if (['churches', 'branches', 'profiles'].includes(folder)) return undefined;
  if (folder === 'assets') return 'assets';
  if (folder === 'form-attachments') return 'forms';
  return 'media';
}
