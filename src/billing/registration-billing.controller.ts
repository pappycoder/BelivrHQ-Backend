import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Post,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { readRegistrationCheckout } from '../auth/registration-checkout';
import { BillingService } from './billing.service';
import { CheckoutDto, VerifySubscriptionDto } from './billing.dto';
import { RateLimit } from '../common/guards/rate-limit.guard';

/** Tenant identity comes only from the signed signup capability. */
@Controller('billing/registration')
export class RegistrationBillingController {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
  ) {}
  private async identity(token: string) {
    const claims = readRegistrationCheckout(this.config, token);
    const profile = await this.prisma.profile.findUnique({
      where: { id: claims.profileId },
      include: { church: true },
    });
    if (
      !profile ||
      profile.user_id !== claims.userId ||
      profile.church_id !== claims.churchId ||
      !profile.role.includes('church_admin') ||
      profile.status !== 'active' ||
      profile.archived_at ||
      profile.church.archived_at
    )
      throw new UnauthorizedException('Registration checkout is unavailable.');
    return { churchId: claims.churchId, email: profile.email ?? profile.church.email ?? '' };
  }
  private async unpaid(token: string) {
    const identity = await this.identity(token);
    const paid = await this.prisma.subscriptionPayment.findFirst({
      where: { church_id: identity.churchId, status: 'success' },
    });
    if (paid)
      throw new ForbiddenException('Registration payment is complete. Sign in to manage billing.');
    return identity;
  }
  @Get('subscription')
  @RateLimit({ limit: 60, windowSeconds: 60 })
  async status(@Headers('x-belivrhq-registration-checkout') token: string) {
    const { churchId } = await this.identity(token);
    return { ...(await this.billing.status(churchId)), registrationChurchId: churchId };
  }
  @Post('quote')
  @RateLimit({ limit: 30, windowSeconds: 60 })
  async quote(
    @Headers('x-belivrhq-registration-checkout') token: string,
    @Body() dto: CheckoutDto,
  ) {
    const { churchId } = await this.unpaid(token);
    return this.billing.quote(churchId, dto);
  }
  @Post('checkout')
  @RateLimit({ limit: 5, windowSeconds: 60 })
  async checkout(
    @Headers('x-belivrhq-registration-checkout') token: string,
    @Body() dto: CheckoutDto,
  ) {
    const { churchId, email } = await this.unpaid(token);
    return this.billing.checkout(churchId, email, dto);
  }
  @Post('verify')
  @HttpCode(200)
  @RateLimit({ limit: 60, windowSeconds: 60 })
  async verify(
    @Headers('x-belivrhq-registration-checkout') token: string,
    @Body() dto: VerifySubscriptionDto,
  ) {
    const { churchId } = await this.identity(token);
    return {
      ...(await this.billing.verify(churchId, dto.reference)),
      registrationChurchId: churchId,
    };
  }
  @Post('checkout/close')
  @HttpCode(200)
  async close(
    @Headers('x-belivrhq-registration-checkout') token: string,
    @Body() dto: VerifySubscriptionDto,
  ) {
    const { churchId } = await this.unpaid(token);
    return {
      ...(await this.billing.closeCheckout(churchId, dto.reference)),
      registrationChurchId: churchId,
    };
  }
}
