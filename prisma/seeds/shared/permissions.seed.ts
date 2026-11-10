/**
 * @file permissions.seed.ts
 * @description Default roles, permissions, and role-permission mappings seed data.
 *
 * Creates missing built-in roles and their hierarchical default grants:
 *   - `resource:view`                 — top-level menu visibility
 *   - `resource:action`               — coarse CRUD (create/read/update/delete)
 *   - `resource:surface:action`       — per-surface CRUD (e.g. `events:calendar:read`,
 *                                        `members:new:create`, `giving:reports:read`)
 *
 * Roles' surface grants are <em>derived</em> from their coarse grants, so a
 * role's visible menus never change: wherever a role holds `resource:create`,
 * they also hold every `resource:<surface>:create`, and wherever they hold any
 * `resource:<action>` they also hold `resource:view`. Churches start with
 * these defaults and can customize via the church_admin permissions API.
 *
 * The `super_admin` role is always locked to ALL permissions.
 *
 * Usage:
 *   Import `seedPermissions` into `prisma/seed.ts` and call it.
 *
 * @module seeds/permissions
 * @since 1.0.0
 */

import { PrismaClient } from '@prisma/client';

// ─── Role Definitions ──────────────────────────────────────

export interface RoleSeed {
  name: string;
  description: string;
}

export const DEFAULT_ROLES: RoleSeed[] = [
  { name: 'super_admin', description: 'Platform administrator with full access (locked)' },
  {
    name: 'senior_pastor',
    description:
      'Pastor with all operational pages, scoped to their branch unless Admin HQ is enabled',
  },
  { name: 'church_admin', description: 'Church administrator with full access' },
  {
    name: 'branch_pastor',
    description:
      'Pastor with all operational pages, scoped to their branch unless Admin HQ is enabled',
  },
  {
    name: 'department_head',
    description: 'Department leader with personal access plus management of their own department',
  },
  { name: 'secretary', description: 'Church secretary with member and event management access' },
  { name: 'treasurer', description: 'Financial officer with giving and reports access' },
  {
    name: 'usher',
    description:
      'Treasurer access plus service/event management, attendance, check-in, records and reports',
  },
  {
    name: 'cell_leader',
    description:
      'Cell group leader with personal access plus management of their own group (edit details, members, attendance)',
  },
];

// ─── Resource Definitions ──────────────────────────────────

export const RESOURCES = [
  'members',
  'attendance',
  'giving',
  'events',
  'offline',
  'sermons',
  'media',
  'church',
  'branches',
  'profiles',
  'whatsapp',
  'reports',
  'roles',
  'forms',
  'pastoral',
  'pastoral_confidential',
  'pastoral_restricted',
  'pastoral_moderation',
  'departments',
  'cell_groups',
  'assets',
  'families',
  'templates',
  'broadcasts',
  'analytics',
  'church_settings',
  'integrations',
  'billing',
  'calls',
  'visitors',
  'users',
  'webhooks',
  'diagnostics',
  'emails',
  'appointments',
] as const;

export type Resource = (typeof RESOURCES)[number];

export const CRUD_ACTIONS = ['create', 'read', 'update', 'delete'] as const;
export type CrudAction = (typeof CRUD_ACTIONS)[number];

// ─── Action Definitions ────────────────────────────────────

export const ACTIONS = ['view', ...CRUD_ACTIONS] as const;
export type Action = (typeof ACTIONS)[number];

// ─── Surface Definitions ───────────────────────────────────
// Hierarchical sub-surfaces inside a resource (mirrors sidebar submenus /
// header child items). Each surface carries the full CRUD action set as
// `resource:surface:action`. Single-page menus (templates, broadcasts,
// whatsapp/messages, emails/inbox, appointments, church/settings, analytics)
// intentionally have NO surface map — they stay coarse `resource:action`.

export const SURFACES: Partial<Record<Resource, readonly string[]>> = {
  members: ['all', 'new', 'import', 'own'],
  attendance: ['dashboard', 'services', 'checkin', 'records', 'reports'],
  giving: ['dashboard', 'categories', 'records', 'reports', 'recurring'],
  events: ['calendar', 'all', 'list', 'checkin', 'registrations', 'tickets', 'ticket-records'],
  sermons: ['list', 'new', 'series', 'speakers'],
  media: ['library', 'upload', 'folders'],
  pastoral: ['notes', 'life-events', 'risk-scores', 'engagement'],
  visitors: ['list', 'new', 'followup'],
  assets: ['list', 'categories', 'maintenance', 'loans'],
  forms: ['list', 'submissions'],
  departments: ['own'],
  cell_groups: ['own', 'giving', 'details'],
  reports: ['financial', 'attendance', 'members'],
  analytics: ['dashboard', 'giving', 'attendance', 'members', 'events', 'communication'],
  appointments: ['branch'],
};

