import { TOTP } from 'otpauth';
import { AuthenticatorService } from '../../../src/auth/services/authenticator.service';
import { createPrismaMock } from '../../helpers/prisma-mock.helper';

describe('Backend authenticator security', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let service: AuthenticatorService;
  let redis: { get: jest.Mock; set: jest.Mock; consume: jest.Mock; incr: jest.Mock };
  const userId = 'user-1';
  beforeEach(() => {
    prisma = createPrismaMock();
    const store = new Map<string, unknown>();
    redis = {
      get: jest.fn(async (key) => store.get(key) ?? null),
      set: jest.fn(async (key, value) => {
        store.set(key, value);
      }),
      consume: jest.fn(async (key) => {
        const value = store.get(key);
        store.delete(key);
        return value;
      }),
      incr: jest.fn().mockResolvedValue(1),
    };
    service = new AuthenticatorService(
      prisma as never,
      redis as never,
      { get: () => '11'.repeat(32) } as never,
      { verifyToken: async () => ({ payload: { sub: userId, session_id: 'session-1' } }) } as never,
    );
    (prisma.$transaction as unknown as jest.Mock).mockImplementation(async (callback) =>
      callback(prisma),
    );
  });
  async function enroll() {
    prisma.profileAuthenticator.findUnique.mockResolvedValue(null);
    const setup = await service.setup(userId, 'test@example.com');
    const code = new TOTP({
      issuer: 'BelivrHQ',
      label: 'test@example.com',
      secret: setup.secret,
    }).generate();
    prisma.profileAuthenticator.create.mockImplementation(async ({ data }) => {
      prisma.profileAuthenticator.findUnique.mockResolvedValue(data);
      return data;
    });
    const result = await service.activate(userId, 'signed-token', setup.factorId, code);
    return { setup, result };
  }
  it('encrypts secrets and binds setup to the enrolling account', async () => {
    const setup = await service.setup(userId, 'test@example.com');
    expect(redis.set.mock.calls[0][1].ciphertext).not.toContain(setup.secret);
    await expect(service.activate('other-user', 'token', setup.factorId, '123456')).rejects.toThrow(
      'expired',
    );
    expect(prisma.profileAuthenticator.create).not.toHaveBeenCalled();
  });
  it('creates one-use hashed recovery codes and approves only the verified session', async () => {
    const { result } = await enroll();
    expect(result.recoveryCodes).toHaveLength(10);
    expect(prisma.profileAuthenticator.create.mock.calls[0][0].data.recovery_hashes).not.toContain(
      result.recoveryCodes[0],
    );
    expect(prisma.verifiedMfaSession.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ user_id: userId, session_id: 'session-1' }),
      }),
    );
  });
  it('requires atomic consumption of the TOTP time step', async () => {
    const { setup } = await enroll();
    const code = new TOTP({
      issuer: 'BelivrHQ',
      label: 'test@example.com',
      secret: setup.secret,
    }).generate();
    prisma.profileAuthenticator.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.verify(userId, code)).rejects.toThrow('already used');
    expect(prisma.profileAuthenticator.updateMany.mock.calls[0][0].where.last_used_step.lt).toEqual(
      expect.any(BigInt),
    );
  });
  it('atomically removes a recovery hash and rejects a second use', async () => {
    const { result } = await enroll();
    prisma.profileAuthenticator.updateMany.mockImplementation(async ({ data }) => {
      const state = await prisma.profileAuthenticator.findUnique();
      prisma.profileAuthenticator.findUnique.mockResolvedValue({ ...state, ...data });
      return { count: 1 };
    });
    await expect(service.verify(userId, result.recoveryCodes[0])).resolves.toEqual(
      expect.any(String),
    );
    await expect(service.verify(userId, result.recoveryCodes[0])).rejects.toThrow('already used');
  });
  it('enforces the account-wide attempt budget', async () => {
    redis.incr.mockResolvedValue(11);
    await expect(service.verify(userId, '123456')).rejects.toThrow('Too many');
    expect(prisma.profileAuthenticator.findUnique).not.toHaveBeenCalled();
  });
  it('rejects unapproved, expired and differently revised sessions', async () => {
    const profile = {
      status: 'active',
      two_factor_enabled: true,
      authenticator: { revision: 'revision-1' },
    };
    const payload = { sub: userId, session_id: 'session-1', aal: 'aal2' };
    prisma.verifiedMfaSession.findUnique.mockResolvedValue(null);
    await expect(service.assertSession(payload, profile)).rejects.toThrow('approved');
    prisma.verifiedMfaSession.findUnique.mockResolvedValue({
      revision: 'other',
      expires_at: new Date(Date.now() + 60000),
    });
    await expect(service.assertSession(payload, profile)).rejects.toThrow('approved');
    prisma.verifiedMfaSession.findUnique.mockResolvedValue({
      revision: 'revision-1',
      expires_at: new Date(0),
    });
    await expect(service.assertSession(payload, profile)).rejects.toThrow('approved');
    prisma.verifiedMfaSession.findUnique.mockResolvedValue({
      revision: 'revision-1',
      expires_at: new Date(Date.now() + 60000),
    });
    await expect(service.assertSession(payload, profile)).resolves.toBeUndefined();
  });
  it('approves password-only login and accepts its session on protected requests', async () => {
    const profile = { two_factor_enabled: false, authenticator: null };
    prisma.profile.findUnique.mockResolvedValue(profile);
    await service.approve(userId, 'signed-token', 'password-session');
    expect(prisma.verifiedMfaSession.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          user_id: userId,
          session_id: 'session-1',
          revision: 'password-session',
        }),
      }),
    );
    prisma.verifiedMfaSession.findUnique.mockResolvedValue(
      prisma.verifiedMfaSession.upsert.mock.calls[0][0].create,
    );
    await expect(
      service.assertSession({ sub: userId, session_id: 'session-1' }, profile),
    ).resolves.toBeUndefined();
  });
  it.each([
    null,
    { two_factor_enabled: true, authenticator: null },
    { two_factor_enabled: true, authenticator: { revision: 'current' } },
    { two_factor_enabled: false, authenticator: { revision: 'current' } },
  ])(
    'rejects password approval when the current profile requires verification: %p',
    async (profile) => {
      prisma.profile.findUnique.mockResolvedValue(profile);
      await expect(service.approve(userId, 'signed-token', 'password-session')).rejects.toThrow(
        'Authenticator changed',
      );
      expect(prisma.verifiedMfaSession.upsert).not.toHaveBeenCalled();
    },
  );
  it('approves only the current verified authenticator revision', async () => {
    prisma.profileAuthenticator.findUnique.mockResolvedValue({ revision: 'current' });
    await expect(service.approve(userId, 'signed-token', 'old')).rejects.toThrow(
      'Authenticator changed',
    );
    expect(prisma.verifiedMfaSession.upsert).not.toHaveBeenCalled();
    await service.approve(userId, 'signed-token', 'current');
    expect(prisma.verifiedMfaSession.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ revision: 'current' }) }),
    );
  });
  it('requires approval even when MFA is disabled', async () => {
    prisma.verifiedMfaSession.findUnique.mockResolvedValue(null);
    await expect(
      service.assertSession(
        { sub: userId, session_id: 'session-1' },
        { two_factor_enabled: false },
      ),
    ).rejects.toThrow('approved');
  });
});
