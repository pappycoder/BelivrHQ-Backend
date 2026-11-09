/**
 * @file Backfill profile emails — one-time maintenance script
 * @description Populates missing `profiles.email` values from Supabase Auth.
 *
 * Profiles created before the email-persistence fixes (registration and early
 * invites) have a NULL/empty `email` column, which causes API responses to
 * omit the field entirely. This script pages through all Supabase Auth users
 * and writes each user's auth email into their profile row where missing.
 *
 * As a secondary pass it also heals legacy churches created via registration:
 * any church without a contact email gets one from its earliest church_admin
 * (or first) profile — matching what registration now persists going forward.
 *
 * Idempotent: profiles/churches that already have an email are never touched.
 *
 * Usage:
 *   npm run backfill-profile-emails
 *   ts-node -P tsconfig.scripts.json scripts/backfill-profile-emails.ts
 *
 * @module scripts/backfill-profile-emails
 * @since 1.0.0
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { createClient } from '@supabase/supabase-js';

// ─── Colours ─────────────────────────────────────────────────

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

const red = (s: string): string => `${RED}${s}${RESET}`;
const green = (s: string): string => `${GREEN}${s}${RESET}`;
const yellow = (s: string): string => `${YELLOW}${s}${RESET}`;
const cyan = (s: string): string => `${CYAN}${s}${RESET}`;
const bold = (s: string): string => `${BOLD}${s}${RESET}`;

// ─── Clients ─────────────────────────────────────────────────

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
});
const prisma = new PrismaClient({ adapter });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error(red('❌ SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are required.'));
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ─── Supabase user fetch ─────────────────────────────────────

async function fetchAllAuthEmails(): Promise<Map<string, string>> {
  const emails = new Map<string, string>();
  let page = 1;
  const perPage = 200;

  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) {
      throw new Error(`Supabase listUsers failed: ${error.message}`);
    }

    for (const user of data.users) {
      if (user.email) {
        emails.set(user.id, user.email);
      }
    }

    if (data.users.length < perPage) break;
    page += 1;
  }

  return emails;
}

// ─── Main ────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n${bold('BELIVRHQ — Backfill profile emails')}`);
  console.log(`${'─'.repeat(45)}`);

  await prisma.$connect();
  console.log(green('✅ Database connected'));

  console.log('Fetching Supabase Auth users...');
  const authEmails = await fetchAllAuthEmails();
  console.log(`  ${cyan(String(authEmails.size))} auth users with emails\n`);

  // ── Pass 1: profiles ───────────────────────────────────────

  const profiles = await prisma.profile.findMany({
    where: { OR: [{ email: null }, { email: '' }] },
    select: {
      id: true,
      user_id: true,
      first_name: true,
      last_name: true,
      church_id: true,
    },
    orderBy: { created_at: 'asc' },
  });

  console.log(bold(`Profiles missing email: ${profiles.length}\n`));

  let updatedProfiles = 0;
  let skippedProfiles = 0;

  for (const profile of profiles) {
    const authEmail = authEmails.get(profile.user_id);

    if (!authEmail) {
      skippedProfiles += 1;
      console.log(
        yellow(
          `  ⚠️  No auth user/email for ${profile.first_name} ${profile.last_name} (${profile.user_id})`,
        ),
      );
      continue;
    }

    await prisma.profile.update({
      where: { id: profile.id },
      data: { email: authEmail },
    });
    updatedProfiles += 1;
    console.log(`  ✅ ${profile.first_name} ${profile.last_name}: ${green(authEmail)}`);
  }

  // ── Pass 2: churches (legacy registrations left these empty) ──

  const churches = await prisma.church.findMany({
    where: { OR: [{ email: null }, { email: '' }] },
    select: { id: true, name: true },
  });

  let updatedChurches = 0;

  if (churches.length > 0) {
    console.log(`\n${bold(`Churches missing contact email: ${churches.length}`)}\n`);

    // Re-read profiles (now healed in pass 1) grouped by church.
    const healedProfiles = await prisma.profile.findMany({
      select: { id: true, church_id: true, email: true, role: true },
      orderBy: { created_at: 'asc' },
    });

    for (const church of churches) {
      const candidates = healedProfiles
        .filter((p) => p.church_id === church.id && p.email)
        .sort((a, b) => {
          const adminA = a.role.includes('church_admin') ? 0 : 1;
          const adminB = b.role.includes('church_admin') ? 0 : 1;
          return adminA - adminB;
        });

      const contactEmail = candidates[0]?.email;
      if (!contactEmail) {
        console.log(yellow(`  ⚠️  No profile email available for church "${church.name}"`));
        continue;
      }

      await prisma.church.update({
        where: { id: church.id },
        data: { email: contactEmail },
      });
      updatedChurches += 1;
      console.log(`  ✅ ${church.name}: ${green(contactEmail)}`);
    }
  }

  // ── Summary ────────────────────────────────────────────────

  console.log(`\n${bold('Summary:')}`);
  console.log(`  Profiles updated: ${cyan(String(updatedProfiles))}`);
  console.log(`  Profiles skipped (no auth email): ${yellow(String(skippedProfiles))}`);
  console.log(`  Churches updated: ${cyan(String(updatedChurches))}`);

  if (updatedProfiles === 0 && skippedProfiles === 0 && updatedChurches === 0) {
    console.log(`\n${green('Nothing to do — all emails already populated.')}`);
  } else {
    console.log(green('\n🎉 Backfill complete!'));
  }
}

main()
  .catch((err) => {
    console.error(red('Fatal error:'), err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