/**
 * Generates the full permission catalog:
 *  - `resource:view` for every resource
 *  - coarse `resource:action` for every CRUD action
 *  - `resource:surface:action` for every surface × CRUD action
 * `resource` stores the nested path (`events:calendar`) and `action` the
 * final segment, so exact-string set membership still works end-to-end.
 */
export function generateAllPermissions(): { name: string; resource: string; action: string }[] {
  const permissions: { name: string; resource: string; action: string }[] = [];
  for (const resource of RESOURCES) {
    permissions.push({ name: `${resource}:view`, resource, action: 'view' });
    for (const action of CRUD_ACTIONS) {
      permissions.push({ name: `${resource}:${action}`, resource, action });
    }
    for (const surface of SURFACES[resource] ?? []) {
      for (const action of CRUD_ACTIONS) {
        permissions.push({
          name: `${resource}:${surface}:${action}`,
          resource: `${resource}:${surface}`,
          action,
        });
      }
    }
  }
  permissions.push({
    name: 'branches:directory:read',
    resource: 'branches:directory',
    action: 'read',
  });
  permissions.push({
    name: 'data_scope:church:read',
    resource: 'data_scope:church',
    action: 'read',
  });
  permissions.push({ name: 'media:restricted:read', resource: 'media:restricted', action: 'read' });
  return permissions;
}

/**
 * Derives hierarchical grants from a role's coarse grant set so its visible
 * menus never change:
 *  - holding any `resource:<action>` grants `resource:view`
 *  - holding `resource:<action>` grants the same `<action>` on every regular
 *    surface (`resource:<surface>:<action>`)
 *  - `own` surfaces are explicit scope grants and are never inferred from a
 *    church-wide resource permission
 */
export function expandPermissions(base: string[]): string[] {
  const expanded = new Set(base);
  for (const resource of RESOURCES) {
    const actions = new Set<string>();
    for (const code of base) {
      const parts = code.split(':');
      if (parts.length === 2 && parts[0] === resource) actions.add(parts[1]);
    }
    if (actions.size === 0) continue;
    expanded.add(`${resource}:view`);
    const surfaces = SURFACES[resource] ?? [];
    for (const surface of surfaces) {
      if (surface === 'own' || surface === 'ticket-records') continue;
      if (resource === 'cell_groups' && ['giving', 'details'].includes(surface)) continue;
      for (const action of CRUD_ACTIONS) {
        if (actions.has(action)) {
          expanded.add(`${resource}:${surface}:${action}`);
        }
      }
    }
  }
  return [...expanded];
}

// ─── Default Permission Matrix ─────────────────────────────
// Each role maps to an array of coarse `resource:action` permission strings.
// The exported DEFAULT_PERMISSION_MATRIX is the raw set passed through
// `expandPermissions`, which adds `resource:view` + surface grants derived
// from the coarse grants — so per-role visible menus never change.
// `super_admin` is handled separately (always ALL permissions, locked).

// Pastors can use operational pages. Analytics, church configuration, branch
// creation and church-wide account/permission administration stay admin-only.
const pastorPermissions = generateAllPermissions()
  .map((permission) => permission.name)
  .filter((name) => {
    const [resource, action] = name.split(':');
    if (
      resource === 'church_settings' ||
      resource === 'integrations' ||
      resource === 'billing' ||
      resource === 'analytics' ||
      resource === 'data_scope'
    )
      return false;
    if (name === 'branches:create') return false;
    if (['church', 'roles', 'users', 'profiles', 'webhooks', 'diagnostics'].includes(resource)) {
      return action === 'read' || action === 'view';
    }
    return !name.includes(':own:');
  });

