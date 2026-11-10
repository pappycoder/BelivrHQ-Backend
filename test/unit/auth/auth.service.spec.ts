import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { REGISTRATION_LEGAL_VERSION } from '../../../src/auth/registration-legal-acceptance';
import { AccountEmailService } from '../../../src/company-email/account-email.service';
import { CompanyEmailService } from '../../../src/company-email/company-email.service';
/**
 * @file auth.service.spec.ts
 * @description Unit tests for AuthService.
 *
 * Tests registration, login, logout, password management, profile updates,
 * and session refresh. All external dependencies (Supabase, Prisma, Redis,
 * AuditLogging) are mocked.
 *
 * @module test/unit/auth/auth.service.spec
 * @since 1.0.0
 */

import { AuthService } from '../../../src/auth/auth.service';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { SupabaseService } from '../../../src/supabase/supabase.service';
import { RedisService } from '../../../src/redis/redis.service';
import { AuditLoggingService } from '../../../src/common/services/audit-logging.service';
import { ConfigService } from '@nestjs/config';
import { EmailDeliveryService } from '../../../src/communication/email-delivery.service';
import {
  ConflictException,
  UnauthorizedException,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { RegisterDto } from '../../../src/auth/dto/register.dto';
import { LoginDto } from '../../../src/auth/dto/login.dto';
import { hashTwoFactorCode } from '../../../src/profile/two-factor.util';

describe('AuthService', () => {
  let service: AuthService;
  let prisma: Record<string, unknown> & { $transaction: jest.Mock };
  let signUpMock: jest.Mock;
  let signInMock: jest.Mock;
  let updateUserMock: jest.Mock;
  let getUserByIdMock: jest.Mock;
  let adminUpdateUserByIdMock: jest.Mock;
  let refreshSessionMock: jest.Mock;
  let resetPasswordForEmailMock: jest.Mock;
  let signOutMock: jest.Mock;
  let redis: {
    set: jest.Mock;
    get: jest.Mock;
    del: jest.Mock;
    incr: jest.Mock;
    consume: jest.Mock;
  };
  let resend: { sendEmail: jest.Mock };
  let audit: { log: jest.Mock };
  let companyEmails: { enqueueWelcome: jest.Mock; dispatch: jest.Mock };
  let config: { get: jest.Mock; getOrThrow: jest.Mock };
  let accountEmails: { sendPasswordReset: jest.Mock };

  const mockUserId = '11111111-1111-1111-1111-111111111111';
  const mockChurchId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const mockProfileId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

  function createPrismaMock() {
    const models: Record<string, Record<string, jest.Mock>> = {};
    const $transactionMock = jest.fn();

    const handler: ProxyHandler<Record<string, unknown>> = {
      get(_target, prop: string) {
        if (prop === '$transaction') {
          return $transactionMock;
        }
        if (!models[prop]) {
          models[prop] = {
            findMany: jest.fn(),
            findUnique: jest.fn(),
            findFirst: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
            delete: jest.fn(),
            deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
            count: jest.fn(),
          };
        }
        return models[prop];
      },
    };

    return new Proxy(
      { $transaction: $transactionMock } as Record<string, unknown>,
      handler,
    ) as Record<string, unknown> & { $transaction: jest.Mock };
  }

  function model(prismaMock: Record<string, unknown>, name: string): Record<string, jest.Mock> {
    return prismaMock[name] as Record<string, jest.Mock>;
  }

  beforeEach(() => {
    prisma = createPrismaMock();
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    redis = {
      incr: jest.fn().mockResolvedValue(1),
      consume: jest.fn().mockResolvedValue({ consumed: true }),
      set: jest.fn().mockResolvedValue(undefined),
      get: jest.fn().mockResolvedValue(null),
      del: jest.fn().mockResolvedValue(undefined),
    };
    resend = { sendEmail: jest.fn().mockResolvedValue(undefined) };
    config = {
      get: jest
        .fn()
        .mockImplementation((key: string) =>
          key === 'ALTCHA_HMAC_KEY' ? 'a'.repeat(64) : 'https://church-os-web.vercel.app',
        ),
      getOrThrow: jest.fn().mockReturnValue('https://church-os-web.vercel.app'),
    };
    accountEmails = { sendPasswordReset: jest.fn().mockResolvedValue(undefined) };

    signUpMock = jest.fn();
    signInMock = jest.fn();
    updateUserMock = jest.fn();
    refreshSessionMock = jest.fn();
    resetPasswordForEmailMock = jest.fn();
    signOutMock = jest.fn().mockResolvedValue({ error: null });
    getUserByIdMock = jest.fn();
    adminUpdateUserByIdMock = jest.fn().mockResolvedValue({ error: null });

    companyEmails = {
      enqueueWelcome: jest.fn().mockResolvedValue('registration/event'),
      dispatch: jest.fn().mockResolvedValue(undefined),
    };
    service = new AuthService(
      prisma as unknown as PrismaService,
      {
        createAuthClient: () => ({
          auth: {
            signUp: signUpMock,
            signInWithPassword: signInMock,
            refreshSession: refreshSessionMock,
            resetPasswordForEmail: resetPasswordForEmailMock,
            verifyOtp: getUserByIdMock,
            updateUser: updateUserMock,
            getUser: getUserByIdMock,
            setSession: jest.fn().mockResolvedValue({ error: null }),
          },
        }),
        client: {
          auth: {
            signUp: signUpMock,
            signInWithPassword: signInMock,
            updateUser: updateUserMock,
            refreshSession: refreshSessionMock,
            resetPasswordForEmail: resetPasswordForEmailMock,
            admin: {
              generateLink: resetPasswordForEmailMock,
              signOut: signOutMock,
              getUserById: getUserByIdMock,
              updateUserById: adminUpdateUserByIdMock,
            },
          },
        },
      } as unknown as SupabaseService,
      redis as unknown as RedisService,
      audit as unknown as AuditLoggingService,
      config as unknown as ConfigService,
      resend as unknown as EmailDeliveryService,
      {
        approve: jest.fn().mockResolvedValue(undefined),
        attempt: jest.fn(),
        setup: jest
          .fn()
          .mockResolvedValue({ factorId: 'factor-1', secret: 'secret', qrCode: 'qr', uri: 'uri' }),
        assertSession: jest.fn().mockResolvedValue(undefined),
      } as never,
      {
        verifyToken: jest
          .fn()
          .mockResolvedValue({ payload: { sub: mockUserId, session_id: 'session-1' } }),
      } as never,
      companyEmails as unknown as CompanyEmailService,
      accountEmails as unknown as AccountEmailService,
    );
  });

  // ─── REGISTER ──────────────────────────────────────────────────────

  describe('register', () => {
    const validDto: RegisterDto = {
      email: 'pastor@gracecommunity.com',
      password: 'SecureP@ss123',
      firstName: 'Adebayo',
      lastName: 'Ogundimu',
      phone: '+234 803 456 7890',
      churchName: 'Grace Community Church',
      denomination: 'Pentecostal',
    };

    it('does not create a new billable church for an obfuscated existing-user response', async () => {
      signUpMock.mockResolvedValue({
        data: { user: { id: mockUserId, email: validDto.email, identities: [] }, session: null },
        error: null,
      });
      await expect(service.register(validDto)).rejects.toThrow('Account already exists');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it.each([
      [false, false, false],
      [true, false, false],
      [true, true, false],
      [true, false, true],
      [false, false, true],
    ])(
      'creates the account with session=%s, approvalFailure=%s and legalAcceptance=%s',
      async (hasSession, approvalFailure, acceptsTerms) => {
        const approve = jest.spyOn(service['authenticator'], 'approve');
        if (approvalFailure) approve.mockRejectedValueOnce(new Error('approval unavailable'));
        signUpMock.mockResolvedValue({
          data: {
            user: { id: mockUserId, email: validDto.email },
            session: hasSession
              ? {
                  access_token: 'signup-access',
                  refresh_token: 'signup-refresh',
                  expires_at: 1900000000,
                }
              : null,
          },
          error: null,
        });

        const profileCreate = jest.fn().mockResolvedValue({
          id: mockProfileId,
          user_id: mockUserId,
          church_id: mockChurchId,
          role: 'church_admin',
          first_name: validDto.firstName,
          last_name: validDto.lastName,
          phone: validDto.phone,
        });

        prisma.$transaction.mockImplementation(
          async (cb: (tx: Record<string, Record<string, jest.Mock>>) => Promise<unknown>) => {
            return cb({
              church: {
                create: jest.fn().mockResolvedValue({
                  id: mockChurchId,
                  name: validDto.churchName,
                  denomination: validDto.denomination,
                }),
              },
              profile: {
                create: profileCreate,
              },
              platformSubscription: { create: jest.fn().mockResolvedValue({}) },
            });
          },
        );

        const result = await service.register({
          ...validDto,
          ...(acceptsTerms
            ? {
                termsAccepted: true,
                acceptedTermsVersion: REGISTRATION_LEGAL_VERSION,
              }
            : {}),
        });
        const storedAcceptance = signUpMock.mock.calls[0][0].options.data.belivrhq_legal_acceptance;
        if (acceptsTerms) {
          expect(storedAcceptance).toMatchObject({
            termsOfServiceVersion: REGISTRATION_LEGAL_VERSION,
            websiteTermsVersion: REGISTRATION_LEGAL_VERSION,
            privacyNoticeVersion: REGISTRATION_LEGAL_VERSION,
            source: 'registration',
          });
          expect(Number.isNaN(Date.parse(storedAcceptance.acceptedAt))).toBe(false);
          expect(audit.log).toHaveBeenCalledWith(
            expect.objectContaining({
              newValues: expect.objectContaining({ legalAcceptance: storedAcceptance }),
            }),
          );
        } else {
          expect(storedAcceptance).toBeUndefined();
          expect(audit.log.mock.calls[0][0].newValues).not.toHaveProperty('legalAcceptance');
        }
        expect(companyEmails.enqueueWelcome).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            email: validDto.email,
            churchName: validDto.churchName,
            plan: 'essentials',
            requiresEmailConfirmation: !hasSession,
          }),
        );
        expect(companyEmails.dispatch).toHaveBeenCalledWith('registration/event');

        expect(result).toEqual({
          requiresEmailConfirmation: !hasSession,
          registrationCheckoutToken: expect.any(String),
          userId: mockUserId,
          email: validDto.email,
          profileId: mockProfileId,
          churchId: mockChurchId,
          churchName: validDto.churchName,
          role: 'church_admin',
        });
        expect(signInMock).not.toHaveBeenCalled();
        expect(approve).not.toHaveBeenCalled();
        expect(result).not.toHaveProperty('accessToken');
        expect(result).not.toHaveProperty('refreshToken');

        expect(profileCreate).toHaveBeenCalledWith({
          data: expect.objectContaining({
            role: ['church_admin'],
            is_admin_hq: true,
          }),
        });

        expect(audit.log).toHaveBeenCalledWith(
          expect.objectContaining({
            userId: mockUserId,
            churchId: mockChurchId,
            entity: 'auth',
            action: 'CREATE',
          }),
        );
      },
    );

    it.each([
      { termsAccepted: false, acceptedTermsVersion: REGISTRATION_LEGAL_VERSION },
      { termsAccepted: true },
      { acceptedTermsVersion: REGISTRATION_LEGAL_VERSION },
      { termsAccepted: true, acceptedTermsVersion: 'outdated' },
      { termsAccepted: null, acceptedTermsVersion: REGISTRATION_LEGAL_VERSION },
    ])(
      'rejects incomplete or stale declared legal acceptance before signup: %j',
      async (acceptance) => {
        await expect(
          service.register({ ...validDto, ...acceptance } as RegisterDto),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(signUpMock).not.toHaveBeenCalled();
        expect(prisma.$transaction).not.toHaveBeenCalled();
      },
    );

    it.each(['true', 'false', 1, 0])(
      'rejects non-boolean agreement declarations despite implicit conversion: %j',
      async (termsAccepted) => {
        const dto = plainToInstance(
          RegisterDto,
          { ...validDto, termsAccepted, acceptedTermsVersion: REGISTRATION_LEGAL_VERSION },
          { enableImplicitConversion: true },
        );
        expect((await validate(dto)).some((error) => error.property === 'termsAccepted')).toBe(
          true,
        );
      },
    );

    it('should throw ConflictException if email is already registered', async () => {
      signUpMock.mockResolvedValue({
        data: { user: null },
        error: { message: 'already registered' },
      });

      await expect(service.register(validDto)).rejects.toThrow(ConflictException);
    });

    it('should throw InternalServerErrorException if Supabase fails', async () => {
      signUpMock.mockResolvedValue({
        data: { user: null },
        error: { message: 'Internal server error' },
      });

      await expect(service.register(validDto)).rejects.toThrow('Failed to create user account');
    });

    it('should throw InternalServerErrorException if Supabase returns no user', async () => {
      signUpMock.mockResolvedValue({
        data: { user: null },
        error: null,
      });

      await expect(service.register(validDto)).rejects.toThrow('Failed to create user account');
    });

    it('should throw InternalServerErrorException if Prisma transaction fails', async () => {
      signUpMock.mockResolvedValue({
        data: { user: { id: mockUserId, email: validDto.email } },
        error: null,
      });

      prisma.$transaction.mockRejectedValue(new Error('DB connection failed'));

      await expect(service.register(validDto)).rejects.toThrow('Failed to complete registration');
    });
  });

  // ─── LOGIN ─────────────────────────────────────────────────────────

  describe('login', () => {
    const loginDto: LoginDto = {
      email: 'pastor@gracecommunity.com',
      password: 'SecureP@ss123',
    };

    it('should login successfully and return tokens with profile', async () => {
      signInMock.mockResolvedValue({
        data: {
          user: { id: mockUserId, email: loginDto.email },
          session: {
            access_token: 'jwt-access-token',
            refresh_token: 'jwt-refresh-token',
            expires_at: 1700000000,
          },
        },
        error: null,
      });

      model(prisma, 'profile').findUnique.mockResolvedValue({
        id: mockProfileId,
        church_id: mockChurchId,
        branch_id: 'branch-1',
        role: 'church_admin',
        first_name: 'Adebayo',
        last_name: 'Ogundimu',
      });

      const result = await service.login(loginDto);

      expect(result.accessToken).toBe('jwt-access-token');
      expect(result.refreshToken).toBe('jwt-refresh-token');
      expect(result.userId).toBe(mockUserId);
      expect(result.email).toBe(loginDto.email);
      expect(result.profile?.role).toBe('church_admin');
      expect(result.profile?.churchId).toBe(mockChurchId);

      expect(signInMock).toHaveBeenCalledWith({
        email: loginDto.email,
        password: loginDto.password,
      });

      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: mockUserId,
          entity: 'auth',
          action: 'LOGIN',
        }),
      );
    });

    it('should throw UnauthorizedException on invalid credentials', async () => {
      signInMock.mockResolvedValue({
        data: { user: null, session: null },
        error: { message: 'Invalid login credentials' },
      });

      await expect(service.login(loginDto)).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException if Supabase returns no user', async () => {
      signInMock.mockResolvedValue({
        data: { user: null, session: null },
        error: null,
      });

      await expect(service.login(loginDto)).rejects.toThrow(UnauthorizedException);
    });

    it('should return profile even if user has no profile', async () => {
      signInMock.mockResolvedValue({
        data: {
          user: { id: mockUserId, email: loginDto.email },
          session: {
            access_token: 'jwt-access-token',
            refresh_token: 'jwt-refresh-token',
            expires_at: 1700000000,
          },
        },
        error: null,
      });

      model(prisma, 'profile').findUnique.mockResolvedValue(null);

      const result = await service.login(loginDto);

      expect(result.accessToken).toBe('jwt-access-token');
      expect(result.profile).toBeUndefined();
    });

    it('should withhold the session and email an OTP when 2FA is enabled', async () => {
      signInMock.mockResolvedValue({
        data: {
          user: { id: mockUserId, email: loginDto.email },
          session: {
            access_token: 'jwt-access-token',
            refresh_token: 'jwt-refresh-token',
            expires_at: 1700000000,
          },
        },
        error: null,
      });

      model(prisma, 'profile').findUnique.mockResolvedValue({
        id: mockProfileId,
        church_id: mockChurchId,
        branch_id: 'branch-1',
        role: 'church_admin',
        first_name: 'Adebayo',
        last_name: 'Ogundimu',
        email: loginDto.email,
        two_factor_enabled: true,
        church: { name: 'Grace Community Church' },
      });

      const result = await service.login(loginDto);

      expect(result.requiresTwoFactor).toBe(true);
      expect(result.accessToken).toBeUndefined();
      expect(result.refreshToken).toBeUndefined();
      expect(resend.sendEmail).toHaveBeenCalledWith(
        loginDto.email,
        expect.stringContaining('sign-in code'),
        expect.stringContaining('ACCOUNT SECURITY'),
        '',
        undefined,
        expect.objectContaining({ text: expect.stringMatching(/Sign-in code: \d{6}/) }),
      );
      expect(redis.set).toHaveBeenCalledWith(
        expect.stringContaining('2fa:login:pending:'),
        expect.stringContaining('jwt-access-token'),
        600,
      );
    });

    it('should fail closed when Redis is unavailable during 2FA staging', async () => {
      signInMock.mockResolvedValue({
        data: {
          user: { id: mockUserId, email: loginDto.email },
          session: {
            access_token: 'jwt-access-token',
            refresh_token: 'jwt-refresh-token',
            expires_at: 1700000000,
          },
        },
        error: null,
      });
      model(prisma, 'profile').findUnique.mockResolvedValue({
        id: mockProfileId,
        church_id: mockChurchId,
        branch_id: 'branch-1',
        role: 'church_admin',
        first_name: 'Adebayo',
        last_name: 'Ogundimu',
        email: loginDto.email,
        two_factor_enabled: true,
        church: { name: 'Grace Community Church' },
      });
      redis.set.mockRejectedValue(new Error('connection refused'));

      await expect(service.login(loginDto)).rejects.toThrow(ServiceUnavailableException);
      expect(resend.sendEmail).not.toHaveBeenCalled();
    });

    it('should fail closed when the 2FA OTP email cannot be sent (clear pending + throw)', async () => {
      signInMock.mockResolvedValue({
        data: {
          user: { id: mockUserId, email: loginDto.email },
          session: {
            access_token: 'jwt-access-token',
            refresh_token: 'jwt-refresh-token',
            expires_at: 1700000000,
          },
        },
        error: null,
      });
      model(prisma, 'profile').findUnique.mockResolvedValue({
        id: mockProfileId,
        church_id: mockChurchId,
        branch_id: 'branch-1',
        role: 'church_admin',
        first_name: 'Adebayo',
        last_name: 'Ogundimu',
        email: loginDto.email,
        two_factor_enabled: true,
        church: { name: 'Grace Community Church' },
      });
      resend.sendEmail.mockRejectedValue(new Error('SMTP unavailable'));

      await expect(service.login(loginDto)).rejects.toThrow(ServiceUnavailableException);

      expect(redis.del).toHaveBeenCalledWith(`2fa:login:pending:${mockUserId}`);
      expect(redis.set).toHaveBeenCalled();
    });
  });

  // ─── TWO-FACTOR SIGN-IN ───────────────────────────────────────────

  describe('completeTwoFactorLogin', () => {
    it('requires authenticator enrollment after valid legacy email verification', async () => {
      const digest = hashTwoFactorCode('123456');
      model(prisma, 'profile').findFirst.mockResolvedValue({
        id: mockProfileId,
        user_id: mockUserId,
        church_id: mockChurchId,
      });
      redis.get.mockResolvedValue(
        JSON.stringify({
          session: {
            accessToken: 'jwt-access-token',
            refreshToken: 'jwt-refresh-token',
            expiresAt: 1700000000,
          },
          user: {
            userId: mockUserId,
            email: 'pastor@gracecommunity.com',
            profile: { profileId: mockProfileId, churchId: mockChurchId },
          },
          expiresAt: Date.now() + 600000,
          digest,
          attempts: 0,
        }),
      );

      const result = await service.completeTwoFactorLogin({
        email: 'pastor@gracecommunity.com',
        code: '123456',
      });

      expect(result.accessToken).toBeUndefined();
      expect(result.requiresTwoFactor).toBe(true);
      expect(result.authenticatorSetup?.factorId).toBe('factor-1');
      expect(result.userId).toBe(mockUserId);
      expect(redis.consume).toHaveBeenCalledWith(`2fa:login:pending:${mockUserId}`);
    });

    it('should throw UnauthorizedException when the OTP is wrong', async () => {
      const digest = hashTwoFactorCode('123456');
      model(prisma, 'profile').findFirst.mockResolvedValue({
        id: mockProfileId,
        user_id: mockUserId,
        church_id: mockChurchId,
      });
      redis.get.mockResolvedValue(
        JSON.stringify({
          session: { accessToken: 'jwt-access-token' },
          user: { userId: mockUserId, email: 'pastor@gracecommunity.com' },
          digest,
          attempts: 0,
        }),
      );

      await expect(
        service.completeTwoFactorLogin({
          email: 'pastor@gracecommunity.com',
          code: '999999',
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException when there is no pending sign-in', async () => {
      model(prisma, 'profile').findFirst.mockResolvedValue({
        id: mockProfileId,
        user_id: mockUserId,
        church_id: mockChurchId,
      });
      redis.get.mockResolvedValue(null);

      await expect(
        service.completeTwoFactorLogin({
          email: 'pastor@gracecommunity.com',
          code: '123456',
        }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  // ─── LOGOUT ────────────────────────────────────────────────────────

  describe('logout', () => {
    it('should blacklist token, revoke Supabase sessions, and audit-log the logout', async () => {
      await service.logout(mockUserId, 'jwt-token', mockChurchId);

      expect(redis.set).toHaveBeenCalledWith('auth:blacklist:jwt-token', mockUserId, 3600);
      expect(signOutMock).toHaveBeenCalledWith('jwt-token');

      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: mockUserId,
          churchId: mockChurchId,
          entity: 'auth',
          action: 'LOGOUT',
        }),
      );
    });
  });

  // ─── FORGOT PASSWORD ───────────────────────────────────────────────

  describe('forgotPassword', () => {
    it('sends recovery through the shared company sender', async () => {
      await service.forgotPassword('pastor@gracecommunity.com');
      expect(accountEmails.sendPasswordReset).toHaveBeenCalledWith('pastor@gracecommunity.com');
    });
    it('keeps the public response uniform when delivery fails', async () => {
      accountEmails.sendPasswordReset.mockRejectedValue(new Error('provider failure'));
      await expect(service.forgotPassword('unknown@email.com')).resolves.toBeUndefined();
    });
  });

  // ─── RESET PASSWORD ────────────────────────────────────────────────

  describe('acceptInvitation', () => {
    beforeEach(() => {
      getUserByIdMock.mockResolvedValue({
        data: { user: { id: mockUserId }, session: { access_token: 'invite-session' } },
        error: null,
      });
      model(prisma, 'profile').findUnique.mockResolvedValue({
        status: 'active',
        archived_at: null,
        role: ['church_admin'],
      });
      updateUserMock.mockResolvedValue({ error: null });
    });
    it('verifies an invitation, sets the password and revokes its session', async () => {
      await service.acceptInvitation('invite-token', 'NewPassword123!');
      expect(getUserByIdMock).toHaveBeenCalledWith({ token_hash: 'invite-token', type: 'invite' });
      expect(updateUserMock).toHaveBeenCalledWith({ password: 'NewPassword123!' });
      expect(signOutMock).toHaveBeenCalledWith('invite-session', 'global');
    });
    it('rejects an expired token before updating any password', async () => {
      getUserByIdMock.mockResolvedValue({ data: {}, error: { message: 'expired' } });
      await expect(service.acceptInvitation('old', 'NewPassword123!')).rejects.toThrow('expired');
      expect(updateUserMock).not.toHaveBeenCalled();
    });
    it.each([
      null,
      { status: 'inactive', role: ['church_admin'] },
      { status: 'active', archived_at: new Date(), role: ['church_admin'] },
      { status: 'active', role: ['member'] },
    ])('rejects unavailable staff profiles %j', async (profile) => {
      model(prisma, 'profile').findUnique.mockResolvedValue(profile);
      await expect(service.acceptInvitation('invite-token', 'NewPassword123!')).rejects.toThrow(
        'no longer available',
      );
      expect(updateUserMock).not.toHaveBeenCalled();
    });
  });

  describe('resetPassword', () => {
    it('should update password successfully', async () => {
      getUserByIdMock.mockResolvedValue({
        data: { user: { id: mockUserId }, session: { access_token: 'recovery-session' } },
        error: null,
      });
      updateUserMock.mockResolvedValue({ error: null });

      await expect(
        service.resetPassword('recovery-token', 'NewPassword123!'),
      ).resolves.toBeUndefined();

      expect(updateUserMock).toHaveBeenCalledWith({ password: 'NewPassword123!' });
    });

    it('should throw BadRequestException if token is invalid', async () => {
      getUserByIdMock.mockResolvedValue({
        data: { user: null, session: null },
        error: { message: 'Expired' },
      });
      updateUserMock.mockResolvedValue({
        error: { message: 'Token expired', status: 401 },
      });

      await expect(service.resetPassword('expired-token', 'NewPassword123!')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ─── CHANGE PASSWORD ───────────────────────────────────────────────

  describe('changePassword', () => {
    it('should change password successfully', async () => {
      getUserByIdMock.mockResolvedValue({
        data: { user: { id: mockUserId, email: 'pastor@church.com' } },
        error: null,
      });
      signInMock.mockResolvedValue({
        data: { session: { access_token: 'verified-password-token' } },
        error: null,
      });
      adminUpdateUserByIdMock.mockResolvedValue({ error: null });

      await expect(
        service.changePassword(mockUserId, 'OldPass123!', 'NewPass456!'),
      ).resolves.toBeUndefined();

      expect(getUserByIdMock).toHaveBeenCalledWith(mockUserId);
      expect(signInMock).toHaveBeenCalledWith({
        email: 'pastor@church.com',
        password: 'OldPass123!',
      });
      expect(adminUpdateUserByIdMock).toHaveBeenCalledWith(mockUserId, {
        password: 'NewPass456!',
      });
      expect(signOutMock).toHaveBeenCalledWith('verified-password-token', 'global');
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: mockUserId,
          entity: 'auth',
          action: 'UPDATE',
        }),
      );
    });

    it('should throw UnauthorizedException if current password is wrong', async () => {
      getUserByIdMock.mockResolvedValue({
        data: { user: { id: mockUserId, email: 'pastor@church.com' } },
        error: null,
      });
      signInMock.mockResolvedValue({
        error: { message: 'Invalid login credentials' },
      });

      await expect(service.changePassword(mockUserId, 'WrongPass', 'NewPass456!')).rejects.toThrow(
        UnauthorizedException,
      );
      expect(adminUpdateUserByIdMock).not.toHaveBeenCalled();
    });

    it('should throw InternalServerErrorException if the account email cannot be resolved', async () => {
      getUserByIdMock.mockResolvedValue({
        data: { user: { id: mockUserId, email: null } },
        error: null,
      });

      await expect(
        service.changePassword(mockUserId, 'OldPass123!', 'NewPass456!'),
      ).rejects.toThrow('Unable to verify your account');
      expect(signInMock).not.toHaveBeenCalled();
    });

    it('should throw InternalServerErrorException if password update fails', async () => {
      getUserByIdMock.mockResolvedValue({
        data: { user: { id: mockUserId, email: 'pastor@church.com' } },
        error: null,
      });
      signInMock.mockResolvedValue({
        data: { session: { access_token: 'verified-password-token' } },
        error: null,
      });
      adminUpdateUserByIdMock.mockResolvedValue({
        error: { message: 'Update failed' },
      });

      await expect(
        service.changePassword(mockUserId, 'OldPass123!', 'NewPass456!'),
      ).rejects.toThrow('Failed to update password');
    });
  });

  // ─── REFRESH SESSION ───────────────────────────────────────────────

  describe('refreshSession', () => {
    it('should refresh session successfully', async () => {
      refreshSessionMock.mockResolvedValue({
        data: {
          session: {
            access_token: 'new-access-token',
            refresh_token: 'new-refresh-token',
            expires_at: 1700003600,
          },
        },
        error: null,
      });

      const result = await service.refreshSession('old-refresh-token');

      expect(result.accessToken).toBe('new-access-token');
      expect(result.refreshToken).toBe('new-refresh-token');
      expect(result.expiresAt).toBe(1700003600);
      expect(refreshSessionMock).toHaveBeenCalledWith({
        refresh_token: 'old-refresh-token',
      });
    });

    it('should throw UnauthorizedException if refresh fails', async () => {
      refreshSessionMock.mockResolvedValue({
        data: { session: null },
        error: { message: 'Token expired', status: 401 },
      });

      await expect(service.refreshSession('expired-token')).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException if no session returned', async () => {
      refreshSessionMock.mockResolvedValue({
        data: { session: null },
        error: null,
      });

      await expect(service.refreshSession('token')).rejects.toThrow(UnauthorizedException);
    });
  });
});
