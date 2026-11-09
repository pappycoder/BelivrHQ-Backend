import {
  ASSET_QR,
  brandConfig,
  LEGACY_BRAND,
  QUOTE_REFERENCE,
  SUBSCRIPTION_REFERENCE,
} from '../../../src/brand/brand';
describe('BelivrHQ compatibility', () => {
  it('preserves issued payment and quote references', () => {
    for (const prefix of ['COSUB_', 'BHQSUB_'])
      expect(SUBSCRIPTION_REFERENCE.test(prefix + 'a'.repeat(32))).toBe(true);
    for (const prefix of ['COSQ_', 'BHQQUOTE_'])
      expect(QUOTE_REFERENCE.test(prefix + 'a'.repeat(32))).toBe(true);
  });
  it('accepts already printed asset labels', () => {
    for (const prefix of ['CHURCHOS', 'BELIVRHQ'])
      expect(ASSET_QR.test(prefix + ':ASSET:00000000-0000-4000-8000-000000000001')).toBe(true);
  });
  it('prefers an explicit new configuration over the legacy alias', () => {
    const settings: Record<string, unknown> = {
      ASK_BELIVRHQ_ENABLED: false,
      ASK_CHURCHOS_ENABLED: true,
    };
    const config = { get: <T>(key: string) => settings[key] as T | undefined };
    expect(brandConfig(config, 'ASK_BELIVRHQ_ENABLED')).toBe(false);
    delete settings.ASK_BELIVRHQ_ENABLED;
    expect(brandConfig(config, 'ASK_BELIVRHQ_ENABLED')).toBe(true);
  });
  it('keeps the deployed encryption and provider idempotency realms byte-for-byte', () => {
    expect(LEGACY_BRAND.pastoralSalt).toBe('churchos-pastoral-salt');
    expect(LEGACY_BRAND.totpDomain).toBe('churchos:totp:v1:');
    expect(LEGACY_BRAND.recoveryDomain).toBe('churchos:recovery:');
    expect(LEGACY_BRAND.emailIdempotencyPrefix).toBe('churchos-account-');
  });
});
