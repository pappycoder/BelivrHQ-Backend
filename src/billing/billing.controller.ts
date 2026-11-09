import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  RawBodyRequest,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { AuthenticatedRequest } from '../common/decorators/current-user.decorator';
import { BillingService } from './billing.service';
import {
  CheckoutDto,
  VerifySubscriptionDto,
  SchedulePlanDto,
  ReviewSubscriptionPaymentDto,
} from './billing.dto';
import { BillingAdminGuard } from './plan-feature.guard';
import { RateLimit } from '../common/guards/rate-limit.guard';
@Controller('billing')
@UseGuards(JwtAuthGuard, BillingAdminGuard)
export class BillingController {
  constructor(private readonly billing: BillingService) {}
  @Get('subscription')
  @RequirePermissions('billing:read')
  status(@Req() req: AuthenticatedRequest) {
    return this.billing.status(req.profile!.church_id);
  }
  @Post('quote')
  @RequirePermissions('billing:read')
  quote(@Req() req: AuthenticatedRequest, @Body() dto: CheckoutDto) {
    return this.billing.quote(req.profile!.church_id, dto);
  }
  @Post('schedule')
  @RequirePermissions('billing:update')
  schedule(@Req() req: AuthenticatedRequest, @Body() dto: SchedulePlanDto) {
    return this.billing.schedule(req.profile!.church_id, dto.plan ?? null, dto.cycle);
  }
  @Post('checkout')
  @RequirePermissions('billing:update')
  @RateLimit({ limit: 5, windowSeconds: 60 })
  checkout(@Req() req: AuthenticatedRequest, @Body() dto: CheckoutDto) {
    return this.billing.checkout(req.profile!.church_id, req.user.email!, dto);
  }
  @Post('payment-review')
  @HttpCode(200)
  @RequirePermissions('billing:update')
  review(@Req() req: AuthenticatedRequest, @Body() dto: ReviewSubscriptionPaymentDto) {
    return this.billing.reviewPayment(
      req.profile!.church_id,
      { id: req.profile!.id, roles: req.profile!.roles ?? [req.profile!.role] },
      dto.reference,
      dto.decision,
      dto.reason,
    );
  }
  @Post('checkout/close')
  @HttpCode(200)
  @RequirePermissions('billing:update')
  closeCheckout(@Req() req: AuthenticatedRequest, @Body() dto: VerifySubscriptionDto) {
    return this.billing.closeCheckout(req.profile!.church_id, dto.reference);
  }
  @Post('verify')
  @HttpCode(200)
  @RequirePermissions('billing:update')
  verify(@Req() req: AuthenticatedRequest, @Body() dto: VerifySubscriptionDto) {
    return this.billing.verify(req.profile!.church_id, dto.reference);
  }
}
@Controller('billing/webhooks')
export class BillingWebhookController {
  constructor(private readonly billing: BillingService) {}
  @Post(':gateway')
  @RateLimit({ limit: 500, windowSeconds: 60 })
  @HttpCode(200)
  webhook(
    @Param('gateway') gateway: string,
    @Req() req: RawBodyRequest<Request>,
    @Headers() headers: Record<string, string>,
    @Headers('flutterwave-signature') flutterwave: string,
    @Headers('verif-hash') verificationHash: string,
  ) {
    return this.billing.webhook(
      gateway,
      req.rawBody?.toString('utf8') ?? '',
      gateway === 'paystack'
        ? (headers['paystack-signature'] ?? headers['x-paystack-signature'] ?? '')
        : flutterwave || verificationHash,
    );
  }
}

@Controller('pricing')
export class SubscriptionPricingController {
  constructor(private readonly billing: BillingService) {}
  @Get('subscriptions')
  @RateLimit({ limit: 60, windowSeconds: 60 })
  catalog(@Query('currency') currency = 'USD') {
    return this.billing.pricingCatalog(currency);
  }
}
