import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomInt, createHash } from 'crypto';
import { RedisService } from '../redis/redis.service';
import { createChallenge, deriveKey, verifySolution, type Payload } from './altcha';

export const CHALLENGE_TTL_SECONDS = 20 * 60;

@Injectable()
export class BotProtectionService {
  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {}

  private secret(): string {
    const key = this.config.get<string>('ALTCHA_HMAC_KEY');
    if (!key || key.length < 32) throw this.unavailable();
    return key;
  }

  private unavailable() {
    return new ServiceUnavailableException({
      code: 'BOT_PROTECTION_UNAVAILABLE',
      message: 'Verification is temporarily unavailable. Please try again.',
    });
  }

  private invalid(): never {
    throw new BadRequestException({
      code: 'BOT_VERIFICATION_FAILED',
      message: 'Verification failed or expired. Please verify again and retry.',
    });
  }

  private scope(method: string, path: string, userId?: string): string {
    return createHash('sha256')
      .update(JSON.stringify([method, path, userId ?? null]))
      .digest('hex');
  }

  async challenge(method: string, path: string, userId?: string) {
    const challenge = await createChallenge({
      algorithm: 'SHA-256',
      cost: 1,
      counter: randomInt(1, 100001),
      deriveKey,
      hmacSignatureSecret: this.secret(),
      expiresAt: new Date(Date.now() + CHALLENGE_TTL_SECONDS * 1000),
      data: { scope: this.scope(method, path, userId) },
    });
    try {
      await this.redis.set(
        `bot:challenge:${challenge.signature}`,
        challenge,
        CHALLENGE_TTL_SECONDS,
      );
    } catch {
      throw this.unavailable();
    }
    return challenge;
  }

  async verify(
    method: string,
    path: string,
    body: Record<string, unknown>,
    userId?: string,
  ): Promise<void> {
    // Bound decoding before parsing or invoking cryptography. Never log supplied fields.
    if (
      body.website !== '' ||
      typeof body.altcha !== 'string' ||
      body.altcha.length > 8192 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(body.altcha)
    )
      this.invalid();
    let payload: Payload | null = null;
    try {
      payload = JSON.parse(
        Buffer.from(body.altcha as string, 'base64').toString('utf8'),
      ) as Payload;
    } catch {
      this.invalid();
    }
    if (!payload || typeof payload !== 'object') this.invalid();
    const challenge = payload.challenge;
    const solution = payload.solution;
    if (
      !challenge?.parameters ||
      typeof challenge.signature !== 'string' ||
      !/^[a-f0-9]{64}$/.test(challenge.signature) ||
      challenge.parameters.algorithm !== 'SHA-256' ||
      challenge.parameters.cost !== 1 ||
      challenge.parameters.data?.scope !== this.scope(method, path, userId) ||
      typeof challenge.parameters.expiresAt !== 'number' ||
      challenge.parameters.expiresAt <= Date.now() / 1000 ||
      !solution ||
      !Number.isInteger(solution.counter) ||
      solution.counter < 0 ||
      solution.counter > 100000 ||
      typeof solution.derivedKey !== 'string' ||
      !/^[a-f0-9]{64}$/.test(solution.derivedKey)
    )
      this.invalid();
    const secret = this.secret();
    let verified = false;
    try {
      verified = (
        await verifySolution({ challenge, solution, deriveKey, hmacSignatureSecret: secret })
      ).verified;
    } catch {
      this.invalid();
    }
    if (!verified) this.invalid();
    let issued: unknown;
    try {
      issued = await this.redis.consume(`bot:challenge:${challenge.signature}`);
    } catch {
      throw this.unavailable();
    }
    if (!issued) this.invalid();
  }
}
