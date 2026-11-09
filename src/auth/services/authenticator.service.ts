import { LEGACY_BRAND } from '../../brand/brand';
import {
  Injectable,
  BadRequestException,
  UnauthorizedException,
  ServiceUnavailableException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { TOTP, Secret } from 'otpauth';
import { toDataURL } from 'qrcode';
import { JWTPayload } from 'jose';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { JwksService } from './jwks.service';

interface PendingSetup {
  userId: string;
  ciphertext: string;
  revision: string;
}

/** Backend-owned TOTP and session assurance. Secrets never enter profile DTOs. */
@Injectable()
export class AuthenticatorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly jwks: JwksService,
  ) {}

  private key(): Buffer {
    const value = this.config.get<string>('TWO_FACTOR_ENCRYPTION_KEY');
    if (!value || !/^[a-f\d]{64}$/i.test(value))
      throw new ServiceUnavailableException(
        'Authenticator security is not configured. Contact your administrator.',
      );
    return Buffer.from(value, 'hex');
  }

  private encrypt(userId: string, secret: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    cipher.setAAD(Buffer.from(`${LEGACY_BRAND.totpDomain}${userId}`));
    const content = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return [
      'v1',
      iv.toString('hex'),
      cipher.getAuthTag().toString('hex'),
      content.toString('hex'),
    ].join(':');
  }

  private decrypt(userId: string, value: string): string {
    const [version, iv, tag, content] = value.split(':');
    if (version !== 'v1' || !iv || !tag || !content)
      throw new ServiceUnavailableException('Authenticator data is unavailable.');
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key(), Buffer.from(iv, 'hex'));
      decipher.setAAD(Buffer.from(`${LEGACY_BRAND.totpDomain}${userId}`));
      decipher.setAuthTag(Buffer.from(tag, 'hex'));
      return Buffer.concat([
        decipher.update(Buffer.from(content, 'hex')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new ServiceUnavailableException(
        'Unable to decrypt authenticator data. Contact your administrator.',
      );
    }
  }

  private otp(secret: string, label = 'Account') {
    return new TOTP({
      issuer: 'BelivrHQ',
      label,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret,
    });
  }

  private matchedStep(secret: string, code: string): bigint {
    if (!/^\d{6}$/.test(code))
      throw new BadRequestException('Enter the current six-digit authenticator code.');
    const timestamp = Date.now();
    const delta = this.otp(secret).validate({ token: code, window: 1, timestamp });
    if (delta === null)
      throw new BadRequestException(
        'Invalid authenticator code. Check your device time and try the next code.',
      );
    return BigInt(Math.floor(timestamp / 30000) + delta);
  }

  private recoveryHash(userId: string, revision: string, code: string) {
    return createHash('sha256')
      .update(
        `${LEGACY_BRAND.recoveryDomain}${userId}:${revision}:${code.replace(/-/g, '').toUpperCase()}`,
      )
      .digest('hex');
  }

  async attempt(userId: string) {
    // All challenges share an account budget, so requesting new ones cannot reset it.
    const bucket = Math.floor(Date.now() / 300000);
    const count = await this.redis.incr(`mfa:budget:${userId}:${bucket}`, 600);
    if (count > 10)
      throw new HttpException(
        'Too many verification attempts. Try again in five minutes.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
  }

  async setup(userId: string, email: string) {
    this.key();
    if (await this.prisma.profileAuthenticator.findUnique({ where: { user_id: userId } }))
      throw new BadRequestException('Authenticator is already enabled.');
    const secret = new Secret({ size: 20 }).base32;
    const factorId = randomUUID();
    const uri = this.otp(secret, email).toString();
    const qrCode = await toDataURL(uri, { errorCorrectionLevel: 'M', width: 256, margin: 2 });
    await this.redis.set(
      `mfa:setup:${factorId}`,
      { userId, ciphertext: this.encrypt(userId, secret), revision: randomUUID() },
      600,
    );
    return { factorId, qrCode, secret, uri };
  }

  async activate(userId: string, token: string, factorId: string, code: string) {
    await this.attempt(userId);
    const raw = await this.redis.get<PendingSetup>(`mfa:setup:${factorId}`);
    const pending = typeof raw === 'string' ? (JSON.parse(raw) as PendingSetup) : raw;
    if (!pending || pending.userId !== userId)
      throw new BadRequestException('Authenticator setup expired. Start again.');
    const step = this.matchedStep(this.decrypt(userId, pending.ciphertext), code);
    const sessionId = await this.sessionId(userId, token);
    if (!(await this.redis.consume(`mfa:setup:${factorId}`)))
      throw new BadRequestException('Setup was already used.');
    const recoveryCodes = Array.from({ length: 10 }, () =>
      randomBytes(16).toString('hex').toUpperCase().match(/.{8}/g)!.join('-'),
    );
    await this.prisma.$transaction(async (tx) => {
      // Create, rather than upsert: concurrent enrollments may never replace an active secret.
      await tx.profileAuthenticator.create({
        data: {
          user_id: userId,
          secret_ciphertext: pending.ciphertext,
          revision: pending.revision,
          last_used_step: step,
          recovery_hashes: recoveryCodes.map((code) =>
            this.recoveryHash(userId, pending.revision, code),
          ),
        },
      });
      await tx.profile.update({
        where: { user_id: userId },
        data: { two_factor_enabled: true, mfa_enabled: true },
      });
      await tx.verifiedMfaSession.deleteMany({ where: { user_id: userId } });
      await tx.verifiedMfaSession.create({
        data: {
          user_id: userId,
          session_id: sessionId,
          revision: pending.revision,
          expires_at: new Date(Date.now() + 12 * 3600000),
        },
      });
    });
    return { recoveryCodes };
  }

  async verify(userId: string, code: string) {
    await this.attempt(userId);
    const state = await this.prisma.profileAuthenticator.findUnique({ where: { user_id: userId } });
    if (!state) throw new BadRequestException('Authenticator is not configured.');
    let count: number;
    if (/^\d{6}$/.test(code)) {
      const step = this.matchedStep(this.decrypt(userId, state.secret_ciphertext), code);
      const changed = await this.prisma.profileAuthenticator.updateMany({
        where: { user_id: userId, revision: state.revision, last_used_step: { lt: step } },
        data: { last_used_step: step },
      });
      count = changed.count;
    } else {
      const digest = this.recoveryHash(userId, state.revision, code);
      const match = state.recovery_hashes.find((hash) =>
        timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(digest, 'hex')),
      );
      if (!match) throw new BadRequestException('Invalid or already used recovery code.');
      const changed = await this.prisma.profileAuthenticator.updateMany({
        where: {
          user_id: userId,
          revision: state.revision,
          recovery_hashes: { equals: state.recovery_hashes },
        },
        data: { recovery_hashes: state.recovery_hashes.filter((hash) => hash !== match) },
      });
      count = changed.count;
    }
    if (count !== 1)
      throw new BadRequestException(
        'Code already used. Wait for the next authenticator code or use another recovery code.',
      );
    return state.revision;
  }

  private async sessionId(userId: string, token: string) {
    const { payload } = await this.jwks.verifyToken(token);
    if (payload.sub !== userId || typeof payload.session_id !== 'string')
      throw new UnauthorizedException('Invalid sign-in session.');
    return payload.session_id;
  }

  async approve(userId: string, token: string, revision: string) {
    const sessionId = await this.sessionId(userId, token);
    if (revision === 'password-session') {
      const profile = await this.prisma.profile.findUnique({
        where: { user_id: userId },
        select: { two_factor_enabled: true, authenticator: { select: { revision: true } } },
      });
      // Password approval is only valid while no authenticator is configured.
      // Recheck after password verification so enrollment cannot bypass 2FA.
      if (!profile || profile.two_factor_enabled || profile.authenticator)
        throw new UnauthorizedException('Authenticator changed. Sign in again.');
    } else {
      const state = await this.prisma.profileAuthenticator.findUnique({
        where: { user_id: userId },
      });
      if (!state || state.revision !== revision)
        throw new UnauthorizedException('Authenticator changed. Sign in again.');
    }
    await this.prisma.verifiedMfaSession.upsert({
      where: { user_id_session_id: { user_id: userId, session_id: sessionId } },
      create: {
        user_id: userId,
        session_id: sessionId,
        revision,
        expires_at: new Date(Date.now() + 12 * 3600000),
      },
      update: { revision, expires_at: new Date(Date.now() + 12 * 3600000) },
    });
    await this.prisma.verifiedMfaSession.deleteMany({
      where: { user_id: userId, expires_at: { lt: new Date() } },
    });
  }

  async assertSession(
    payload: JWTPayload,
    hydrated?: {
      two_factor_enabled?: boolean;
      authenticator?: { revision: string } | null;
      status?: string;
      church?: { archived_at: Date | null };
    },
  ) {
    const profile =
      hydrated ??
      (await this.prisma.profile.findUnique({
        where: { user_id: payload.sub! },
        select: {
          status: true,
          church: { select: { archived_at: true } },
          two_factor_enabled: true,
          authenticator: { select: { revision: true } },
        },
      }));
    if (!hydrated && profile && (profile.status !== 'active' || profile.church?.archived_at))
      throw new UnauthorizedException('This session is no longer available');
    if (
      !profile ||
      (profile.two_factor_enabled && !profile.authenticator) ||
      typeof payload.session_id !== 'string'
    )
      throw new UnauthorizedException('Authenticator verification required. Sign in again.');
    const approved = await this.prisma.verifiedMfaSession.findUnique({
      where: { user_id_session_id: { user_id: payload.sub!, session_id: payload.session_id } },
    });
    if (
      !approved ||
      approved.revision !==
        (profile.two_factor_enabled ? profile.authenticator?.revision : 'password-session') ||
      approved.expires_at.getTime() <= Date.now()
    )
      throw new UnauthorizedException('Session no longer approved. Sign in again.');
  }

  async disable(userId: string, code: string) {
    const revision = await this.verify(userId, code);
    await this.prisma.$transaction(async (tx) => {
      const removed = await tx.profileAuthenticator.deleteMany({
        where: { user_id: userId, revision },
      });
      if (!removed.count)
        throw new BadRequestException('Authenticator settings changed. Try again.');
      await tx.verifiedMfaSession.deleteMany({ where: { user_id: userId } });
      await tx.profile.update({
        where: { user_id: userId },
        data: { two_factor_enabled: false, mfa_enabled: false },
      });
    });
  }

  async regenerateRecoveryCodes(userId: string, code: string) {
    const revision = await this.verify(userId, code);
    const state = await this.prisma.profileAuthenticator.findUnique({ where: { user_id: userId } });
    if (!state || state.revision !== revision)
      throw new BadRequestException('Authenticator settings changed. Try again.');
    const recoveryCodes = Array.from({ length: 10 }, () =>
      randomBytes(16).toString('hex').toUpperCase().match(/.{8}/g)!.join('-'),
    );
    const changed = await this.prisma.profileAuthenticator.updateMany({
      where: { user_id: userId, revision, recovery_hashes: { equals: state.recovery_hashes } },
      data: {
        recovery_hashes: recoveryCodes.map((code) => this.recoveryHash(userId, revision, code)),
      },
    });
    if (!changed.count) throw new BadRequestException('Recovery codes changed. Try again.');
    return { recoveryCodes };
  }

  async factors(userId: string) {
    const state = await this.prisma.profileAuthenticator.findUnique({
      where: { user_id: userId },
      select: { revision: true, recovery_hashes: true },
    });
    return state
      ? [
          {
            id: state.revision,
            name: 'Authenticator app',
            status: 'verified',
            recoveryCodesRemaining: state.recovery_hashes.length,
          },
        ]
      : [];
  }
}
