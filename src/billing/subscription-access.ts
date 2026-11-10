/** Reads still require their normal role, tenant and feature permissions. */
export function isSubscriptionRead(method: string, path: string) {
  return (
    ['GET', 'HEAD', 'OPTIONS'].includes(method) || (method === 'POST' && path === '/reports/export')
  );
}
export function subscriptionWriteExempt(path: string) {
  return (
    /^\/billing(?:\/|$)/.test(path) ||
    /^\/auth\/(?:session|login(?:\/2fa)?|logout|refresh|forgot-password|reset-password)$/.test(path)
  );
}
export function readOnlyPermission(permission: string) {
  return permission.startsWith('billing:') || /:(?:read|view|export|download)$/.test(permission);
}
