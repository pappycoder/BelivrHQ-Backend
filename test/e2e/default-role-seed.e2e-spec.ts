import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  DEFAULT_PERMISSION_MATRIX,
  DEFAULT_ROLES,
  RESOURCES,
  generateAllPermissions,
  seedPermissions,
} from '../../prisma/seeds/shared/permissions.seed';

// Each test gets private copies of the reference tables. Parallel E2E suites
// keep using public; no existing global roles or live credentials are touched.
describe('Insert-only default role seed', () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  let schema: string;
  let prisma: PrismaClient;
  beforeEach(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    schema = `seed_test_${randomUUID().replace(/-/g, '')}`;
    await pool.query(`CREATE SCHEMA "${schema}"`);
    for (const table of ['roles', 'permissions', 'role_permissions', 'church_role_permissions']) {
      await pool.query(
        `CREATE TABLE "${schema}"."${table}" (LIKE public."${table}" INCLUDING ALL)`,
      );
    }
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 4 }, { schema }),
    });
  });
  afterEach(async () => {
    await prisma?.$disconnect();
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  });
  afterAll(async () => pool.end());

  const snapshot = async () => ({
    roles: await prisma.role.findMany({ orderBy: { id: 'asc' } }),
    permissions: await prisma.permission.findMany({ orderBy: { id: 'asc' } }),
    mappings: await prisma.rolePermission.findMany({ orderBy: { id: 'asc' } }),
    overrides: await prisma.churchRolePermission.findMany({ orderBy: { id: 'asc' } }),
  });

  it('creates all fresh-install roles with exact initial defaults and skips a second run', async () => {
    await seedPermissions(prisma);
    const roles = await prisma.role.findMany({
      include: { permissions: { include: { permission: true } } },
    });
    expect(roles).toHaveLength(DEFAULT_ROLES.length);
    for (const role of roles) {
      const expected =
        role.name === 'super_admin'
          ? generateAllPermissions().map((permission) => permission.name)
          : DEFAULT_PERMISSION_MATRIX[role.name];
      expect(role.permissions.map((grant) => grant.permission.name).sort()).toEqual(
        [...expected].sort(),
      );
    }
    const before = await snapshot();
    await seedPermissions(prisma);
    expect(await snapshot()).toEqual(before);
  });

  it('preserves edited grants, empty grants, super-admin mappings, metadata and church overrides', async () => {
    await seedPermissions(prisma);
    const admin = await prisma.role.findFirstOrThrow({ where: { name: 'church_admin' } });
    const secretary = await prisma.role.findFirstOrThrow({ where: { name: 'secretary' } });
    const superAdmin = await prisma.role.findFirstOrThrow({ where: { name: 'super_admin' } });
    const removed = await prisma.permission.findUniqueOrThrow({
      where: { name: 'members:new:create' },
    });
    await prisma.rolePermission.deleteMany({
      where: { role_id: { in: [admin.id, superAdmin.id] }, permission_id: removed.id },
    });
    await prisma.rolePermission.deleteMany({ where: { role_id: secretary.id } });
    await prisma.role.update({
      where: { id: admin.id },
      data: { label: 'Live label', description: 'Live description' },
    });
    await prisma.permission.update({
      where: { id: removed.id },
      data: { description: 'Live permission metadata' },
    });
    const custom = await prisma.permission.create({
      data: { name: 'live:custom:read', resource: 'live:custom', action: 'read' },
    });
    await prisma.rolePermission.create({ data: { role_id: admin.id, permission_id: custom.id } });
    const churchId = randomUUID();
    await prisma.role.create({
      data: { church_id: churchId, name: 'branch_pastor', description: 'Church-owned role' },
    });
    await prisma.churchRolePermission.create({
      data: { church_id: churchId, role_name: 'church_admin', permission_id: custom.id },
    });
    const before = await snapshot();
    await seedPermissions(prisma);
    expect(await snapshot()).toEqual(before);
  });

  it('adds a newly defined role without changing existing role records or grants', async () => {
    await seedPermissions(prisma);
    const before = await snapshot();
    const name = 'new_seed_role';
    const resources = RESOURCES as unknown as string[];
    resources.push('future_seed_resource');
    DEFAULT_ROLES.push({ name, description: 'New role fixture' });
    DEFAULT_PERMISSION_MATRIX[name] = ['future_seed_resource:read'];
    try {
      await seedPermissions(prisma);
      const role = await prisma.role.findFirstOrThrow({
        where: { name },
        include: { permissions: { include: { permission: true } } },
      });
      expect(role.permissions.map((grant) => grant.permission.name)).toEqual([
        'future_seed_resource:read',
      ]);
      const after = await snapshot();
      expect(after.roles.filter((row) => row.id !== role.id)).toEqual(before.roles);
      expect(after.mappings.filter((row) => row.role_id !== role.id)).toEqual(before.mappings);
      expect(after.permissions.filter((row) => row.name !== 'future_seed_resource:read')).toEqual(
        before.permissions,
      );
      expect(after.permissions).toHaveLength(before.permissions.length + 1);
      await seedPermissions(prisma);
      expect(await snapshot()).toEqual(after);
    } finally {
      DEFAULT_ROLES.pop();
      resources.pop();
      delete DEFAULT_PERMISSION_MATRIX[name];
    }
  });

  it('serializes concurrent seeds without duplicate global roles or grants', async () => {
    await Promise.all([seedPermissions(prisma), seedPermissions(prisma)]);
    expect(await prisma.role.count()).toBe(DEFAULT_ROLES.length);
    const count = await prisma.rolePermission.count();
    await seedPermissions(prisma);
    expect(await prisma.rolePermission.count()).toBe(count);
  });

  it('rolls back new roles and permissions when default grant creation fails', async () => {
    await pool.query(
      `ALTER TABLE "${schema}".role_permissions ADD CONSTRAINT seed_test_failure CHECK (false)`,
    );
    await expect(seedPermissions(prisma)).rejects.toThrow();
    expect(await prisma.role.count()).toBe(0);
    expect(await prisma.permission.count()).toBe(0);
    expect(await prisma.rolePermission.count()).toBe(0);
  });
});
