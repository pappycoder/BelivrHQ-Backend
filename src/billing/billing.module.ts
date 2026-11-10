import { RegistrationBillingController } from './registration-billing.controller';
import { GivingModule } from '../giving/giving.module';
import { CompanyEmailModule } from '../company-email/company-email.module';
import { SubscriptionPricingService } from './subscription-pricing.service';
import { PaymentReconciliationService } from './payment-reconciliation.service';
import { Module } from '@nestjs/common';
import { BillingAdminGuard } from './plan-feature.guard';
import { AuthModule } from '../auth/auth.module';
import {
  BillingController,
  BillingWebhookController,
  SubscriptionPricingController,
} from './billing.controller';
import { BillingService } from './billing.service';
import { PaystackService } from '../giving/services/paystack.service';
import { FlutterwaveService } from '../giving/services/flutterwave.service';
@Module({
  imports: [AuthModule, CompanyEmailModule, GivingModule],
  controllers: [
    RegistrationBillingController,
    BillingController,
    BillingWebhookController,
    SubscriptionPricingController,
  ],
  providers: [
    SubscriptionPricingService,
    PaymentReconciliationService,
    BillingAdminGuard,
    BillingService,
    PaystackService,
    FlutterwaveService,
  ],
})
export class BillingModule {}
