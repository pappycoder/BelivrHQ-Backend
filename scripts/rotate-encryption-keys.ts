/** Never prints keys or plaintext. Dry-run unless --apply is explicitly supplied. */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { LEGACY_BRAND } from '../src/brand/brand';
import { EncryptionPurpose } from '../src/config/stored-encryption';
import { rotateEncryptionPlan, rotationKeys, RotationStore } from './lib/rotate-encryption';

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help')) {
    console.log(
      'Usage: npm run keys:rotate -- all|integrations|authenticators|pastoral [--apply|--verify-current]. Default: read-only dry-run. Apply includes a final current-key-only verification.',
    );
    return;
  }
  const purposes: Record<string, EncryptionPurpose> = {
    integrations: 'INTEGRATIONS_ENCRYPTION_KEY',
    authenticators: 'TWO_FACTOR_ENCRYPTION_KEY',
    pastoral: 'PASTORAL_ENCRYPTION_KEY',
  };
  const selected = Object.entries(purposes)
    .filter(([alias]) => args[0] === 'all' || args[0] === alias)
    .map(([, purpose]) => purpose);
  if (
    !selected.length ||
    args.slice(1).some((arg) => !['--apply', '--verify-current'].includes(arg)) ||
    (args.includes('--apply') && args.includes('--verify-current'))
  )
    throw new Error(
      'Usage: npm run keys:rotate -- all|integrations|authenticators|pastoral [--apply|--verify-current]',
    );
  const configuredKeys = selected.map((purpose) =>
    rotationKeys(purpose, (name) => process.env[name]),
  );
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const prisma = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: process.env.DATABASE_URL,
      max: 1,
      connectionTimeoutMillis: 15000,
    }),
  });
  const stores: Record<EncryptionPurpose, RotationStore> = {
    INTEGRATIONS_ENCRYPTION_KEY: {
      batch: async (cursor) =>
        (
          await prisma.integrationAccount.findMany({
            where: cursor ? { id: { gt: cursor } } : {},
            orderBy: { id: 'asc' },
            take: 100,
            select: { id: true, church_id: true, provider: true, ciphertext: true },
          })
        ).map((row) => ({
          id: row.id,
          ciphertext: row.ciphertext,
          aad: `${row.church_id}:${row.id}:${row.provider}:v1`,
        })),
      replace: async (row, ciphertext) =>
        (
          await prisma.integrationAccount.updateMany({
            where: { id: row.id, ciphertext: row.ciphertext },
            data: { ciphertext },
          })
        ).count,
    },
    TWO_FACTOR_ENCRYPTION_KEY: {
      batch: async (cursor) =>
        (
          await prisma.profileAuthenticator.findMany({
            where: cursor ? { user_id: { gt: cursor } } : {},
            orderBy: { user_id: 'asc' },
            take: 100,
            select: { user_id: true, secret_ciphertext: true },
          })
        ).map((row) => ({
          id: row.user_id,
          ciphertext: row.secret_ciphertext,
          aad: `${LEGACY_BRAND.totpDomain}${row.user_id}`,
        })),
      replace: async (row, secret_ciphertext) =>
        (
          await prisma.profileAuthenticator.updateMany({
            where: { user_id: row.id, secret_ciphertext: row.ciphertext },
            data: { secret_ciphertext },
          })
        ).count,
    },
    PASTORAL_ENCRYPTION_KEY: {
      batch: async (cursor) =>
        (
          await prisma.pastoralNote.findMany({
            where: cursor ? { id: { gt: cursor } } : {},
            orderBy: { id: 'asc' },
            take: 100,
            select: { id: true, content: true },
          })
        ).map((row) => ({ id: row.id, ciphertext: row.content })),
      replace: async (row, content) =>
        (
          await prisma.pastoralNote.updateMany({
            where: { id: row.id, content: row.ciphertext },
            data: { content },
          })
        ).count,
    },
  };
  try {
    const results = await rotateEncryptionPlan(
      selected.map((purpose, index) => ({
        purpose,
        keys: configuredKeys[index],
        store: stores[purpose],
      })),
      {
        apply: args.includes('--apply'),
        verifyCurrent: args.includes('--verify-current'),
      },
    );
    for (const counts of results) {
      console.log(
        args.includes('--verify-current')
          ? `${counts.purpose}: verified ${counts.current} records with the current key.`
          : `${counts.purpose}: ${args.includes('--apply') ? 'rotated' : 'would rotate'} ${counts.changed} records; ${counts.current} already current.${counts.verified === undefined ? '' : ` Verified ${counts.verified} persisted records with the current key alone.`}`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}
main().catch(() => {
  console.error(
    'Key rotation stopped. Check command arguments, key configuration and database connectivity. Keep old keys available to the isolated migrator and rerun after resolving any concurrent changes; rotation completion was not verified. No secrets or record contents were logged.',
  );
  process.exitCode = 1;
});
