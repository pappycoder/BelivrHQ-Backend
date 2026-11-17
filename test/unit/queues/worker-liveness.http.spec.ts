import { AddressInfo } from 'node:net';
import { WorkerLivenessService } from '../../../src/queues/worker-liveness.service';

describe('Optional worker process liveness', () => {
  it('has no listener unless the host requests one', async () => {
    const service = new WorkerLivenessService({ get: () => undefined } as never);
    await service.onApplicationBootstrap();
    expect(service['server']).toBeUndefined();
    await service.onModuleDestroy();
  });
  it.each(['private', '-1', '65536'])(
    'rejects invalid ports without echoing settings: %s',
    async (port) => {
      const service = new WorkerLivenessService({ get: () => port } as never);
      await expect(service.onApplicationBootstrap()).rejects.toThrow('must be an integer port');
      await service.onModuleDestroy();
    },
  );
  it('serves only a process-only route and closes the listener during shutdown', async () => {
    const service = new WorkerLivenessService({ get: () => '0' } as never);
    await service.onApplicationBootstrap();
    try {
      const port = (service['server']!.address() as AddressInfo).port;
      const live = await fetch(`http://127.0.0.1:${port}/health/live`);
      expect(live.status).toBe(200);
      expect(await live.json()).toEqual({ status: 'alive' });
      expect((await fetch(`http://127.0.0.1:${port}/health/ready`)).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${port}/health/live`, { method: 'POST' })).status).toBe(
        404,
      );
    } finally {
      await service.onModuleDestroy();
    }
    expect(service['server']!.listening).toBe(false);
  });
});
