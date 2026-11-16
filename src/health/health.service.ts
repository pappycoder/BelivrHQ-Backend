import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { WorkerStatusService } from '../queues/worker-status.service';
import { BoundedProbe } from './bounded-probe';

interface QueueMetrics {
  status: 'up' | 'down';
  active: number;
  waiting: number;
  completed: number;
  failed: number;
  delayed: number;
}
export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  uptime: number;
  services: { database: 'up' | 'down'; redis: 'up' | 'down' };
  queues: Record<string, QueueMetrics>;
  workers: Record<string, 'up' | 'down'>;
  checks: Record<string, { status: 'up' | 'down'; durationMs: number; reason?: string }>;
}

@Injectable()
export class HealthService {
  private readonly probes = new BoundedProbe();
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly workerStatus: WorkerStatusService,
    @InjectQueue('whatsapp-outbound') private readonly whatsappQueue: Queue,
    @InjectQueue('email-outbound') private readonly emailQueue: Queue,
    @InjectQueue('sms-outbound') private readonly smsQueue: Queue,
    @InjectQueue('recurring-giving') private readonly recurringGivingQueue: Queue,
    @InjectQueue('nightly-jobs') private readonly nightlyJobsQueue: Queue,
    @InjectQueue('broadcast') private readonly broadcastQueue: Queue,
    @InjectQueue('dead-letter') private readonly deadLetterQueue: Queue,
    @InjectQueue('webhook-delivery') private readonly webhookDeliveryQueue: Queue,
  ) {}

  async check(): Promise<HealthStatus> {
    const checks: HealthStatus['checks'] = {};
    const probe = async <T>(name: string, operation: () => Promise<T>) => {
      const started = performance.now();
      const result = await this.probes.run(name, operation);
      checks[name] = {
        status: result.ok ? 'up' : 'down',
        durationMs: Math.round(performance.now() - started),
        ...(!result.ok ? { reason: result.reason } : {}),
      };
      return result;
    };
    const entries: [string, Queue][] = [
      ['whatsapp-outbound', this.whatsappQueue],
      ['email-outbound', this.emailQueue],
      ['sms-outbound', this.smsQueue],
      ['recurring-giving', this.recurringGivingQueue],
      ['nightly-jobs', this.nightlyJobsQueue],
      ['broadcast', this.broadcastQueue],
      ['dead-letter', this.deadLetterQueue],
      ['webhook-delivery', this.webhookDeliveryQueue],
    ];
    const [database, redis, heartbeat, queues] = await Promise.all([
      probe('database', () => this.prisma.$queryRaw`SELECT 1`),
      probe('redis', () => this.redis.ping()),
      probe('workers', () => this.workerStatus.snapshot()),
      Promise.all(
        entries.map(async ([name, queue]): Promise<[string, QueueMetrics]> => {
          const counts = await probe(`queue:${name}`, () =>
            queue.getJobCounts('active', 'waiting', 'completed', 'failed', 'delayed'),
          );
          return [
            name,
            {
              status: counts.ok ? 'up' : 'down',
              active: counts.ok ? (counts.value.active ?? 0) : 0,
              waiting: counts.ok ? (counts.value.waiting ?? 0) : 0,
              completed: counts.ok ? (counts.value.completed ?? 0) : 0,
              failed: counts.ok ? (counts.value.failed ?? 0) : 0,
              delayed: counts.ok ? (counts.value.delayed ?? 0) : 0,
            },
          ];
        }),
      ),
    ]);
    const workers = Object.fromEntries(
      entries.map(([name]) => [name, heartbeat.ok ? (heartbeat.value[name] ?? 'down') : 'down']),
    ) as HealthStatus['workers'];
    if (heartbeat.ok && Object.values(workers).some((state) => state !== 'up')) {
      checks.workers.status = 'down';
      checks.workers.reason = 'missing_or_stale';
    }
    const allUp =
      database.ok &&
      redis.ok &&
      queues.every(([, queue]) => queue.status === 'up') &&
      Object.values(workers).every((state) => state === 'up');
    return {
      status: allUp ? 'healthy' : !database.ok && !redis.ok ? 'unhealthy' : 'degraded',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      services: { database: database.ok ? 'up' : 'down', redis: redis.ok ? 'up' : 'down' },
      queues: Object.fromEntries(queues),
      workers,
      checks,
    };
  }
}
