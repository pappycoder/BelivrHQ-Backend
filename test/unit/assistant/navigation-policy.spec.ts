import {
  checkRule,
  featureForPath,
  featureForPermission,
  matchRoutePermission,
  permissionReturnTo,
  planAllowsPath,
  planAllowsPermission,
} from '../../../src/assistant/routes.generated';

describe('Assistant navigation obeys application permissions and paid features', () => {
  it.each([
    ['/insights/reports', 'reports'],
    ['/insights', 'analytics'],
    ['/operations/assets', 'assets'],
    ['/gatherings/events/registrations', 'events'],
    ['/gatherings/events/tiers', 'tickets'],
    ['/gatherings/events/tickets', 'tickets'],
    ['/gatherings/groups', 'groups'],
    ['/gatherings/events', 'events'],
    ['/connect/appointments', 'pastoral'],
    ['/connect/inbox', 'email'],
    ['/library/forms', 'forms'],
    ['/library/media', 'media'],
    ['/people/pastoral', 'pastoral'],
    ['/admin/channels', 'giving'],
    ['/analytics', 'analytics'],
    ['/assets', 'assets'],
    ['/pastoral', 'pastoral'],
    ['/appointments', 'pastoral'],
    ['/forms', 'forms'],
    ['/departments', 'groups'],
    ['/admin/departments', 'groups'],
    ['/admin/cell-groups', 'groups'],
    ['/reports', 'giving'],
    ['/reports/financial', 'giving'],
    ['/reports/attendance', 'reports'],
    ['/events/management', 'tickets'],
    ['/events/id/tiers', 'tickets'],
    ['/events', 'events'],
    ['/admin/integrations', 'giving'],
    ['/giving', 'giving'],
    ['/sermons', 'media'],
    ['/media', 'media'],
    ['/communication/templates', 'email'],
    ['/communication/broadcasts', 'email'],
    ['/communication/messages', 'email'],
    ['/admin/settings/webhooks', 'webhooks'],
  ])('requires the matching %s feature entitlement: %s', (path, feature) => {
    expect(featureForPath(path)).toBe(feature);
    expect(planAllowsPath(undefined, path)).toBe(false);
    expect(planAllowsPath([], path)).toBe(false);
    expect(planAllowsPath([feature], path)).toBe(true);
  });
  it.each([
    ['roles:create', 'custom_roles'],
    ['events:tickets:read', 'tickets'],
    ['assets:list:read', 'assets'],
    ['asset_categories:read', 'assets'],
    ['pastoral:notes:read', 'pastoral'],
    ['pastoral_confidential:read', 'pastoral'],
    ['appointments:read', 'pastoral'],
    ['departments:read', 'groups'],
    ['cell_groups:read', 'groups'],
    ['sermons:list:read', 'media'],
    ['media:read', 'media'],
    ['emails:read', 'email'],
    ['templates:read', 'email'],
    ['broadcasts:read', 'email'],
    ['messages:read', 'email'],
    ['whatsapp:read', 'whatsapp'],
    ['sms:create', 'sms'],
    ['reports:financial:read', 'giving'],
    ['reports:view', 'giving'],
    ['integrations:read', 'giving'],
    ['calls:create', 'calls'],
    ['webhooks:read', 'webhooks'],
    ['giving:records:read', 'giving'],
    ['events:all:read', 'events'],
    ['forms:list:read', 'forms'],
    ['reports:attendance:read', 'reports'],
    ['analytics:dashboard:read', 'analytics'],
  ])('requires the matching entitlement for permission %s', (permission, feature) => {
    expect(featureForPermission(permission)).toBe(feature);
    expect(planAllowsPermission(undefined, permission)).toBe(false);
    expect(planAllowsPermission([], permission)).toBe(false);
    expect(planAllowsPermission([feature], permission)).toBe(true);
  });
  it('does not add a paid feature requirement to shared home or ordinary member access', () => {
    expect(featureForPath('/home')).toBeUndefined();
    expect(featureForPermission('members:all:read')).toBeUndefined();
    expect(planAllowsPath(undefined, '/home')).toBe(true);
    expect(planAllowsPermission(undefined, 'members:all:read')).toBe(true);
  });
  it.each([
    null,
    '',
    'https://attacker.example.org',
    '//attacker.example.org',
    '/\\attacker.example.org',
    '/home\n',
    '/unknown/private',
  ])('refuses unsafe or unmapped return destinations: %j', (path) => {
    expect(permissionReturnTo(path, () => true)).toBe('/home');
  });
  it('preserves authorized internal query strings and hashes and canonicalizes the old dashboard', () => {
    expect(
      permissionReturnTo(
        '/members?status=active#table',
        (permission) => permission === 'members:all:read',
      ),
    ).toBe('/members?status=active#table');
    expect(permissionReturnTo('/members?status=active', () => false)).toBe('/home');
    expect(permissionReturnTo('/dashboard', () => false)).toBe('/home');
  });
  it('matches actual IDs to specific edit rules before their generic collection prefixes', () => {
    const edit = matchRoutePermission('/assets/actual-id/edit');
    expect(edit).toMatchObject({ permission: 'assets:list:update', allOf: ['assets:list:read'] });
    expect(checkRule(edit, (permission) => permission === 'assets:list:update')).toBe(false);
    expect(
      checkRule(edit, (permission) =>
        ['assets:list:update', 'assets:list:read'].includes(permission),
      ),
    ).toBe(true);
    expect(matchRoutePermission('/assets-unrelated')).toBeNull();
    expect(matchRoutePermission('/home/private')).toBeNull();
  });
  it('accepts any eligible report grant while preserving explicit additional requirements', () => {
    expect(
      checkRule(
        matchRoutePermission('/reports'),
        (permission) => permission === 'reports:financial:read',
      ),
    ).toBe(true);
    expect(
      checkRule({ prefix: '/test', anyOf: ['one', 'two'], allOf: ['required'] }, (permission) =>
        ['two', 'required'].includes(permission),
      ),
    ).toBe(true);
    expect(
      checkRule(
        { prefix: '/test', anyOf: ['one'], allOf: ['required'] },
        (permission) => permission === 'one',
      ),
    ).toBe(false);
    expect(checkRule(null, () => true)).toBe(false);
    expect(checkRule({ prefix: '/home' }, () => false)).toBe(true);
  });
});
