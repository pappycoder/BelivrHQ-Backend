import { GivingService } from '../giving/giving.service';
import { PaystackService } from '../giving/services/paystack.service';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { FlutterwaveService } from '../giving/services/flutterwave.service';
import { workersEnabled } from '../queues/workers-enabled';
import { BillingService } from './billing.service';

@Injectable()
export class PaymentReconciliationService {
  private readonly logger = new Logger(PaymentReconciliationService.name);
  private running = false;
  private cursor = '';
  private givingCursor = '';
  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
    private readonly flutterwave: FlutterwaveService,
    private readonly paystack: PaystackService,
    private readonly giving: GivingService,
  ) {}

  @Cron('0 */2 * * * *')
  async reconcile(): Promise<void> {
    if (!workersEnabled() || this.running) return;
    this.running = true;
    try {
      // Keyset pagination rotates through every candidate without starving newer
      // payments behind abandoned checkouts. Failed attempts can later succeed.
      await this.prisma.subscriptionPayment.updateMany({
        where: {
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
      const payments = await this.prisma.subscriptionPayment.findMany({
        where: {
          gateway: {
            in: [this.flutterwave, this.paystack]
              .filter((provider) => provider.isConfigured())
              .map((provider) => provider.name as 'flutterwave' | 'paystack'),
          },
          status: { in: ['pending', 'failed', 'success', 'reversed'] },
          ...(this.cursor ? { reference: { gt: this.cursor } } : {}),
        },
        orderBy: { reference: 'asc' },
        take: 25,
        select: { reference: true, church_id: true },
      });
      this.cursor = payments.length === 25 ? payments[payments.length - 1].reference : '';
      for (const payment of payments) {
        try {
          await this.billing.reconcilePayment(payment.church_id, payment.reference);
          await this.billing.reconcileAdjustments(payment.church_id, payment.reference);
        } catch {
          this.logger.warn('Subscription payment reconciliation will retry');
        }
      }
      const gifts = await this.prisma.transaction.findMany({
        where: {
          payment_gateway: { in: ['paystack', 'flutterwave'] },
          payment_reference: { not: null },
          ...(this.givingCursor ? { id: { gt: this.givingCursor } } : {}),
        },
        orderBy: { id: 'asc' },
        take: 25,
        select: { id: true, church_id: true, payment_reference: true },
      });
      this.givingCursor = gifts.length === 25 ? gifts[gifts.length - 1].id : '';
      for (const gift of gifts) {
        try {
          await this.giving.reconcilePayment(gift.church_id, gift.payment_reference!);
          await this.giving.reconcileAdjustments(gift.church_id, gift.payment_reference!);
        } catch {
          this.logger.warn('Church payment reconciliation will retry');
        }
      }
    } catch {
      this.logger.warn('Subscription payment recovery scan will retry');
    } finally {
      this.running = false;
    }
  }
}
