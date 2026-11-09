import {
  adjustmentFingerprint,
  applyAdjustment,
  record,
} from '../giving/services/payment-lifecycle';
import {
  accessGrants,
  appendAccessGrant,
  resolvePaymentAccess,
  projectSubscription,
} from './payment-access';
import type { PaymentAdjustment } from '../giving/services/payment-lifecycle';
import { CompanyEmailService } from '../company-email/company-email.service';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { PaystackService } from '../giving/services/paystack.service';
import { FlutterwaveService } from '../giving/services/flutterwave.service';
import { PaymentVerificationPendingException } from '../giving/services/payment-verification-pending.exception';
import {
  PaymentGatewayProvider,
  type PaymentVerifyResult,
} from '../giving/services/payment-gateway.interface';
import { CheckoutDto } from './billing.dto';
import { trustedFlutterwaveCheckout } from './checkout-url';
import {
  SUBSCRIPTION_PLANS,
  subscriptionEnd,
  BillingCycle,
  PLAN_RANK,
  PLAN_CAPACITIES,
} from './plans';
import { churchEntitlements } from './entitlements';
import { Prisma, SubscriptionPlan } from '@prisma/client';
import {
  SubscriptionPricingService,
  convertedPrice,
  LockedQuote,
} from './subscription-pricing.service';

