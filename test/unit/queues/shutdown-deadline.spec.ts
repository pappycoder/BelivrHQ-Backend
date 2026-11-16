import { EventEmitter } from 'node:events';
import { installWorkerShutdownDeadline } from '../../../src/queues/shutdown-deadline';

describe('Bounded worker shutdown', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  it('does not terminate an active worker without a shutdown signal', () => {
    const events = new EventEmitter();
    const exit = jest.fn();
    const cleanup = installWorkerShutdownDeadline(100, events as never, exit);
    jest.advanceTimersByTime(200);
    expect(exit).not.toHaveBeenCalled();
    cleanup();
    expect(events.listenerCount('SIGTERM')).toBe(0);
  });
  it.each(['SIGINT', 'SIGTERM'])('allows graceful completion but bounds a stalled %s', (signal) => {
    const events = new EventEmitter();
    const exit = jest.fn();
    const cleanup = installWorkerShutdownDeadline(100, events as never, exit);
    events.emit(signal);
    events.emit(signal === 'SIGINT' ? 'SIGTERM' : 'SIGINT');
    jest.advanceTimersByTime(99);
    expect(exit).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(exit).toHaveBeenCalledTimes(1);
    cleanup();
    expect(jest.getTimerCount()).toBe(0);
  });
  it('cancels the deadline when shutdown completes', () => {
    const events = new EventEmitter();
    const exit = jest.fn();
    const cleanup = installWorkerShutdownDeadline(100, events as never, exit);
    events.emit('SIGTERM');
    cleanup();
    jest.advanceTimersByTime(200);
    expect(exit).not.toHaveBeenCalled();
  });
});
