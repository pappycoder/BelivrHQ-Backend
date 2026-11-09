/**
 * @file seed.ts
 * @description Single seed entry for BelivrHQ — Development (full demo) or
 * Production (reference data).
 *
 * When run without flags it interactively asks which mode to run:
 *   1) Development — populates everything with linked demo data (roles for
 *      every seed role in HQ + a non-HQ branch, real Supabase Auth users with
 *      password `ChurchOS@1234`, members, families, visitors, giving, events,
 *      attendance, org, pastoral, communication, media, appointments, system).
 *   2) Production — seeds only the platform-wide role/permission catalog.
 *      Church-scoped data is NOT seeded; the admin creates it via registration.
 *
 * Both paths are idempotent — safe to run multiple times.
 *
 * Usage:
 *   npx prisma db seed                    # interactive
 *   npm run prisma:seed                   # interactive
 *   npm run prisma:seed-development       # straight to Development
 *   npm run prisma:seed-production        # straight to Production
 *
 * @module seed
 */

import 'dotenv/config';
import * as readline from 'readline';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

import { runDevelopmentSeed } from './seeds/development/index.seed';
import { runProductionSeed } from './seeds/production/index.seed';

// -----------------------------------------------------------------------------
// Adapters
// -----------------------------------------------------------------------------

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
  // A slow/pooled database (e.g. remote Supabase pgbouncer) shouldn't be able
  // to hang a query forever or leave idle connections stuck mid-seed.
  connectionTimeoutMillis: 15_000,
  idleTimeoutMillis: 30_000,
});
const prisma = new PrismaClient({ adapter });

let supabase: SupabaseClient | null = null;

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (supabaseUrl && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

type SeedMode = 'development' | 'production';

function modeFromArgv(): SeedMode | null {
  if (process.argv.includes('--production')) return 'production';
  if (process.argv.includes('--development')) return 'development';
  return null;
}

async function promptMode(rl: readline.Interface): Promise<SeedMode> {
  return new Promise((resolve) => {
    const ask = (): void => {
      rl.question(
        '\nSelect seed mode:\n' +
          '  1) Development  — full demo data, all linked up for testing\n' +
          '  2) Production   — role/permission catalog only\n' +
          'Choice [1]: ',
        (answer) => {
          const trimmed = answer.trim().toLowerCase();
          if (trimmed === '2' || trimmed === 'production' || trimmed === 'p') {
            resolve('production');
          } else {
            resolve('development');
          }
        },
      );
    };
    ask();
  });
}

async function main(): Promise<void> {
  let mode = modeFromArgv();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  if (!mode) {
    mode = await promptMode(rl);
  }

  rl.close();

  if (mode === 'production') {
    await runProductionSeed(prisma);
  } else {
    await runDevelopmentSeed(prisma, supabase);
  }
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
