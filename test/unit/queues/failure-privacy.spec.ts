import { Logger } from '@nestjs/common';
import { DeadLetterProcessor } from '../../../src/queues/processors/dead-letter.processor';
import { failureSummary } from '../../../scripts/lib/queue-failures';
import * as Sentry from '@sentry/nestjs';

jest.mock('@sentry/nestjs', () => ({ captureMessage: jest.fn() }));
describe('Failure review privacy', () => {
  it('never prints legacy private job data or exception contents', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const record = {
      id: 'record-1',
      data: {
        queue: 'email-outbound',
        jobId: 'job-1',
        failedReason: 'PRIVATE_TOKEN',
        data: { to: 'PRIVATE_EMAIL', body: 'PRIVATE_BODY' },
      },
    };
    await new DeadLetterProcessor().process(record as never);
    expect(JSON.stringify([failureSummary(record), warn.mock.calls])).not.toContain('PRIVATE');
    expect(failureSummary(record)).toEqual({ recordId: 'record-1', legacy: true });
  });
  it('retains only allowlisted review metadata in listings and alerts', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const record = {
      id: 'record-1',
      data: {
        version: 1,
        queue: 'webhook-delivery',
        jobId: 'webhook-1',
        deliveryId: 'delivery-1',
        attempts: 3,
        failedAt: 1234,
        body: 'PRIVATE_BODY',
        secret: 'PRIVATE_TOKEN',
      },
    };
    expect(failureSummary(record)).toMatchObject({
      queue: 'webhook-delivery',
      deliveryId: 'delivery-1',
      reviewOnly: false,
    });
    await new DeadLetterProcessor().process(record as never);
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(
      JSON.stringify([
        failureSummary(record),
        warn.mock.calls,
        jest.mocked(Sentry.captureMessage).mock.calls,
      ]),
    ).not.toContain('PRIVATE');
  });
  it.each([-1, NaN, 'three'])('refuses malformed attempt metadata: %j', (attempts) => {
    expect(
      failureSummary({ data: { version: 1, queue: 'broadcast', jobId: 'job-1', attempts } }).legacy,
    ).toBe(true);
  });
});
