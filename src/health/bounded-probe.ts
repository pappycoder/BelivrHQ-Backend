export type ProbeResult<T> =
  { ok: true; value: T } | { ok: false; reason: 'timeout' | 'unavailable' };

/** Share timed-out work too, so repeated health requests cannot accumulate checks. */
export class BoundedProbe {
  private readonly pending = new Map<string, Promise<unknown>>();
  constructor(private readonly deadlineMs = 3000) {}

  async run<T>(name: string, operation: () => Promise<T>): Promise<ProbeResult<T>> {
    let task = this.pending.get(name) as Promise<T> | undefined;
    if (!task) {
      task = Promise.resolve().then(operation);
      this.pending.set(name, task);
      const release = () => {
        if (this.pending.get(name) === task) this.pending.delete(name);
      };
      void task.then(release, release);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        task.then(
          (value): ProbeResult<T> => ({ ok: true, value }),
          (): ProbeResult<T> => ({ ok: false, reason: 'unavailable' }),
        ),
        new Promise<ProbeResult<T>>((resolve) => {
          timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), this.deadlineMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
