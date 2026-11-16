/** Do not leave a worker alive forever when a provider/Redis operation stalls shutdown. */
export function installWorkerShutdownDeadline(
  timeoutMs = 25000,
  events: Pick<NodeJS.Process, 'once' | 'removeListener'> = process,
  exit: () => void = () => process.exit(1),
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const begin = () => {
    if (!timer) {
      timer = setTimeout(exit, timeoutMs);
      timer.unref();
    }
  };
  events.once('SIGTERM', begin);
  events.once('SIGINT', begin);
  return () => {
    events.removeListener('SIGTERM', begin);
    events.removeListener('SIGINT', begin);
    if (timer) clearTimeout(timer);
  };
}
