/**
 * @file media.seed.ts
 * @description Seeds sermons + bookmarks, and media assets.
 */

import { PrismaClient } from '@prisma/client';

export interface MediaSeedResult {
  sermonCount: number;
  mediaCount: number;
}

type SermonDefinition = [
  title: string,
  speaker: string,
  date: string,
  scriptureReference: string,
  seriesName: string | null,
];

type MediaDefinition = [
  filename: string,
  url: string,
  mimeType: string,
  sizeBytes: number,
  folder: string,
];

// Build storage URLs from the environment so seeded rows point at the real
// Supabase project instead of a hardcoded custom domain. The old
// `https://storage.churchos.dev/...` host has no valid TLS (SNI) and made every
// seeded media thumbnail fail with `net::ERR_FAILED` / SW `no-response`.
const SUPABASE_URL = (process.env.SUPABASE_URL ?? 'https://your-project.supabase.co').replace(
  /\/+$/,
  '',
);
const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET ?? 'media';

function storagePublicUrl(path: string): string {
  return `${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${path}`;
}

// ── Sermon definitions ──────────────────────────────────────────────
const SERMON_DEFS: SermonDefinition[] = [
  [
    'The Power of Gratitude',
    'Pastor David Adeyemi',
    '2026-08-30',
    'Psalms 103:1-5',
    'Gratitude Series',
  ],
  ['Walking in Faith', 'Pastor David Adeyemi', '2026-08-23', 'Hebrews 11:1', 'Faith Series'],
  ['Purpose and Calling', 'Pastor Samuel Bamidele', '2026-08-30', 'Ephesians 2:10', null],
];

// ── Media definitions ───────────────────────────────────────────────
const MEDIA_DEFS: MediaDefinition[] = [
  ['logo-main.png', storagePublicUrl('media/logo-main.png'), 'image/png', 245000, 'branding'],
  [
    'youth-camp-poster.jpg',
    storagePublicUrl('media/youth-camp-poster.jpg'),
    'image/jpeg',
    820000,
    'events',
  ],
  [
    'welcome-video.mp4',
    storagePublicUrl('media/welcome-video.mp4'),
    'video/mp4',
    15800000,
    'videos',
  ],
];

export async function seedMedia(
  prisma: PrismaClient,
  churchId: string,
  members: { id: string }[],
): Promise<MediaSeedResult> {
  console.log('📦 Seeding sermons + media assets...');

  let sermonCount = 0;
  let mediaCount = 0;

  // ── Sermons ────────────────────────────────────────────────────────
  for (const sermon of SERMON_DEFS) {
    const [title, speaker, date, scriptureReference, seriesName] = sermon;

    const existing = await prisma.sermon.findFirst({
      where: {
        church_id: churchId,
        title,
      },
    });

    if (existing) {
      // Re-seed repairs rows written when the (broken) custom storage domain
      // was hardcoded here.
      await prisma.sermon.update({
        where: { id: existing.id },
        data: { audio_url: storagePublicUrl('sermons/audio-sample.mp3') },
      });
      sermonCount++;
      console.log(`  ℹ️ Sermon already exists: ${title}`);
      continue;
    }

    await prisma.sermon.create({
      data: {
        church_id: churchId,
        title,
        speaker,
        sermon_date: new Date(date),
        scripture_reference: scriptureReference || undefined,
        series_name: seriesName || undefined,
        tags: ['seed'],
        description: `Seeded sermon: ${title}`,
        audio_url: storagePublicUrl('sermons/audio-sample.mp3'),
        duration_seconds: 2700,
      },
    });

    sermonCount++;

    console.log(`  ✅ Sermon: ${title}`);
  }

  // ── Bookmarks ──────────────────────────────────────────────────────
  if (sermonCount > 0 && members[0]) {
    const firstSermon = await prisma.sermon.findFirst({
      where: {
        church_id: churchId,
      },
      orderBy: {
        sermon_date: 'desc',
      },
    });

    if (firstSermon) {
      const existingBookmark = await prisma.sermonBookmark.findFirst({
        where: {
          member_id: members[0].id,
          sermon_id: firstSermon.id,
        },
      });

      if (!existingBookmark) {
        await prisma.sermonBookmark.create({
          data: {
            church_id: churchId,
            member_id: members[0].id,
            sermon_id: firstSermon.id,
          },
        });

        console.log(`  ✅ Bookmark: member ${members[0].id} → ${firstSermon.title}`);
      } else {
        console.log(`  ℹ️ Bookmark already exists for: ${firstSermon.title}`);
      }
    }
  }

  // ── Media assets ───────────────────────────────────────────────────
  for (const media of MEDIA_DEFS) {
    const [filename, url, mimeType, sizeBytes, folder] = media;

    const existing = await prisma.mediaAsset.findFirst({
      where: {
        church_id: churchId,
        filename,
      },
    });

    if (existing) {
      // Keep existing rows pointing at the current storage host (re-seed
      // rewrites stale custom-domain URLs from earlier seed versions).
      await prisma.mediaAsset.update({
        where: { id: existing.id },
        data: { url },
      });
      mediaCount++;
      console.log(`  ℹ️ Media already exists: ${filename}`);
      continue;
    }

    await prisma.mediaAsset.create({
      data: {
        church_id: churchId,
        filename,
        url,
        mime_type: mimeType,
        size_bytes: sizeBytes,
        folder,
        permissions: 'members',
      },
    });

    mediaCount++;

    console.log(`  ✅ Media: ${filename}`);
  }

  console.log(`  🎉 Sermons: ${sermonCount}, media assets: ${mediaCount}`);

  return {
    sermonCount,
    mediaCount,
  };
}
