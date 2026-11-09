import { SUBSCRIPTION_REFERENCE, QUOTE_REFERENCE } from '../brand/brand';
import { BillingCycle, SubscriptionGateway, SubscriptionPlan } from '@prisma/client';
import { IsEnum, IsIn, IsString, MaxLength, Matches, IsOptional, MinLength } from 'class-validator';
import { PRICING_CURRENCIES } from './subscription-pricing.service';
export class CheckoutDto {
  @IsOptional() @IsIn(PRICING_CURRENCIES) currency?: string;
  @IsOptional() @Matches(QUOTE_REFERENCE) quoteId?: string;
  @IsIn([SubscriptionPlan.essentials, SubscriptionPlan.community, SubscriptionPlan.network])
  plan!: Exclude<SubscriptionPlan, 'enterprise'>;
  @IsEnum(BillingCycle)
  cycle!: BillingCycle;
  @IsIn([SubscriptionGateway.flutterwave])
  gateway!: SubscriptionGateway;
}
export class VerifySubscriptionDto {
  @IsString()
  @MaxLength(100)
  @Matches(SUBSCRIPTION_REFERENCE)
  reference!: string;
}

export class SchedulePlanDto {
  @IsOptional() @IsIn(['essentials', 'community', 'network']) plan?:
    'essentials' | 'community' | 'network';
  @IsOptional() @IsEnum(BillingCycle) cycle?: BillingCycle;
}

export class ReviewSubscriptionPaymentDto extends VerifySubscriptionDto {
  @IsIn(['release', 'revoke']) decision!: 'release' | 'revoke';
  @IsString() @MinLength(10) @MaxLength(500) reason!: string;
}