const RAW_DEFAULT_PERMISSION_MATRIX: Record<string, string[]> = {
  senior_pastor: [...pastorPermissions],

  church_admin: [
    // ALL permissions (same as super_admin, but not locked)
    ...generateAllPermissions().map((p) => p.name),
    // Roles & permissions management (menus + API):
    'roles:create',
    'roles:read',
    'roles:update',
  ],

  branch_pastor: [...pastorPermissions],

  department_head: [
    'members:own:read',
    // Branch names are needed for the locked branch selector; the API only
    // returns this viewer's own branch unless is_admin_hq is enabled.
    'branches:read',
    // Ticket booking — read event listings and claim/view personal tickets.
    // Separate grants keep staff-only event and registration menus hidden.
    'events:calendar:read',
    'events:list:read',
    'events:tickets:read',
    'sermons:read',
    'media:read',
    'media:update',
    'profiles:read',
    'church:read',
    // Department heads view and edit departments, but cannot create them.
    'departments:read',
    'departments:update',
    'departments:own:read',
    'departments:own:update',
  ],

  secretary: [
    // Members — create + read + update
    'members:create',
    'members:read',
    'members:update',
    // Attendance — dashboard, services, and report only (no check-in or records)
    'attendance:dashboard:read',
    'attendance:services:read',
    'attendance:services:create',
    'attendance:reports:read',
    // Giving — dashboard and categories only; categories may be created
    'giving:dashboard:read',
    'giving:categories:read',
    'giving:categories:create',
    'giving:categories:update',
    'giving:categories:delete',
    // Events — calendar, event listing, and registrations; no check-in access
    'events:calendar:read',
    'events:list:read',
    'events:all:read',
    'events:registrations:read',
    'events:tickets:read',
    'events:ticket-records:read',
    'events:tickets:create',
    // Sermons and media — content management within the viewer's branch scope
    'sermons:create',
    'sermons:read',
    'sermons:update',
    'sermons:delete',
    'media:create',
    'media:read',
    'media:update',
    'media:delete',
    // Church — read
    'church:read',
    // Branches — read
    'branches:read',
    // Profiles — read
    'profiles:read',
    // Forms — create + read + update
    'forms:create',
    'forms:read',
    'forms:update',
    // Families — create + read + update
    'families:create',
    'families:read',
    'families:update',
    // Templates — create + read
    'templates:create',
    'templates:read',
    // Reports — all three report types
    'reports:view',
    'reports:financial:read',
    'reports:attendance:read',
    'reports:members:read',
    // Assets — create + read + update
    'assets:create',
    'assets:read',
    'assets:update',
    // Departments and cell groups — branch-scoped read access
    'departments:read',
    'cell_groups:read',
    // Users — read
    'users:read',
    // Communication — send broadcasts and messages, and read their history.
    'broadcasts:create',
    'broadcasts:read',
    'whatsapp:create',
    'whatsapp:read',
    // Emails — full access
    'emails:create',
    'emails:read',
    'emails:update',
    // Appointments — full access
    'appointments:create',
    'appointments:read',
    'appointments:update',
    'appointments:delete',
  ],

  treasurer: [
    'cell_groups:read',
    'cell_groups:giving:read',
    // Branch names are needed for HQ branch filters; branch-scoped viewers
    // only receive their own branch from the API.
    'branches:read',
    // Department names are needed when creating branch assets.
    'departments:read',
    // Giving — create + read + update
    'giving:create',
    'giving:read',
    'giving:update',
    'giving:categories:delete',
    // Giving records use the service list for the service filter dropdown.
    'attendance:services:read',
    // Reports — financial only
    'reports:view',
    'reports:financial:read',
    // Assets — create + read + update + delete
    'assets:create',
    'assets:read',
    'assets:update',
    'assets:delete',
    // Church Settings — read
    'church_settings:read',
    // Calendar and personal ticket booking. Listing access feeds the booking
    // flow; the separate all-menu permission is intentionally not granted.
    'events:calendar:read',
    'events:list:read',
    'events:tickets:read',
    'sermons:read',
    'media:read',
    'profiles:read',
    'church:read',
    // Inbox access includes composing messages.
    'emails:read',
    'emails:create',
  ],

  cell_leader: [
    'cell_groups:giving:read',
    'cell_groups:giving:create',
    'members:own:read',
    'branches:read',
    // Personal event browsing and booking; no management menus.
    'events:view',
    'events:calendar:read',
    'events:list:read',
    'events:tickets:read',
    // Sermons — read (personal access)
    'sermons:read',
    // Media — read (personal access)
    'media:read',
    // Profiles — read (personal access)
    'profiles:read',
    // Church — read (personal access)
    'church:read',
    // Cell Groups — read + create + update (group leadership operations:
    // editing their own group, adding/removing members, and recording
    // attendance — all enforced to their OWN group server-side)
    'cell_groups:own:read',
    'cell_groups:read',
    'cell_groups:create',
    'cell_groups:update',
    'cell_groups:own:create',
    'cell_groups:own:update',
  ],
};

