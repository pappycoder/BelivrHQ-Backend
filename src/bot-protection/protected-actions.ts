/** Explicit allowlist: challenge issuance and enforcement share the same route policy. */
export function protectedAction(method: string, path: string): { authenticated: boolean } | null {
  path = path.toLowerCase();
  if (
    method === 'POST' &&
    /^\/auth\/(login(?:\/2fa)?|register|forgot-password|accept-invitation)$/.test(path)
  )
    return { authenticated: false };
  if (method === 'PATCH' && path === '/auth/reset-password') return { authenticated: false };
  if (method === 'POST' && /^\/forms\/public\/[a-zA-Z0-9_-]+\/submit$/.test(path))
    return { authenticated: false };
  if (
    (method === 'PUT' && path === '/auth/password') ||
    (method === 'POST' && ['/profiles/invite', '/church/invite', '/broadcasts'].includes(path)) ||
    (method === 'POST' && /^\/profiles\/[a-zA-Z0-9_-]+\/reset-password$/.test(path))
  )
    return { authenticated: true };
  return null;
}