@Injectable()
export class BillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly paystack: PaystackService,
    private readonly flutterwave: FlutterwaveService,
    private readonly pricing: SubscriptionPricingService,
    private readonly companyEmails: CompanyEmailService,
  ) {}

  private gateway(name: string): PaymentGatewayProvider {
    const gateway =
      name === 'paystack' ? this.paystack : name === 'flutterwave' ? this.flutterwave : null;
    if (!gateway?.isConfigured())
      throw new ServiceUnavailableException(
        'Subscription checkout is unavailable for this gateway. Please choose another or contact ChurchOS.',
      );
    return gateway;
  }

  pricingCatalog(currency: string) {
    return this.pricing.catalog(currency);
  }

  async status(churchId: string) {
    const subscription = await this.prisma.platformSubscription.findUnique({
      where: { church_id: churchId },
    });
    const latestPayment = await this.prisma.subscriptionPayment.findFirst({
      where: { church_id: churchId, status: 'pending', checkout_closed_at: null },
      orderBy: { created_at: 'desc' },
      select: {
        reference: true,
        gateway: true,
        plan: true,
        cycle: true,
        amount: true,
        currency: true,
        checkout_url: true,
        created_at: true,
      },
    });
    const entitlement = await churchEntitlements(this.prisma, churchId);
    const [members, staff, locations, pendingInvitations, payments] = await Promise.all([
      this.prisma.member.count({ where: { church_id: churchId, archived_at: null } }),
      this.prisma.profile.count({
        where: {
          church_id: churchId,
          archived_at: null,
          status: 'active',
          NOT: { role: { isEmpty: true } },
        },
      }),
      this.prisma.branch.count({ where: { church_id: churchId, archived_at: null } }),
      this.prisma.staffInvitationReservation.count({
        where: { church_id: churchId, expires_at: { gt: new Date() } },
      }),
      this.prisma.subscriptionPayment.findMany({
        where: { church_id: churchId },
        orderBy: { created_at: 'desc' },
        take: 50,
        select: {
          reference: true,
          plan: true,
          cycle: true,
          amount: true,
          currency: true,
          pricing_snapshot: true,
          lifecycle: true,
          checkout_closed_at: true,
          checkout_close_reason: true,
          status: true,
          intent: true,
          application_status: true,
          created_at: true,
          verified_at: true,
        },
      }),
    ]);
    return {
      baseCurrency: 'USD',
      gatewayCurrencies: {
        flutterwave: this.pricing.gatewayCurrencies('flutterwave'),
      },
      catalog: Object.entries(SUBSCRIPTION_PLANS).map(([id, pricing]) => ({
        id,
        ...pricing,
        limits: PLAN_CAPACITIES[id as keyof typeof PLAN_CAPACITIES],
      })),
      limits: entitlement.limits,
      features: entitlement.features,
      usage: { members, staff: staff + pendingInvitations, locations, pendingInvitations },
      payments,
      subscription: entitlement.subscription,
      accessReview: resolvePaymentAccess(subscription?.access_grants).held,
      active: entitlement.active,
      gateways: [this.flutterwave].filter((g) => g.isConfigured()).map((g) => g.name),
      latestPayment: latestPayment
        ? {
            reference: latestPayment.reference,
            gateway: latestPayment.gateway,
            plan: latestPayment.plan,
            cycle: latestPayment.cycle,
            amount: latestPayment.amount,
            currency: latestPayment.currency,
          }
        : null,
    };
  }

  private calculateQuote(
    current: {
      plan: SubscriptionPlan;
      cycle: BillingCycle;
      paid_until: Date | null;
      period_started_at?: Date | null;
      scheduled_plan?: SubscriptionPlan | null;
      access_grants?: Prisma.JsonValue;
    },
    plan: Exclude<SubscriptionPlan, 'enterprise'>,
    cycle: BillingCycle,
  ) {
    const now = new Date();
    const active = !!(current.paid_until && current.paid_until > now);
    if (
      !active &&
      accessGrants(current.access_grants).some(
        (grant) =>
          (grant.state === 'review' &&
            Date.parse(grant.start) <= +now &&
            Date.parse(grant.end) > +now) ||
          (grant.state === 'clear' && Date.parse(grant.start) > +now),
      )
    )
      throw new ConflictException(
        'Your paid periods require ChurchOS review before another checkout. Contact support to avoid overlapping payments.',
      );
    const price = SUBSCRIPTION_PLANS[plan][cycle];
    if (!active)
      return {
        intent: 'renewal',
        amount: price,
        effectiveAt: now,
        renewBy: subscriptionEnd(now, cycle),
        credit: 0,
      };
    if (current.plan === plan)
      throw new ConflictException(
        'Your subscription is already active. Renew after the current period ends.',
      );

    if (current.plan === 'enterprise' || PLAN_RANK[plan] <= PLAN_RANK[current.plan])
      throw new ConflictException('Schedule a downgrade for your next renewal.');
    if (cycle !== current.cycle)
      throw new ConflictException('Keep your current billing period for an immediate upgrade.');
    const start = current.period_started_at
      ? new Date(current.period_started_at)
      : new Date(current.paid_until!);
    if (!current.period_started_at) {
      const day = start.getUTCDate();
      start.setUTCDate(1);
      start.setUTCMonth(start.getUTCMonth() - (cycle === 'annual' ? 12 : 1));
      start.setUTCDate(
        Math.min(
          day,
          new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate(),
        ),
      );
    }
    const fraction = Math.max(
      0,
      Math.min(
        1,
        (current.paid_until!.getTime() - now.getTime()) /
          (current.paid_until!.getTime() - start.getTime()),
      ),
    );
    const amount = Math.max(0.000001, (price - SUBSCRIPTION_PLANS[current.plan][cycle]) * fraction);
    return {
      intent: 'upgrade',
      amount,
      effectiveAt: now,
      renewBy: current.paid_until!,
      credit: Math.floor(SUBSCRIPTION_PLANS[current.plan][cycle] * fraction),
    };
  }
  async quote(churchId: string, dto: CheckoutDto) {
    this.assertSubscriptionGateway(dto.gateway);
    const current = projectSubscription(
      await this.prisma.platformSubscription.findUniqueOrThrow({
        where: { church_id: churchId },
      }),
    );
    const currency = dto.currency || 'USD';
    this.pricing.assertGatewayCurrency(dto.gateway, currency);
    const calculated = this.calculateQuote(current, dto.plan, dto.cycle);
    const exchange = await this.pricing.exchange(currency);
    const payload: LockedQuote = {
      plan: dto.plan,
      cycle: dto.cycle,
      gateway: dto.gateway,
      currency,
      intent: calculated.intent,
      amount: convertedPrice(calculated.amount, exchange.rate),
      usdAmount: calculated.amount,
      exchangeRate: exchange.rate,
      rateUpdatedAt: exchange.updatedAt,
      effectiveAt: calculated.effectiveAt.toISOString(),
      renewBy: calculated.renewBy.toISOString(),
      credit: calculated.credit,
      expiresAt: new Date(Date.now() + 900000).toISOString(),
      base: {
        plan: current.plan,
        cycle: current.cycle,
        paidUntil: current.paid_until?.toISOString() ?? null,
        periodStartedAt: current.period_started_at?.toISOString() ?? null,
      },
    };
    const quoteId = await this.pricing.saveQuote(churchId, payload);
    return { ...payload, quoteId };
  }
  async schedule(
    churchId: string,
    plan: Exclude<SubscriptionPlan, 'enterprise'> | null,
    cycle?: BillingCycle,
  ) {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM churches WHERE id=${churchId} FOR UPDATE`;
      const current = projectSubscription(
        await tx.platformSubscription.findUniqueOrThrow({
          where: { church_id: churchId },
        }),
      );
      if (
        await tx.subscriptionPayment.findFirst({
          where: { church_id: churchId, status: 'pending', checkout_closed_at: null },
        })
      )
        throw new ConflictException('Complete your pending checkout first.');
      if (
        plan &&
        (PLAN_RANK[plan] > PLAN_RANK[current.plan] ||
          !current.paid_until ||
          current.paid_until <= new Date())
      )
        throw new BadRequestException('Choose a downgrade for an active subscription.');
      await tx.platformSubscription.update({
        where: { church_id: churchId },
        data: { scheduled_plan: plan, scheduled_cycle: plan ? (cycle ?? current.cycle) : null },
      });
    });
    return this.status(churchId);
  }

  async checkout(churchId: string, email: string, dto: CheckoutDto) {
    this.assertSubscriptionGateway(dto.gateway);
    const gateway = this.gateway(dto.gateway);
    const callback = new URL(
      '/subscription?payment_window=1',
      this.config.getOrThrow<string>('WEB_URL'),
    ).href;
    // Lock only our local ledger; provider I/O runs outside the transaction.
    const attempt = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM churches WHERE id = ${churchId} FOR UPDATE`;
      const subscription = projectSubscription(
        await tx.platformSubscription.upsert({
          where: { church_id: churchId },
          create: { church_id: churchId, plan: dto.plan, cycle: dto.cycle },
          update: {},
        }),
      );

      await tx.subscriptionPayment.updateMany({
        where: {
          church_id: churchId,
          status: 'pending',
          checkout_closed_at: null,
          created_at: { lt: new Date(Date.now() - 24 * 3600000) },
        },
        data: {
          checkout_closed_at: new Date(),
          checkout_close_reason: 'expired',
          checkout_url: null,
        },
      });
      const pending = await tx.subscriptionPayment.findFirst({
        where: { church_id: churchId, status: 'pending', checkout_closed_at: null },
      });
      if (pending) {
        if (
          pending.plan !== dto.plan ||
          pending.cycle !== dto.cycle ||
          pending.gateway !== dto.gateway ||
          (dto.currency !== undefined && pending.currency !== dto.currency)
        )
          throw new ConflictException(
            'Complete the existing pending checkout before selecting another plan.',
          );
        const snapshot = pending.pricing_snapshot as { quoteId?: string } | null;
        if (dto.quoteId && snapshot?.quoteId !== dto.quoteId)
          throw new ConflictException(
            'Another checkout is pending. Refresh Plan & Billing to review its amount before resuming.',
          );
        if (pending.checkout_url) return pending;
        throw new ConflictException('A checkout is being prepared. Please retry shortly.');
      }
      const quote = await this.pricing.getQuote(churchId, dto.quoteId);
      const currency = dto.currency || 'USD';
      this.pricing.assertGatewayCurrency(dto.gateway, currency);
      if (
        quote.plan !== dto.plan ||
        quote.cycle !== dto.cycle ||
        quote.gateway !== dto.gateway ||
        quote.currency !== currency
      )
        throw new BadRequestException(
          'This quote belongs to a different plan, currency or gateway. Review a fresh quote.',
        );
      if (
        quote.base.plan !== subscription.plan ||
        quote.base.cycle !== subscription.cycle ||
        quote.base.paidUntil !== (subscription.paid_until?.toISOString() ?? null) ||
        quote.base.periodStartedAt !== (subscription.period_started_at?.toISOString() ?? null)
      )
        throw new ConflictException('Your subscription changed. Review a fresh payment quote.');
      // Validate the entitlement transition again under the church lock; charge the frozen price.
      this.calculateQuote(subscription, dto.plan, dto.cycle);
      return tx.subscriptionPayment.create({
        data: {
          church_id: churchId,
          reference: `COSUB_${randomBytes(16).toString('hex')}`,
          billing_email: email,
          gateway: dto.gateway,
          plan: dto.plan,
          cycle: dto.cycle,
          amount: quote.amount,
          intent: quote.intent,
          base_plan: subscription.plan,
          base_paid_until: subscription.paid_until,
          target_paid_until: quote.intent === 'upgrade' ? subscription.paid_until : null,
          currency,
          pricing_snapshot: { ...quote, quoteId: dto.quoteId } as unknown as Prisma.InputJsonValue,
          status: 'pending',
        },
      });
    });
    try {
      if (attempt.checkout_url) {
        const url = this.checkoutUrl(attempt.checkout_url);
        return { authorizationUrl: url.href, reference: attempt.reference };
      }
      const result = await gateway.initializeTransaction(
        email,
        attempt.amount,
        attempt.reference,
        { purpose: 'churchos_subscription', churchId },
        { callbackUrl: callback, currency: attempt.currency },
      );
      const url = this.checkoutUrl(result.authorizationUrl);
      if (result.reference !== attempt.reference)
        throw new ServiceUnavailableException('The payment provider returned an invalid checkout.');
      await this.prisma.subscriptionPayment.update({
        where: { reference: attempt.reference },
        data: { checkout_url: url.href },
      });
      return { authorizationUrl: url.href, reference: attempt.reference };
    } catch (error) {
      // No checkout URL was handed to the browser. Release the local slot;
      // a late signed success still reconciles through verify, even for this attempt.
      await this.prisma.subscriptionPayment.updateMany({
        where: { reference: attempt.reference, status: 'pending' },
        data: { status: 'failed' },
      });
      throw error;
    }
  }

  private assertSubscriptionGateway(gateway: string) {
    if (gateway !== 'flutterwave')
      throw new BadRequestException(
        'ChurchOS subscriptions use Flutterwave. Refresh Plan & Billing.',
      );
  }

  private checkoutUrl(value: string): URL {
    const testMode = this.config
      .get<string>('FLUTTERWAVE_SECRET_KEY', '')
      .startsWith('FLWSECK_TEST-');
    const url = trustedFlutterwaveCheckout(value, testMode);
    if (!url)
      throw new ServiceUnavailableException('The payment provider returned an invalid checkout.');
    return url;
  }

  async verify(churchId: string, reference: string) {
    await this.reconcilePayment(churchId, reference);
    const payment = await this.prisma.subscriptionPayment.findFirst({
      where: { reference, church_id: churchId },
      select: { reference: true, status: true, application_status: true },
    });
    return { ...(await this.status(churchId)), verification: payment };
  }

  async reviewPayment(
    churchId: string,
    reviewer: { id: string; roles: string[] },
    reference: string,
    decision: 'release' | 'revoke',
    reason: string,
  ) {
    if (reason.trim().length < 10 || reason.length > 500)
      throw new BadRequestException('Provide a review reason between 10 and 500 characters');
    if (!reviewer.roles.includes('super_admin'))
      throw new ForbiddenException('ChurchOS review is required');
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM churches WHERE id = ${churchId} FOR UPDATE`;
      const payment = await tx.subscriptionPayment.findFirstOrThrow({
        where: { church_id: churchId, reference },
      });
      const subscription = await tx.platformSubscription.findUniqueOrThrow({
        where: { church_id: churchId },
      });
      const lifecycle = record(payment.lifecycle);
      const grants = accessGrants(subscription.access_grants);
      const grant = grants.find((item) => item.reference === reference);
      if (!grant || lifecycle.access !== 'review' || !Array.isArray(lifecycle.adjustments))
        throw new ConflictException(
          'This payment does not have an access hold available for review',
        );
      const reviewed = {
        ...lifecycle,
        access: decision === 'release' ? 'clear' : 'revoked',
        review: {
          fingerprint: adjustmentFingerprint(
            lifecycle.adjustments as unknown as PaymentAdjustment[],
          ),
          decision,
          reason: reason.trim(),
          reviewedBy: reviewer.id,
          reviewedAt: new Date().toISOString(),
        },
      };
      grant.state = decision === 'release' ? 'clear' : 'revoked';
      await tx.subscriptionPayment.updateMany({
        where: { church_id: churchId, reference },
        data: {
          lifecycle: reviewed as unknown as Prisma.InputJsonValue,
          application_status: decision === 'release' ? 'applied' : 'revoked',
        },
      });
      await tx.platformSubscription.update({
        where: { church_id: churchId },
        data: { access_grants: { grants } as unknown as Prisma.InputJsonValue },
      });
      await tx.auditLog.create({
        data: {
          church_id: churchId,
          user_id: reviewer.id,
          action: 'UPDATE',
          entity: 'subscription_payment_review',
          entity_id: reference,
          new_values: { decision, reason: reason.trim() },
        },
      });
    });
    return this.status(churchId);
  }

  async closeCheckout(churchId: string, reference: string) {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM churches WHERE id = ${churchId} FOR UPDATE`;
      const changed = await tx.subscriptionPayment.updateMany({
        where: { church_id: churchId, reference, status: 'pending', checkout_closed_at: null },
        data: {
          checkout_closed_at: new Date(),
          checkout_close_reason: 'cancelled',
          checkout_url: null,
        },
      });
      if (!changed.count)
        throw new ConflictException('This checkout is no longer pending. Refresh billing.');
    });
    return this.status(churchId);
  }

  /** Reused by browser verification, signed callbacks and the recovery worker. */
  async reconcilePayment(churchId: string, reference: string): Promise<void> {
    const payment = await this.prisma.subscriptionPayment.findFirst({
      where: { reference, church_id: churchId },
    });
    if (!payment) throw new NotFoundException('Subscription payment not found');

    if (
      payment.status === 'reversed' ||
      (payment.status === 'success' && payment.application_status !== 'pending')
    ) {
      if (payment.application_status === 'applied')
        await this.companyEmails.dispatch(`subscription/${payment.reference}`);
    }
    let verified: PaymentVerifyResult;
    try {
      verified = await this.gateway(payment.gateway).verifyTransaction(reference);
    } catch (error) {
      // An opened/abandoned checkout may not have a charge at the provider yet.
      // Leave the stored payment and subscription unchanged for later reconciliation.
      if (error instanceof PaymentVerificationPendingException) return;
      throw error;
    }
    if (
      verified.reference !== reference ||
      verified.currency !== payment.currency ||
      !Number.isFinite(verified.amount) ||
      verified.amount * 100 !== payment.amount * 100
    )
      throw new BadRequestException(
        'Payment details do not match this subscription. Contact ChurchOS with your reference.',
      );
    if (
      payment.status === 'reversed' ||
      (payment.status === 'success' && payment.application_status !== 'pending')
    ) {
      await this.prisma.subscriptionPayment.updateMany({
        where: { reference, church_id: churchId },
        data: {
          provider_transaction_id: verified.providerTransactionId,
          provider_reference: verified.providerReference,
          ...(verified.status === 'success' && !payment.verified_at
            ? { verified_at: new Date() }
            : {}),
        },
      });
      if (verified.status === 'reversed')
        await this.adjustPayment(churchId, reference, {
          id: `charge/${reference}`,
          kind: 'reversal',
          state: 'completed',
          amount: payment.amount,
          currency: payment.currency,
        });
      return;
    }
    if (verified.status !== 'success') {
      if (verified.status === 'failed' || verified.status === 'reversed')
        await this.prisma.subscriptionPayment.updateMany({
          where: { reference, church_id: churchId, status: 'pending' },
          data: { status: verified.status },
        });
      return;
    }
    const emailEvent = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM churches WHERE id = ${churchId} FOR UPDATE`;
      const current = projectSubscription(
        await tx.platformSubscription.findUniqueOrThrow({
          where: { church_id: churchId },
        }),
      );
      const latest = await tx.subscriptionPayment.findFirstOrThrow({
        where: { reference, church_id: churchId },
      });
      const staleUpgrade =
        ['review', 'revoked'].includes(String(record(latest.lifecycle).access)) ||
        !!latest.checkout_closed_at ||
        (!!payment.base_plan &&
          (current.plan !== payment.base_plan ||
            current.paid_until?.getTime() !== payment.base_paid_until?.getTime())) ||
        (payment.intent === 'upgrade' && (!current.paid_until || current.paid_until <= new Date()));
      const claimed = await tx.subscriptionPayment.updateMany({
        where: {
          reference,
          church_id: churchId,
          OR: [
            { status: { in: ['pending', 'failed'] } },
            { status: 'success', application_status: 'pending' },
          ],
        },
        data: {
          status: 'success',
          verified_at: new Date(),
          provider_transaction_id: verified.providerTransactionId,
          provider_reference: verified.providerReference,
          checkout_url: null,
          application_status: staleUpgrade ? 'review' : 'applied',
        },
      });
      if (!claimed.count || staleUpgrade) return;
      const start =
        current.paid_until && current.paid_until > new Date() ? current.paid_until : new Date();
      const paidUntil =
        payment.intent === 'upgrade'
          ? payment.target_paid_until
          : subscriptionEnd(start, payment.cycle as BillingCycle);
      if (!paidUntil)
        throw new BadRequestException('Subscription access period could not be determined');
      await tx.platformSubscription.update({
        where: { church_id: churchId },
        data: {
          plan: payment.plan,
          cycle: payment.cycle,
          access_grants: appendAccessGrant(current.access_grants, current, {
            reference,
            plan: payment.plan,
            cycle: payment.cycle,
            start: (payment.intent === 'upgrade' ? new Date() : start).toISOString(),
            end: paidUntil.toISOString(),
            state: 'clear',
            upgrade: payment.intent === 'upgrade',
          }) as unknown as Prisma.InputJsonValue,
          paid_until: paidUntil,
          ...(payment.intent === 'upgrade' ? {} : { period_started_at: start }),
          scheduled_plan: null,
          scheduled_cycle: null,
        },
      });
      return this.companyEmails.enqueueSubscription(tx, payment, !current.paid_until, paidUntil);
    });
    await this.companyEmails.dispatch(emailEvent);
  }

  async webhook(name: string, raw: string, signature: string) {
    const gateway = this.gateway(name);
    if (!gateway.validateWebhookSignature(raw, signature))
      throw new UnauthorizedException('Invalid payment signature');
    const event = gateway.parseWebhookEvent(raw);
    const identity = event.reference
      ? { reference: event.reference }
      : event.providerTransactionId
        ? { provider_transaction_id: event.providerTransactionId }
        : event.providerReference
          ? { provider_reference: event.providerReference }
          : null;
    if (!identity) return { received: true };
    const matches = event.reference
      ? [
          await this.prisma.subscriptionPayment.findUnique({
            where: { reference: event.reference },
          }),
        ].filter((item): item is NonNullable<typeof item> => !!item && item.gateway === name)
      : await this.prisma.subscriptionPayment.findMany({
          where: { gateway: name as 'paystack' | 'flutterwave', ...identity },
          take: 2,
        });
    if (matches.length > 1) throw new BadRequestException('Ambiguous payment callback');
    const payment = matches[0];
    if (payment) {
      if (event.adjustment)
        await this.adjustPayment(payment.church_id, payment.reference, event.adjustment);
      else if (event.event.startsWith('charge.'))
        await this.reconcilePayment(payment.church_id, payment.reference);
    } else if (event.adjustment) {
      throw new NotFoundException(
        'Payment adjustment could not be matched; retry after charge reconciliation',
      );
    }
    return { received: true };
  }

  async reconcileAdjustments(churchId: string, reference: string) {
    const payment = await this.prisma.subscriptionPayment.findFirst({
      where: { reference, church_id: churchId },
    });
    if (!payment?.provider_transaction_id) return;
    const gateway = this.gateway(payment.gateway);
    const adjustments = await gateway.listAdjustments?.({
      reference,
      providerTransactionId: payment.provider_transaction_id,
      providerReference: payment.provider_reference,
      currency: payment.currency,
      createdAt: payment.created_at,
    });
    for (const adjustment of adjustments ?? [])
      await this.adjustPayment(churchId, reference, adjustment);
  }

  private async adjustPayment(churchId: string, reference: string, adjustment: PaymentAdjustment) {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM churches WHERE id = ${churchId} FOR UPDATE`;
      const payment = await tx.subscriptionPayment.findFirstOrThrow({
        where: { reference, church_id: churchId },
      });
      const lifecycle = applyAdjustment(
        payment.lifecycle,
        adjustment,
        payment.amount,
        payment.currency,
      );
      const subscription = await tx.platformSubscription.findUniqueOrThrow({
        where: { church_id: churchId },
      });
      let grants = accessGrants(subscription.access_grants);
      if (!grants.length) {
        // Reconstruct pre-ledger payments using their frozen baseline and verified application time.
        const history = await tx.subscriptionPayment.findMany({
          where: { church_id: churchId, application_status: 'applied', verified_at: { not: null } },
          orderBy: { verified_at: 'asc' },
        });
        for (const paid of history) {
          const start = new Date(
            Math.max(
              +(paid.verified_at ?? paid.created_at),
              +(paid.base_paid_until ?? new Date(0)),
            ),
          );
          const end =
            paid.intent === 'upgrade' ? paid.target_paid_until : subscriptionEnd(start, paid.cycle);
          if (!end) continue;
          grants = appendAccessGrant(
            { grants },
            {
              plan: paid.base_plan ?? paid.plan,
              cycle: paid.cycle,
              paid_until: paid.base_paid_until,
            },
            {
              reference: paid.reference,
              plan: paid.plan,
              cycle: paid.cycle,
              start: (paid.intent === 'upgrade'
                ? (paid.verified_at ?? paid.created_at)
                : start
              ).toISOString(),
              end: end.toISOString(),
              upgrade: paid.intent === 'upgrade',
              state: 'clear',
            },
          ).grants;
        }
      }
      // Never turn a payment awaiting application review into an access grant.
      const grant = grants.find((item) => item.reference === reference);
      if (grant) grant.state = lifecycle.access;
      else if (payment.application_status === 'applied' && subscription.paid_until) {
        // Historical records without an application timestamp need operator review.
        grants = appendAccessGrant(
          { grants },
          { ...subscription, paid_until: payment.base_paid_until },
          {
            reference,
            plan: payment.plan,
            cycle: payment.cycle,
            start: payment.created_at.toISOString(),
            end: subscription.paid_until.toISOString(),
            state: lifecycle.access === 'clear' ? 'review' : lifecycle.access,
          },
        ).grants;
        // An unitemized legacy balance must not mask an unresolved historical refund.
        // Separately recorded payment grants keep their own dates and states.
        for (const legacy of grants.filter((item) => item.reference === 'legacy')) {
          if (Date.parse(legacy.end) > +payment.created_at) legacy.state = 'review';
        }
      }
      await tx.subscriptionPayment.updateMany({
        where: { reference, church_id: churchId },
        data: {
          lifecycle: lifecycle as unknown as Prisma.InputJsonValue,
          ...(lifecycle.financialReversal
            ? { status: 'reversed' as const }
            : payment.verified_at
              ? { status: 'success' as const }
              : {}),
          application_status:
            lifecycle.access === 'clear'
              ? grant
                ? 'applied'
                : payment.verified_at
                  ? 'pending'
                  : payment.application_status
              : lifecycle.access,
          checkout_url: null,
        },
      });
      if (grants.length)
        await tx.platformSubscription.update({
          where: { church_id: churchId },
          data: { access_grants: { grants } as unknown as Prisma.InputJsonValue },
        });
    });
    const payment = await this.prisma.subscriptionPayment.findFirst({
      where: { reference, church_id: churchId },
    });
    if (payment?.status === 'success' && payment.application_status === 'pending')
      await this.reconcilePayment(churchId, reference);
  }
}
