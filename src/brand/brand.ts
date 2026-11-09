/** Product identity. Operational hosts, addresses and security realms are not branding. */
export const BRAND_NAME = 'BelivrHQ';
export const BRAND_NAMESPACE = 'belivrhq';
export const LEGACY_BRAND = {
  name: 'ChurchOS',
  namespace: 'churchos',
  totpDomain: 'churchos:totp:v1:',
  recoveryDomain: 'churchos:recovery:',
  pastoralSalt: 'churchos-pastoral-salt',
  uploadDomain: 'churchos-direct-upload:',
  emailIdempotencyPrefix: 'churchos-account-',
  assistantBudgetPrefix: 'ask-churchos:v1:',
  assistantConfigPrefix: 'ASK_CHURCHOS_',
  proxySecretHeader: 'x-churchos-proxy-secret',
  proxyIpHeader: 'x-churchos-client-ip',
} as const;
/** New configuration wins even when explicitly disabled/empty. */
export function brandConfig<T = string>(
  config: { get<U = string>(key: string): U | undefined },
  key: string,
): T | undefined {
  return (
    config.get<T>(key) ??
    config.get<T>(key.replace('ASK_BELIVRHQ_', LEGACY_BRAND.assistantConfigPrefix))
  );
}
export const SUBSCRIPTION_REFERENCE = /^(?:BHQSUB_|COSUB_)[a-f0-9]{32}$/;
export const QUOTE_REFERENCE = /^(?:BHQQUOTE_|COSQ_)[a-f0-9]{32}$/;
export const ASSET_QR = /^(?:BELIVRHQ|CHURCHOS):ASSET:([a-f0-9-]{36})$/i;
