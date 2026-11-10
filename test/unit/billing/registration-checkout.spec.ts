import { ConfigService } from '@nestjs/config';
import {
  createRegistrationCheckout,
  readRegistrationCheckout,
} from '../../../src/auth/registration-checkout';
import { RegistrationBillingController } from '../../../src/billing/registration-billing.controller';
const config = new ConfigService({ ALTCHA_HMAC_KEY: 'a'.repeat(64) });
const identity = { userId: 'user-a', churchId: 'church-a', profileId: 'profile-a' };
describe('Signup billing capability', () => {
  it('is scoped, signed and expires without being a workspace JWT', () => {
    const token = createRegistrationCheckout(config, identity);
    expect(token.split('.')).toHaveLength(2);
    expect(readRegistrationCheckout(config, token)).toMatchObject({
      ...identity,
      purpose: 'registration-billing',
    });
    expect(() => readRegistrationCheckout(config, token + 'x')).toThrow();
    expect(() =>
      readRegistrationCheckout(new ConfigService({ ALTCHA_HMAC_KEY: 'b'.repeat(64) }), token),
    ).toThrow();
    const now = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 86401000);
    try {
      expect(() => readRegistrationCheckout(config, token)).toThrow('expired');
    } finally {
      now.mockRestore();
    }
  });
  it('never derives the tenant from the quote body and rejects cross-account claims', async () => {
    const billing = { quote: jest.fn().mockResolvedValue({}) };
    const profile = {
      id: 'profile-a',
      user_id: 'user-a',
      church_id: 'church-a',
      role: ['church_admin'],
      status: 'active',
      archived_at: null,
      email: 'admin@example.org',
      church: { archived_at: null },
    };
    const prisma = {
      profile: { findUnique: jest.fn().mockResolvedValue(profile) },
      subscriptionPayment: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const controller = new RegistrationBillingController(config, prisma as never, billing as never);
    const token = createRegistrationCheckout(config, identity);
    await controller.quote(token, {
      plan: 'essentials',
      cycle: 'monthly',
      gateway: 'flutterwave',
      currency: 'NGN',
    });
    expect(billing.quote).toHaveBeenCalledWith('church-a', expect.anything());
    prisma.profile.findUnique.mockResolvedValue({ ...profile, church_id: 'church-b' });
    await expect(controller.quote(token, {} as never)).rejects.toThrow();
  });
  it('disallows new signup checkouts after a successful payment', async () => {
    const prisma = {
      profile: {
        findUnique: jest.fn().mockResolvedValue({
          user_id: 'user-a',
          church_id: 'church-a',
          role: ['church_admin'],
          status: 'active',
          church: { archived_at: null },
        }),
      },
      subscriptionPayment: { findFirst: jest.fn().mockResolvedValue({ status: 'success' }) },
    };
    const checkout = jest.fn();
    const controller = new RegistrationBillingController(
      config,
      prisma as never,
      { checkout } as never,
    );
    await expect(
      controller.checkout(createRegistrationCheckout(config, identity), {} as never),
    ).rejects.toThrow('Sign in');
    expect(checkout).not.toHaveBeenCalled();
  });
});
