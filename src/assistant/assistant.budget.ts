import { brandConfig, LEGACY_BRAND } from '../brand/brand';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service';
import type IORedis from 'ioredis';
import type { Redis as UpstashRedis } from '@upstash/redis';

// All counters and reservations change together, across instances and concurrent requests.
export const RESERVE_USAGE = `
for i=1,#KEYS do
  local next=tonumber(redis.call('GET',KEYS[i]) or '0')+tonumber(ARGV[i*2-1])
  if next>tonumber(ARGV[i*2]) then return 0 end
end
for i=1,#KEYS do
  redis.call('INCRBY',KEYS[i],ARGV[i*2-1])
  redis.call('EXPIRE',KEYS[i],172800)
end
return 1`;
export const requestLimit = (plan: string) =>
  ({ essentials: 20, community: 50, network: 100, enterprise: 200 })[plan] ?? 20;
export function positiveNumber(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
@Injectable()
export class AssistantBudget {
  constructor(
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}
  async reserve(churchId: string, profileId: string, plan: string, costMicroUsd: number) {
    const day = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Africa/Lagos',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const prefix = `${LEGACY_BRAND.assistantBudgetPrefix}${day}`;
    const keys = [
      `${prefix}:user:${churchId}:${profileId}`,
      `${prefix}:church:${churchId}`,
      `${prefix}:global`,
      `${prefix}:spend:church:${churchId}`,
      `${prefix}:spend:global`,
    ];
    const args = [
      1,
      30,
      1,
      requestLimit(plan),
      1,
      positiveNumber(brandConfig(this.config, 'ASK_BELIVRHQ_GLOBAL_DAILY_REQUESTS'), 2000),
      costMicroUsd,
      Math.floor(
        positiveNumber(brandConfig(this.config, 'ASK_BELIVRHQ_CHURCH_DAILY_USD'), 0.25) * 1e6,
      ),
      costMicroUsd,
      Math.floor(
        positiveNumber(brandConfig(this.config, 'ASK_BELIVRHQ_GLOBAL_DAILY_USD'), 2) * 1e6,
      ),
    ].map(String);
    try {
      const result = this.redis.isUpstash
        ? await (this.redis.client as UpstashRedis).eval(RESERVE_USAGE, keys, args)
        : await (this.redis.client as IORedis).eval(RESERVE_USAGE, keys.length, ...keys, ...args);
      return Number(result) === 1;
    } catch {
      return false;
    } // Never make a paid call when shared limits cannot be enforced.
  }
}
