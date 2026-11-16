import { HealthService } from '../../../src/health/health.service';
import { HealthController } from '../../../src/health/health.controller';
import { BoundedProbe } from '../../../src/health/bounded-probe';
import { WORKER_QUEUES } from '../../../src/queues/worker-status.service';

describe('Bounded dependency checks', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  it('shares stalled work across requests and permits recovery after settlement', async () => {
    let release!: (value: number) => void;
    const operation = jest.fn(
      () =>
        new Promise<number>((resolve) => {
          release = resolve;
        }),
    );
    const probe = new BoundedProbe(100);
    const first = probe.run('queue', operation);
    await jest.advanceTimersByTimeAsync(100);
    expect(await first).toEqual({ ok: false, reason: 'timeout' });
    const second = probe.run('queue', operation);
    await jest.advanceTimersByTimeAsync(100);
    expect(await second).toEqual({ ok: false, reason: 'timeout' });
    expect(operation).toHaveBeenCalledTimes(1);
    release(7);
    await Promise.resolve();
    await Promise.resolve();
    expect(await probe.run('queue', async () => 8)).toEqual({ ok: true, value: 8 });
    expect(jest.getTimerCount()).toBe(0);
  });
  it('observes synchronous and asynchronous failures without returning error contents', async () => {
    const probe = new BoundedProbe();
    expect(
      await probe.run('db', () => {
        throw new Error('private connection');
      }),
    ).toEqual({ ok: false, reason: 'unavailable' });
    expect(await probe.run('db', () => Promise.reject(new Error('private connection')))).toEqual({
      ok: false,
      reason: 'unavailable',
    });
    expect(await probe.run('db', async () => true)).toEqual({ ok: true, value: true });
  });
});

describe('API readiness and liveness', () => {
  let database: jest.Mock;
  let redis: jest.Mock;
  let snapshot: jest.Mock;
  let queues: { getJobCounts: jest.Mock }[];
  let service: HealthService;
  beforeEach(() => {
    database = jest.fn().mockResolvedValue([{ value: 1 }]);
    redis = jest.fn().mockResolvedValue('PONG');
    snapshot = jest
      .fn()
      .mockResolvedValue(Object.fromEntries(WORKER_QUEUES.map((name) => [name, 'up'])));
    queues = WORKER_QUEUES.map(() => ({
      getJobCounts: jest
        .fn()
        .mockResolvedValue({ active: 1, waiting: 2, completed: 3, failed: 0, delayed: 4 }),
    }));
    service = new HealthService(
      { $queryRaw: database } as never,
      { ping: redis } as never,
      { snapshot } as never,
      queues[0] as never,
      queues[1] as never,
      queues[2] as never,
      queues[3] as never,
      queues[4] as never,
      queues[5] as never,
      queues[6] as never,
      queues[7] as never,
    );
  });
  afterEach(() => jest.useRealTimers());

  it('preserves the existing dependency and queue fields and adds worker readiness', async () => {
    const result = await service.check();
    expect(result.status).toBe('healthy');
    expect(result.services).toEqual({ database: 'up', redis: 'up' });
    expect(result.queues.broadcast).toEqual({
      status: 'up',
      active: 1,
      waiting: 2,
      completed: 3,
      failed: 0,
      delayed: 4,
    });
    expect(result.workers.broadcast).toBe('up');
  });
  it.each(['database', 'redis', 'worker', 'queue'])(
    'returns HTTP 503 when %s is unavailable',
    async (failure) => {
      if (failure === 'database') database.mockRejectedValue(new Error('private'));
      if (failure === 'redis') redis.mockRejectedValue(new Error('private'));
      if (failure === 'worker') snapshot.mockResolvedValue({});
      if (failure === 'queue') queues[0].getJobCounts.mockRejectedValue(new Error('private'));
      const response = { status: jest.fn() };
      const result = await new HealthController(service).check(response as never);
      expect(response.status).toHaveBeenCalledWith(503);
      expect(result.status).toBe('degraded');
      expect(JSON.stringify(result)).not.toContain('private');
    },
  );
  it('reports unhealthy when both primary dependencies fail', async () => {
    database.mockRejectedValue(new Error());
    redis.mockRejectedValue(new Error());
    snapshot.mockRejectedValue(new Error());
    for (const queue of queues) queue.getJobCounts.mockRejectedValue(new Error());
    const result = await service.check();
    expect(result.status).toBe('unhealthy');
    expect(Object.values(result.queues).every((queue) => queue.status === 'down')).toBe(true);
    expect(Object.values(result.workers).every((state) => state === 'down')).toBe(true);
  });
  it('runs dependency deadlines concurrently and avoids accumulating stuck queue operations', async () => {
    jest.useFakeTimers();
    queues[0].getJobCounts.mockImplementation(() => new Promise(() => undefined));
    const first = service.check();
    await jest.advanceTimersByTimeAsync(3000);
    expect((await first).status).toBe('degraded');
    const second = service.check();
    await jest.advanceTimersByTimeAsync(3000);
    expect((await second).queues['whatsapp-outbound'].status).toBe('down');
    expect(queues[0].getJobCounts).toHaveBeenCalledTimes(1);
  });
  it('returns HTTP 200 only when ready, and liveness never checks dependencies', async () => {
    const controller = new HealthController(service);
    expect(controller.live().status).toBe('alive');
    expect(database).not.toHaveBeenCalled();
    const response = { status: jest.fn() };
    await controller.check(response as never);
    expect(response.status).toHaveBeenCalledWith(200);
  });
});
