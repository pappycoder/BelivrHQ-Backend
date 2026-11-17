import { WorkerHost } from '@nestjs/bullmq';
import { EventEmitter } from 'node:events';
import * as Sentry from '@sentry/nestjs';
import { TerminalFailureService } from '../../../src/queues/terminal-failure.service';

jest.mock('@sentry/nestjs', () => ({ captureMessage: jest.fn() }));
class Host extends WorkerHost {
  async process() {}
}
describe('Terminal failure routing and restart recovery', () => {
  let add: jest.Mock;
  let getFailed: jest.Mock;
  let service: TerminalFailureService;
  let discovery: { getProviders: jest.Mock };
  const failedJob = () => ({
    id: 'job-1',
    attemptsMade: 3,
    data: {
      churchId: 'church-1',
      to: 'PRIVATE_RECIPIENT',
      body: 'PRIVATE_BODY',
      secret: 'PRIVATE_TOKEN',
    },
    getState: jest.fn().mockResolvedValue('failed'),
  });
  beforeEach(() => {
    add = jest.fn().mockResolvedValue({});
    getFailed = jest.fn().mockResolvedValue([]);
    discovery = { getProviders: jest.fn().mockReturnValue([]) };
    service = new TerminalFailureService(
      discovery as never,
      { get: () => ({ getFailed }) } as never,
      {
        webhookDelivery: { findUnique: async () => ({ subscription_id: 'sub-1' }) },
        webhookSubscription: { findUnique: async () => ({ church_id: 'church-1' }) },
      } as never,
      { add } as never,
    );
  });
  it('routes exhausted failures under a stable ID without copying payloads', async () => {
    const job = failedJob();
    await service.record('email-outbound', job as never);
    await service.record('email-outbound', job as never);
    expect(add.mock.calls[0][2].jobId).toBe(add.mock.calls[1][2].jobId);
    expect(add.mock.calls[0][1]).toMatchObject({
      queue: 'email-outbound',
      reviewOnly: true,
      attempts: 3,
      jobId: 'job-1',
    });
    expect(JSON.stringify(add.mock.calls)).not.toContain('PRIVATE');
  });
  it.each(['active', 'waiting', 'delayed', 'completed'])(
    'does not route native %s jobs',
    async (state) => {
      const job = failedJob();
      job.getState.mockResolvedValue(state);
      await service.record('email-outbound', job as never);
      expect(add).not.toHaveBeenCalled();
    },
  );
  it('never recursively routes the dead-letter queue or unknown queues', async () => {
    await service.record('dead-letter', failedJob() as never);
    await service.record('unknown', failedJob() as never);
    await service.record('broadcast', { ...failedJob(), id: undefined } as never);
    expect(add).not.toHaveBeenCalled();
  });
  it('resolves webhook tenant identity from persisted data', async () => {
    const job = { ...failedJob(), data: { deliveryId: 'delivery-1' } };
    await service.record('webhook-delivery', job as never);
    expect(add.mock.calls[0][1]).toMatchObject({
      churchId: 'church-1',
      deliveryId: 'delivery-1',
      reviewOnly: false,
    });
  });
  it('recovers failures missed during a restart using bounded queue scans', async () => {
    const original = process.env.ENABLE_QUEUE_WORKERS;
    try {
      process.env.ENABLE_QUEUE_WORKERS = 'false';
      await service.recoverMissedFailures();
      expect(getFailed).not.toHaveBeenCalled();
      process.env.ENABLE_QUEUE_WORKERS = 'true';
      getFailed.mockResolvedValueOnce([failedJob()]);
      await service.recoverMissedFailures();
      expect(getFailed).toHaveBeenCalledTimes(7);
      expect(getFailed).toHaveBeenCalledWith(0, 49);
      expect(add).toHaveBeenCalledTimes(1);
      getFailed.mockRejectedValueOnce(new Error('PRIVATE'));
      await expect(service.recoverMissedFailures()).resolves.toBeUndefined();
    } finally {
      if (original === undefined) delete process.env.ENABLE_QUEUE_WORKERS;
      else process.env.ENABLE_QUEUE_WORKERS = original;
    }
  });
  it('attaches/detaches worker listeners and throttles sanitized connection alerts', async () => {
    const worker = Object.assign(new EventEmitter(), { name: 'email-outbound' });
    const instance = new Host();
    Object.defineProperty(instance, 'worker', { value: worker });
    discovery.getProviders.mockReturnValue([{ instance }, { instance: {} }]);
    service.onApplicationBootstrap();
    worker.emit('error', new Error('PRIVATE'));
    worker.emit('error', new Error('PRIVATE'));
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(jest.mocked(Sentry.captureMessage).mock.calls)).not.toContain('PRIVATE');
    worker.emit('failed', failedJob());
    await Promise.resolve();
    await Promise.resolve();
    expect(add).toHaveBeenCalledTimes(1);
    service.onModuleDestroy();
    expect(worker.listenerCount('failed')).toBe(0);
    expect(worker.listenerCount('error')).toBe(0);
    await service.record('email-outbound', failedJob() as never);
    expect(add).toHaveBeenCalledTimes(1);
  });
});
