/** BullMQ requires Redis TCP/TLS; an Upstash REST endpoint cannot be used here. */
export function queueRedisUrl(read: (name: string) => string | undefined): string {
  const value = read('QUEUE_REDIS_URL') || read('REDIS_URL') || 'redis://localhost:6379';
  try {
    const url = new URL(value);
    if (!['redis:', 'rediss:'].includes(url.protocol) || !url.hostname) throw new Error();
  } catch {
    throw new Error(
      'BullMQ requires a redis:// or rediss:// connection. Set QUEUE_REDIS_URL when REDIS_URL uses the Upstash HTTPS REST endpoint.',
    );
  }
  return value;
}
