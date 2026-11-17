import { WorkerHost } from '@nestjs/bullmq';
import { WorkerHeartbeatService } from '../../../src/queues/worker-heartbeat.service';
import {
  WorkerStatusService,
  WORKER_QUEUES,
  HEARTBEAT_TTL_SECONDS,
} from '../../../src/queues/worker-status.service';

class Host extends WorkerHost {
  async process() {}
}
function host(name = 'broadcast') {
  const worker = {
    name,
    toKey: (key: string) => `bull:${name}:${key}`,
    isRunning: jest.fn().mockReturnValue(true),
    isPaused: jest.fn().mockReturnValue(false),
    client: Promise.resolve({ get: jest.fn().mockResolvedValue('PONG') }),
  };
  const instance = new Host();
  Object.defineProperty(instance, 'worker', { value: worker });
  return { instance, worker };
}

describe('Worker readiness publication', () => {
  it('does not publish readiness for producer instances', async () => {
    const set = jest.fn();
    const service = new WorkerHeartbeatService(
      { getProviders: () => [{ instance: {} }] } as never,
      { set } as never,
    );
    await service.publish();
    expect(set).not.toHaveBeenCalled();
  });
  it('publishes a leased capability only after its consumer connection responds', async () => {
    const { instance } = host();
    const set = jest.fn();
    const service = new WorkerHeartbeatService(
      { getProviders: () => [{ instance }] } as never,
      { set } as never,
    );
    await service.publish();
    expect(set).toHaveBeenCalledWith(
      'worker:heartbeat:broadcast',
      expect.objectContaining({
        version: 1,
        kind: 'queue-worker',
        timestamp: expect.any(Number),
        instanceId: expect.any(String),
      }),
      HEARTBEAT_TTL_SECONDS,
    );
  });
  it.each(['paused', 'stopped', 'unknown', 'disconnected'])(
    'does not renew a %s consumer',
    async (state) => {
      const { instance, worker } = host();
      const set = jest.fn();
      if (state === 'paused') worker.isPaused.mockReturnValue(true);
      if (state === 'stopped') worker.isRunning.mockReturnValue(false);
      if (state === 'unknown') worker.name = 'other';
      if (state === 'disconnected')
        worker.client = Promise.resolve({ get: jest.fn().mockRejectedValue(new Error()) });
      const service = new WorkerHeartbeatService(
        { getProviders: () => [{ instance }] } as never,
        { set } as never,
      );
      await service.publish();
      expect(set).not.toHaveBeenCalled();
    },
  );
  it('never overlaps stuck publications and stops renewing during shutdown', async () => {
    let release!: () => void;
    const get = jest.fn(
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve('PONG');
        }),
    );
    const { instance, worker } = host();
    worker.client = Promise.resolve({ get });
    const set = jest.fn();
    const service = new WorkerHeartbeatService(
      { getProviders: () => [{ instance }] } as never,
      { set } as never,
    );
    const pending = service.publish();
    await Promise.resolve();
    await Promise.resolve();
    await service.publish();
    expect(get).toHaveBeenCalledTimes(1);
    service.onModuleDestroy();
    release();
    await pending;
    await service.publish();
    expect(set).not.toHaveBeenCalled();
  });
  it('schedules periodic publication and clears its timer on shutdown', async () => {
    jest.useFakeTimers();
    try {
      const { instance } = host();
      const set = jest.fn().mockResolvedValue(undefined);
      const service = new WorkerHeartbeatService(
        { getProviders: () => [{ instance }] } as never,
        { set } as never,
      );
      service.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(20000);
      expect(set).toHaveBeenCalledTimes(2);
      service.onModuleDestroy();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('Fresh and authentic worker capabilities', () => {
  it.each([
    null,
    'producer',
    { kind: 'api', version: 1, timestamp: Date.now() },
    { kind: 'queue-worker', version: 2, timestamp: Date.now() },
    { kind: 'queue-worker', version: 1, timestamp: Date.now() - 91000 },
    { kind: 'queue-worker', version: 1, timestamp: Date.now() + 60000 },
  ])('rejects missing, invalid or stale heartbeats: %j', async (value) => {
    const service = new WorkerStatusService({
      mget: jest.fn().mockResolvedValue(WORKER_QUEUES.map(() => value)),
    } as never);
    expect(Object.values(await service.snapshot()).every((state) => state === 'down')).toBe(true);
  });
  it('requires a fresh heartbeat for every queue and performs one bounded multi-read', async () => {
    const mget = jest
      .fn()
      .mockResolvedValue(
        WORKER_QUEUES.map(() => ({ kind: 'queue-worker', version: 1, timestamp: Date.now() })),
      );
    const service = new WorkerStatusService({ mget } as never);
    expect(Object.values(await service.snapshot()).every((state) => state === 'up')).toBe(true);
    expect(mget).toHaveBeenCalledTimes(1);
    expect(mget.mock.calls[0]).toHaveLength(8);
  });
});
