import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

export const WORKER_QUEUES = [
  'whatsapp-outbound',
  'email-outbound',
  'sms-outbound',
  'recurring-giving',
  'nightly-jobs',
  'broadcast',
  'dead-letter',
  'webhook-delivery',
] as const;
export const HEARTBEAT_TTL_SECONDS = 90;
export const HEARTBEAT_INTERVAL_MS = 20000;
export const heartbeatKey = (queue: string) => `worker:heartbeat:${queue}`;

@Injectable()
export class WorkerStatusService {
  constructor(private readonly redis: RedisService) {}

  async snapshot(): Promise<Record<string, 'up' | 'down'>> {
    const values = await this.redis.mget(...WORKER_QUEUES.map(heartbeatKey));
    const now = Date.now();
    return Object.fromEntries(
      WORKER_QUEUES.map((queue, index) => {
        const value = values[index];
        const valid =
          !!value &&
          typeof value === 'object' &&
          'kind' in value &&
          value.kind === 'queue-worker' &&
          'version' in value &&
          value.version === 1 &&
          'timestamp' in value &&
          typeof value.timestamp === 'number' &&
          now - value.timestamp < HEARTBEAT_TTL_SECONDS * 1000 &&
          value.timestamp <= now + 5000;
        return [queue, valid ? 'up' : 'down'];
      }),
    );
  }
}
