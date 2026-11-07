import {
  BadRequestException,
  ExecutionContext,
  ServiceUnavailableException,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { lastValueFrom, of } from 'rxjs';
import { BotProtectionService } from '../../../src/bot-protection/bot-protection.service';
import { BotProtectionInterceptor } from '../../../src/bot-protection/bot-protection.interceptor';
import { BotProtectionController } from '../../../src/bot-protection/bot-protection.controller';
import { protectedAction } from '../../../src/bot-protection/protected-actions';
import { deriveKey, solveChallenge, type Challenge } from '../../../src/bot-protection/altcha';
import { CreateFormSubmissionDto } from '../../../src/forms/dto/create-submission.dto';
import { RedisService } from '../../../src/redis/redis.service';

const secret = 'test-only-altcha-key-'.repeat(3);
const publicPath = '/forms/public/token-a/submit';
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');

describe('bot protection with real signed ALTCHA proofs', () => {
  it('protects intake submission without exposing review endpoints', () => {
    expect(protectedAction('POST', '/intake/public/token-a/submit')).toEqual({
      authenticated: false,
    });
    expect(protectedAction('GET', '/intake/public/token-a/submit')).toBeNull();
    expect(protectedAction('POST', '/intake/submissions/id/accept')).toBeNull();
  });
  let bots: BotProtectionService;
  let issued: Map<string, unknown>;
  let redis: { set: jest.Mock; consume: jest.Mock };

  beforeEach(() => {
    issued = new Map();
    redis = {
      set: jest.fn(async (key: string, value: unknown) => {
        issued.set(key, value);
      }),
      consume: jest.fn(async (key: string) => {
        const value = issued.get(key);
        issued.delete(key);
        return value ?? null;
      }),
    };
    bots = new BotProtectionService(
      { get: () => secret } as unknown as ConfigService,
      redis as unknown as RedisService,
    );
  });

  async function solved(method = 'POST', path = publicPath, userId?: string) {
    const challenge = await bots.challenge(method, path, userId);
    const solution = await solveChallenge({ challenge, deriveKey });
    expect(solution).not.toBeNull();
    return { challenge, solution };
  }

  it('accepts a signed proof exactly once, even with simultaneous requests', async () => {
    const payload = await solved();
    const body = { altcha: encode(payload), website: '' };
    const results = await Promise.allSettled([
      bots.verify('POST', publicPath, body),
      bots.verify('POST', publicPath, body),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('binds proofs to action, form token, and user without consuming a mismatched proof', async () => {
    const body = {
      altcha: encode(await solved('POST', '/profiles/invite', 'user-a')),
      website: '',
    };
    await expect(bots.verify('POST', '/church/invite', body, 'user-a')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(bots.verify('POST', '/profiles/invite', body, 'user-b')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(redis.consume).not.toHaveBeenCalled();
    await expect(bots.verify('POST', '/profiles/invite', body, 'user-a')).resolves.toBeUndefined();
    const publicBody = { altcha: encode(await solved()), website: '' };
    await expect(
      bots.verify('POST', '/forms/public/token-b/submit', publicBody),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([undefined, null, {}, [], '!', 'e30=', 'bnVsbA==', 'a'.repeat(8193)])(
    'rejects missing or malformed proofs (%#)',
    async (altcha) => {
      await expect(bots.verify('POST', publicPath, { altcha, website: '' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(redis.consume).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, null, 'https://spam.test', [''], {}])(
    'rejects a nonempty or invalid honeypot %p',
    async (website) => {
      const payload = await solved();
      await expect(
        bots.verify('POST', publicPath, { altcha: encode(payload), website }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(redis.consume).not.toHaveBeenCalled();
    },
  );

  it('rejects tampered signatures, parameters and incorrect solutions', async () => {
    const payload = await solved();
    for (const changed of [
      { ...payload, challenge: { ...payload.challenge, signature: '0'.repeat(64) } },
      {
        ...payload,
        challenge: {
          ...payload.challenge,
          parameters: { ...payload.challenge.parameters, nonce: '0'.repeat(32) },
        },
      },
      { ...payload, solution: { ...payload.solution, derivedKey: '0'.repeat(64) } },
    ])
      await expect(
        bots.verify('POST', publicPath, { altcha: encode(changed), website: '' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    expect(redis.consume).not.toHaveBeenCalled();
  });

  it('rejects expired challenges and valid proofs absent from the shared store', async () => {
    const payload = await solved();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 1201000);
    await expect(
      bots.verify('POST', publicPath, { altcha: encode(payload), website: '' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    clock.mockRestore();
    issued.clear();
    await expect(
      bots.verify('POST', publicPath, { altcha: encode(payload), website: '' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('fails closed on store outages and missing secrets', async () => {
    const payload = await solved();
    redis.consume.mockRejectedValueOnce(new Error('offline'));
    await expect(
      bots.verify('POST', publicPath, { altcha: encode(payload), website: '' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    redis.set.mockRejectedValueOnce(new Error('offline'));
    await expect(bots.challenge('POST', publicPath)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    const missing = new BotProtectionService(
      { get: () => '' } as unknown as ConfigService,
      redis as unknown as RedisService,
    );
    await expect(missing.challenge('POST', publicPath)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('strips only protection fields before strict DTO validation; rejection never calls business code', async () => {
    const interceptor = new BotProtectionInterceptor(bots);
    const body = { data: { name: 'Grace' }, altcha: encode(await solved()), website: '' };
    const request = { method: 'POST', path: `/api/v1${publicPath}`, body };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    const business = { handle: jest.fn(() => of('saved')) };
    expect(await lastValueFrom(await interceptor.intercept(context, business))).toBe('saved');
    expect(request.body).toEqual({ data: { name: 'Grace' } });
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });
    await expect(
      pipe.transform(request.body, { type: 'body', metatype: CreateFormSubmissionDto }),
    ).resolves.toBeInstanceOf(CreateFormSubmissionDto);
    await expect(
      pipe.transform(
        { ...request.body, unexpected: true },
        { type: 'body', metatype: CreateFormSubmissionDto },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    business.handle.mockClear();
    await expect(interceptor.intercept(context, business)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(business.handle).not.toHaveBeenCalled();
  });

  it('enforces encoded parameter and case-insensitive routes', async () => {
    const interceptor = new BotProtectionInterceptor(bots);
    for (const path of [
      '/api/v1/forms/public/%74oken-a/submit',
      '/API/V1/AUTH/LOGIN/',
      '/api/v1/PROFILES/invite',
      '/api/v1/profiles/%75ser/reset-password',
    ]) {
      const request = { method: 'POST', path, body: {} };
      const context = {
        switchToHttp: () => ({ getRequest: () => request }),
      } as unknown as ExecutionContext;
      const business = { handle: jest.fn(() => of('saved')) };
      await expect(interceptor.intercept(context, business)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(business.handle).not.toHaveBeenCalled();
    }
  });

  it('does not expose authenticated actions through the public challenge endpoint', async () => {
    const controller = new BotProtectionController(bots);
    expect(() => controller.challenge('POST', '/profiles/invite')).toThrow(BadRequestException);
    expect(() => controller.challenge('POST', '/unknown')).toThrow(BadRequestException);
    const challenge = (await controller.challenge('POST', publicPath)) as Challenge;
    expect(challenge.signature).toBeDefined();
  });

  it.each([
    ['POST', '/auth/register'],
    ['POST', '/auth/login'],
    ['POST', '/auth/login/2fa'],
    ['POST', '/auth/forgot-password'],
    ['PATCH', '/auth/reset-password'],
    ['POST', '/auth/accept-invitation'],
    ['POST', publicPath],
    ['PUT', '/auth/password'],
    ['POST', '/profiles/invite'],
    ['POST', '/church/invite'],
    ['POST', '/profiles/user-a/reset-password'],
    ['POST', '/broadcasts'],
  ])('protects %s %s', (method, path) => expect(protectedAction(method, path)).not.toBeNull());

  it.each([
    ['POST', '/auth/refresh'],
    ['POST', '/giving/webhook/paystack'],
    ['GET', '/forms/public/token-a/meta'],
    ['PATCH', '/members/user-a'],
    ['GET', '/health'],
  ])('leaves %s %s to existing controls', (method, path) =>
    expect(protectedAction(method, path)).toBeNull(),
  );
});
