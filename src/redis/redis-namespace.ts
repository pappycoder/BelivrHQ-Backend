type Reader = (name: string) => unknown;
/** Preserve existing production keys; previews must never consume production queues. */
export function redisNamespace(read: Reader = (name) => process.env[name]): string {
  const configured = read('REDIS_NAMESPACE');
  if (
    configured !== undefined &&
    configured !== '' &&
    (typeof configured !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(configured))
  )
    throw new Error(
      'REDIS_NAMESPACE must contain 1 to 64 letters, numbers, underscores or hyphens',
    );
  return (
    (configured as string | undefined) ||
    (read('VERCEL_ENV') === 'preview' ? 'belivrhq-preview' : '')
  );
}
export function redisKey(key: string, namespace: string): string {
  return namespace ? `${namespace}:${key}` : key;
}
export function queuePrefix(read?: Reader): string {
  const namespace = redisNamespace(read);
  return namespace ? `${namespace}:bull` : 'bull';
}
