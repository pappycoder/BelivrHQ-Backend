/**
 * @file seed-permissions.ts
 * @description Permissions-only seed entry — roles, permissions, and default
 * role-permission mappings, with no members/transactions/forms demo data.
 *
 * Creates only missing global roles and their initial grants. Existing roles
 * and permission assignments are preserved, even when defaults have changed.
 * Adding a role requires an entry in DEFAULT_ROLES and its permission matrix.
 *
 * Usage:
 *   npm run prisma:seed-perms
 *
 * @module seed-permissions
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { seedPermissions } from './seeds/shared/permissions.seed';

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
  // A slow/pooled database (e.g. remote Supabase pgbouncer) shouldn't be able
  // to hang a query forever or leave idle connections stuck mid-seed.
  connectionTimeoutMillis: 15_000,
  idleTimeoutMillis: 30_000,
});
const prisma = new PrismaClient({ adapter });

async function main(): Promise<void> {
  console.log('🌱 Starting permissions-only seed...\n');
  await seedPermissions(prisma);
  console.log('\n🎉 Permissions seed completed successfully!\n');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
