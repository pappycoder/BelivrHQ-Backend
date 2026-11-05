import { Body, Controller, INestApplication, Post, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { BotProtectionService } from '../../../src/bot-protection/bot-protection.service';
import { BotProtectionController } from '../../../src/bot-protection/bot-protection.controller';
import { BotProtectionInterceptor } from '../../../src/bot-protection/bot-protection.interceptor';
import { JwtAuthGuard } from '../../../src/auth/guards/jwt-auth.guard';
import { RedisService } from '../../../src/redis/redis.service';
import { CreateFormSubmissionDto } from '../../../src/forms/dto/create-submission.dto';
import { ResponseInterceptor } from '../../../src/common/interceptors/response.interceptor';
import { GlobalExceptionFilter } from '../../../src/common/filters/global-exception.filter';
import { deriveKey, solveChallenge, type Challenge } from '../../../src/bot-protection/altcha';

const businessWrite = jest.fn();
@Controller('forms/public')
class SubmissionController {
  @Post(':publicToken/submit')
  submit(@Body() dto: CreateFormSubmissionDto) {
    businessWrite(dto);
    return { id: 'saved' };
  }
}

describe('HTTP bot protection pipeline (isolated, no database)', () => {
  let app: INestApplication;
  let base: string;
  const issued = new Map<string, unknown>();

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [BotProtectionController, SubmissionController],
      providers: [
        BotProtectionService,
        { provide: ConfigService, useValue: { get: () => 'http-test-secret-'.repeat(4) } },
        {
          provide: RedisService,
          useValue: {
            set: async (key: string, value: unknown) => {
              issued.set(key, value);
            },
            consume: async (key: string) => {
              const value = issued.get(key);
              issued.delete(key);
              return value ?? null;
            },
          },
        },
        { provide: APP_INTERCEPTOR, useClass: BotProtectionInterceptor },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => false })
      .compile();
    app = module.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new GlobalExceptionFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(() => {
    businessWrite.mockClear();
  });

  async function proof(path = '/forms/public/token-a/submit') {
    const response = await fetch(
      `${base}/api/v1/bot-protection/challenge?${new URLSearchParams({ method: 'POST', path })}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const challenge = (await response.json()) as Challenge;
    // The widget requires the raw protocol, without the normal success/data envelope.
    expect(challenge.parameters.algorithm).toBe('SHA-256');
    const solution = await solveChallenge({ challenge, deriveKey });
    return {
      altcha: Buffer.from(JSON.stringify({ challenge, solution })).toString('base64'),
      website: '',
    };
  }

  const post = (path: string, body: unknown) =>
    fetch(`${base}/api/v1${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('accepts one real proof and rejects its replay before any further business write', async () => {
    const fields = await proof();
    const body = { data: { website: 'Legitimate answer' }, ...fields };
    const accepted = await post('/forms/public/token-a/submit', body);
    expect(accepted.status).toBe(201);
    expect(businessWrite).toHaveBeenCalledWith(
      expect.objectContaining({ data: { website: 'Legitimate answer' } }),
    );
    expect(businessWrite.mock.calls[0][0]).not.toHaveProperty('altcha');
    expect(businessWrite.mock.calls[0][0]).not.toHaveProperty('website');
    const replay = await post('/forms/public/token-a/submit', body);
    expect(replay.status).toBe(400);
    expect((await replay.json()).error.code).toBe('BOT_VERIFICATION_FAILED');
    expect(businessWrite).toHaveBeenCalledTimes(1);
  });

  it('cannot bypass checks with encoded parameters or different route casing', async () => {
    for (const path of ['/forms/public/%74oken-a/submit', '/FORMS/PUBLIC/token-a/SUBMIT/']) {
      const response = await post(path, { data: { name: 'Spam' } });
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe('BOT_VERIFICATION_FAILED');
    }
    expect(businessWrite).not.toHaveBeenCalled();
  });

  it('retains strict business DTO validation and never accepts a filled honeypot', async () => {
    const invalidDto = await post('/forms/public/token-a/submit', {
      data: {},
      unexpected: true,
      ...(await proof()),
    });
    expect(invalidDto.status).toBe(400);
    const spam = await post('/forms/public/token-a/submit', {
      data: {},
      ...(await proof()),
      website: 'spam',
    });
    expect(spam.status).toBe(400);
    expect(businessWrite).not.toHaveBeenCalled();
  });

  it('requires authentication for private challenges and rejects private actions on the public issuer', async () => {
    expect(
      (
        await fetch(
          `${base}/api/v1/bot-protection/authenticated-challenge?method=POST&path=%2Fprofiles%2Finvite`,
        )
      ).status,
    ).toBe(403);
    expect(
      (await fetch(`${base}/api/v1/bot-protection/challenge?method=POST&path=%2Fprofiles%2Finvite`))
        .status,
    ).toBe(400);
  });
});
