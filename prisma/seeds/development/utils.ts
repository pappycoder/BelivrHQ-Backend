/**
 * @file utils.ts
 * @description Shared helpers for the full BelivrHQ seed.
 */

import { PrismaClient } from '@prisma/client';

interface ModelWithId<T extends { id: string }> {
  findFirst: (args: { where: Record<string, unknown> }) => Promise<T | null>;
  create: (args: { data: Record<string, unknown> }) => Promise<T>;
}

/** Idempotent create-or-skip for church-scoped rows with a stable natural key. */
export async function findOrCreate<T extends { id: string }>(
  prisma: PrismaClient,
  model: ModelWithId<T>,
  where: Record<string, unknown>,
  data: Record<string, unknown>,
): Promise<{ row: T; created: boolean }> {
  const existing = await model.findFirst({ where });
  if (existing) return { row: existing, created: false };
  const row = await model.create({ data });
  return { row, created: true };
}

/** Deterministic pseudo-random (so reruns produce the same data). */
export function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

export function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}