// Keep the financial baseline identical as treasurer permissions evolve.
RAW_DEFAULT_PERMISSION_MATRIX.usher = [
  ...RAW_DEFAULT_PERMISSION_MATRIX.treasurer,
  'cell_groups:details:read',
  'attendance:create',
  'attendance:read',
  'attendance:update',
  'attendance:delete',
  // Full event operations, still subject to church/branch visibility and history safeguards.
  'events:create',
  'events:read',
  'events:update',
  'events:delete',
  'events:ticket-records:read',
  'events:all:read',
  'events:registrations:read',
  'events:checkin:create',
  'events:checkin:read',
  'events:checkin:update',
  // The check-in form registers first-time visitors before recording attendance.
  'visitors:new:create',
  'visitors:list:read',
  'reports:attendance:read',
];

// Every role's effective grants = coarse matrix + derived hierarchical grants.
export const DEFAULT_PERMISSION_MATRIX: Record<string, string[]> = Object.fromEntries(
  Object.entries(RAW_DEFAULT_PERMISSION_MATRIX).map(([role, perms]) => [
    role,
    // All roles need to resolve their own branch name for locked branch
    // filters. BranchesService limits non-HQ callers to their assigned branch.
    [
      ...expandPermissions([
        ...perms,
        'branches:read',
        'offline:read',
        ...(perms.includes('cell_groups:read') && !['treasurer', 'usher'].includes(role)
          ? ['cell_groups:details:read']
          : []),
      ]),
      // Event editing does not grant check-in, registrations or ticket management.
      ...(role === 'secretary' ? ['events:create', 'events:update'] : []),
    ],
  ]),
);

/**
 * Creates missing global roles with their initial default grants.
 * Existing roles, descriptions and grants are never changed, including empty
 * grant sets. Only permissions needed by newly created roles are inserted;
 * existing permission records and church overrides are preserved.
 * A transaction-scoped lock serializes concurrent seed runs because the role
 * compound unique key does not enforce uniqueness for NULL church IDs.
 */
export async function seedPermissions(prisma: PrismaClient): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('belivrhq:default-role-seed:v1'))`;
      const existing = await tx.role.findMany({
        where: { church_id: null, name: { in: DEFAULT_ROLES.map((role) => role.name) } },
        select: { name: true },
      });
      const existingNames = new Set(existing.map((role) => role.name));
      const missing = DEFAULT_ROLES.filter((role) => !existingNames.has(role.name));
      console.log(
        `Default roles: ${existing.length} existing roles skipped; ${missing.length} to create.`,
      );
      if (!missing.length) return;

      const catalog = generateAllPermissions();
      const catalogByName = new Map(catalog.map((permission) => [permission.name, permission]));
      const grantsByRole = new Map<string, string[]>();
      const needed = new Set<string>();
      for (const role of missing) {
        const grants =
          role.name === 'super_admin'
            ? catalog.map((permission) => permission.name)
            : DEFAULT_PERMISSION_MATRIX[role.name];
        if (!grants)
          throw new Error(`Missing default permission matrix for new role: ${role.name}`);
        grantsByRole.set(role.name, [...new Set(grants)]);
        for (const name of grants) {
          if (!catalogByName.has(name)) throw new Error(`Unknown default permission: ${name}`);
          needed.add(name);
        }
      }
      if (needed.size) {
        await tx.permission.createMany({
          data: [...needed].map((name) => catalogByName.get(name)!),
          skipDuplicates: true,
        });
      }
      const permissions = await tx.permission.findMany({
        where: { name: { in: [...needed] } },
        select: { id: true, name: true },
      });
      const ids = new Map(permissions.map((permission) => [permission.name, permission.id]));
      const mappings: { role_id: string; permission_id: string }[] = [];
      for (const definition of missing) {
        const role = await tx.role.create({ data: { ...definition, church_id: null } });
        for (const name of grantsByRole.get(role.name)!) {
          const permissionId = ids.get(name);
          if (!permissionId) throw new Error(`Missing permission record: ${name}`);
          mappings.push({ role_id: role.id, permission_id: permissionId });
        }
        console.log(`Created default role: ${role.name}`);
      }
      if (mappings.length) await tx.rolePermission.createMany({ data: mappings });
    },
    { maxWait: 15_000, timeout: 60_000 },
  );
}
