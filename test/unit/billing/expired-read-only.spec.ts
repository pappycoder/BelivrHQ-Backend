import { entitlementsFromSubscription } from '../../../src/billing/entitlements';
import {
  isSubscriptionRead,
  readOnlyPermission,
  subscriptionWriteExempt,
} from '../../../src/billing/subscription-access';
const expired = {
  plan: 'network',
  cycle: 'monthly',
  paid_until: new Date('2020-02-01'),
  access_grants: null,
} as never;
describe('Expired paid access', () => {
  it('retains features only in read-only mode for naturally expired subscriptions', () => {
    expect(entitlementsFromSubscription(expired)).toMatchObject({
      active: false,
      readOnly: true,
      plan: 'network',
    });
    expect(entitlementsFromSubscription(null)).toMatchObject({ active: false, readOnly: false });
  });
  it.each(['review', 'revoked'])('does not restore disputed or refunded access: %s', (state) => {
    const subscription = {
      ...(expired as object),
      access_grants: {
        grants: [
          {
            reference: 'paid',
            plan: 'network',
            cycle: 'monthly',
            start: '2020-01-01',
            end: '2099-01-01',
            state,
          },
        ],
      },
    } as never;
    expect(entitlementsFromSubscription(subscription)).toMatchObject({
      active: false,
      readOnly: false,
    });
  });
  it('selects the previous legitimately paid plan, excluding revoked upgrades', () => {
    const subscription = {
      ...(expired as object),
      access_grants: {
        grants: [
          {
            reference: 'base',
            plan: 'community',
            cycle: 'monthly',
            start: '2020-01-01',
            end: '2020-02-01',
            state: 'clear',
          },
          {
            reference: 'upgrade',
            plan: 'network',
            cycle: 'monthly',
            start: '2020-01-10',
            end: '2020-02-01',
            state: 'revoked',
            upgrade: true,
          },
        ],
      },
    } as never;
    expect(entitlementsFromSubscription(subscription)).toMatchObject({
      active: false,
      readOnly: true,
      plan: 'community',
    });
  });
  it('permits viewing/export and billing, never business mutations', () => {
    expect(isSubscriptionRead('GET', '/members')).toBe(true);
    expect(isSubscriptionRead('POST', '/reports/export')).toBe(true);
    expect(isSubscriptionRead('POST', '/members')).toBe(false);
    expect(subscriptionWriteExempt('/billing/checkout')).toBe(true);
    expect(subscriptionWriteExempt('/auth/refresh')).toBe(true);
    expect(subscriptionWriteExempt('/profiles/me')).toBe(false);
    expect(['members:all:read', 'reports:export', 'billing:update'].every(readOnlyPermission)).toBe(
      true,
    );
    expect(readOnlyPermission('members:new:create')).toBe(false);
  });
});
