import { LEGACY_BRAND } from '../src/brand/brand';
/** Dry-run by default. Stop writers and back up the database before --apply. */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const apply = process.argv.includes('--apply');
const oldSecret = process.env.PASTORAL_OLD_ENCRYPTION_KEY;
const newSecret = process.env.PASTORAL_ENCRYPTION_KEY;
if (!oldSecret || !newSecret || oldSecret === newSecret || newSecret.length < 32)
  throw new Error(
    'Provide distinct PASTORAL_OLD_ENCRYPTION_KEY and PASTORAL_ENCRYPTION_KEY (at least 32 characters).',
  );
const oldKey = scryptSync(oldSecret, LEGACY_BRAND.pastoralSalt, 32);
const newKey = scryptSync(newSecret, LEGACY_BRAND.pastoralSalt, 32);
const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 15000,
  }),
});
function decrypt(value: string, key: Buffer) {
  const parts = value.split(':');
  if (parts.length !== 3 || !parts.every((part) => /^[a-f\d]*$/i.test(part)))
    throw new Error('Invalid encrypted note');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[0], 'hex'));
  decipher.setAuthTag(Buffer.from(parts[1], 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(parts[2], 'hex')), decipher.final()]);
}
async function main() {
  let cursor: string | undefined;
  let changed = 0,
    alreadyRotated = 0;
  while (true) {
    const rows = await prisma.pastoralNote.findMany({
      where: cursor ? { id: { gt: cursor } } : {},
      orderBy: { id: 'asc' },
      take: 100,
      select: { id: true, content: true },
    });
    if (!rows.length) break;
    for (const row of rows) {
      let plaintext: Buffer;
      try {
        plaintext = decrypt(row.content, oldKey);
      } catch {
        try {
          decrypt(row.content, newKey);
          alreadyRotated++;
          continue;
        } catch {
          throw new Error(`Cannot decrypt note ${row.id}; stopped without changing this row.`);
        }
      }
      if (apply) {
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', newKey, iv);
        const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        const content = `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted.toString('hex')}`;
        const result = await prisma.pastoralNote.updateMany({
          where: { id: row.id, content: row.content },
          data: { content },
        });
        if (result.count !== 1)
          throw new Error('A note changed during rotation. Stop all writers before continuing.');
      }
      plaintext.fill(0);
      changed++;
    }
    cursor = rows[rows.length - 1].id;
  }
  console.log(
    `${apply ? 'Rotated' : 'Would rotate'} ${changed} notes; ${alreadyRotated} already use the new key. No note content was logged.`,
  );
}
main()
  .catch(() => {
    console.error(
      'Rotation stopped. Check the keys, backup and database connectivity; rerun after resolving the failure.',
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    oldKey.fill(0);
    newKey.fill(0);
    await prisma.$disconnect();
  });
