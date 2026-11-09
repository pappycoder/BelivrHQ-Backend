import { BRAND_NAME, LEGACY_BRAND } from '../brand/brand';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { Prisma, SubscriptionPayment } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { isEmail } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { EmailDeliveryService } from '../communication/email-delivery.service';
import { workersEnabled } from '../queues/workers-enabled';
import { publicWebUrl } from './public-web-url';
import { ServiceUnavailableException } from '@nestjs/common';
import {
  invitationEmail,
  InvitationEmailInput,
  CompanyEmailContent,
  companyEmail,
  CompanyEmailInput,
} from './company-email.templates';

const MAX_ATTEMPTS = 8;
// Resend retains deduplication keys for 24 hours. Never retry an ambiguous send
// beyond that window: leave it for operator review instead of risking a duplicate.
const RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;

@Injectable()
export class CompanyEmailService {
  private readonly logger = new Logger(CompanyEmailService.name);
  private scanning = false;
  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailDeliveryService,
    private readonly config: ConfigService,
  ) {}

  private sender(): string {
    const configured = this.config.get<string>('RESEND_FROM', 'noreply@churchos.app');
    if (/[\r\n]/.test(configured)) throw new Error('Invalid company email sender');
    return configured.includes('<') ? configured : `${BRAND_NAME} <${configured}>`;
  }
  private async enqueue(
    tx: Prisma.TransactionClient,
    eventKey: string,
    churchId: string,
    to: string,
    input: CompanyEmailInput,
  ): Promise<string> {
    return this.enqueueContent(
      tx,
      eventKey,
      churchId,
      to,
      input.kind,
      companyEmail(input, publicWebUrl(this.config)),
    );
  }
  assertInvitationDeliveryConfigured(): void {
    publicWebUrl(this.config);
    if (!this.config.get<string>('RESEND_API_KEY'))
      throw new ServiceUnavailableException('BelivrHQ invitation email delivery is not configured');
  }
  enqueueInvitation(
    tx: Prisma.TransactionClient,
    input: InvitationEmailInput & { churchId: string; userId: string; email: string },
  ): Promise<string> {
    return this.enqueueContent(
      tx,
      `invitation/${input.userId}`,
      input.churchId,
      input.email,
      'invitation',
      invitationEmail(input, publicWebUrl(this.config)),
    );
  }
  private async enqueueContent(
    tx: Prisma.TransactionClient,
    eventKey: string,
    churchId: string,
    to: string,
    kind: string,
    content: CompanyEmailContent,
  ): Promise<string> {
    if (!isEmail(to)) throw new Error('A valid company email recipient is required');
    await tx.companyEmailNotification.createMany({
      data: [
        {
          event_key: eventKey,
          church_id: churchId,
          kind,
          to_email: to,
          from_email: this.sender(),
          ...content,
        },
      ],
      skipDuplicates: true,
    });
    return eventKey;
  }
  enqueueWelcome(
    tx: Prisma.TransactionClient,
    input: CompanyEmailInput & { userId: string; churchId: string; email: string },
  ): Promise<string> {
    return this.enqueue(tx, `registration/${input.userId}`, input.churchId, input.email, {
      ...input,
      kind: 'welcome',
    });
  }
  async enqueueSubscription(
    tx: Prisma.TransactionClient,
    payment: SubscriptionPayment,
    firstPayment: boolean,
    paidUntil: Date,
  ): Promise<string | null> {
    const church = await tx.church.findUniqueOrThrow({
      where: { id: payment.church_id },
      select: { name: true, email: true },
    });
    const recipient = payment.billing_email || church.email;
    if (!recipient || !isEmail(recipient)) {
      this.logger.warn(
        'Legacy subscription has no valid billing email; company notification requires review',
      );
      return null;
    }
    return this.enqueue(tx, `subscription/${payment.reference}`, payment.church_id, recipient, {
      kind: payment.intent === 'upgrade' ? 'upgrade' : firstPayment ? 'activation' : 'renewal',
      churchName: church.name,
      plan: payment.plan,
      cycle: payment.cycle,
      amount: payment.amount,
      currency: payment.currency,
      reference: payment.reference,
      paidUntil,
    });
  }

  /** All caller-visible business work is already committed. Delivery never rolls it back. */
  async dispatch(eventKey: string | null | undefined): Promise<void> {
    if (!eventKey || !this.config.get<string>('RESEND_API_KEY')) return;
    try {
      const row = await this.prisma.companyEmailNotification.findUnique({
        where: { event_key: eventKey },
      });
      if (!row || row.sent_at || row.status === 'failed') return;
      const now = new Date();
      if (row.available_at > now || (row.lease_until && row.lease_until > now)) return;
      if (
        row.attempts >= MAX_ATTEMPTS ||
        (row.first_attempt_at && now.getTime() - row.first_attempt_at.getTime() >= RETRY_WINDOW_MS)
      ) {
        await this.prisma.companyEmailNotification.updateMany({
          where: { id: row.id, sent_at: null, lease_token: row.lease_token },
          data: {
            status: 'failed',
            last_error: 'delivery_window_expired',
            lease_token: null,
            lease_until: null,
          },
        });
        return;
      }
      const token = randomUUID();
      const claimed = await this.prisma.companyEmailNotification.updateMany({
        where: {
          id: row.id,
          sent_at: null,
          status: { in: ['pending', 'sending'] },
          available_at: { lte: now },
          OR: [{ lease_until: null }, { lease_until: { lte: now } }],
        },
        data: {
          status: 'sending',
          lease_token: token,
          lease_until: new Date(now.getTime() + 120000),
          first_attempt_at: row.first_attempt_at ?? now,
          attempts: { increment: 1 },
        },
      });
      if (!claimed.count) return;
      try {
        const providerId = await this.email.sendEmail(
          row.to_email,
          row.subject,
          row.html,
          '',
          undefined,
          {
            text: row.text,
            from: row.from_email,
            idempotencyKey: `${LEGACY_BRAND.emailIdempotencyPrefix}${row.id}`,
          },
        );
        await this.prisma.companyEmailNotification.updateMany({
          where: { id: row.id, lease_token: token, sent_at: null },
          data: {
            status: 'sent',
            sent_at: new Date(),
            provider_id: providerId,
            last_error: null,
            lease_token: null,
            lease_until: null,
          },
        });
      } catch {
        const attempts = row.attempts + 1;
        await this.prisma.companyEmailNotification.updateMany({
          where: { id: row.id, lease_token: token, sent_at: null },
          data: {
            status: attempts >= MAX_ATTEMPTS ? 'failed' : 'pending',
            available_at: new Date(Date.now() + Math.min(30000 * 2 ** (attempts - 1), 1800000)),
            last_error: 'provider_not_accepted',
            lease_token: null,
            lease_until: null,
          },
        });
        this.logger.warn(
          'Company email delivery was not confirmed; notification retained for retry/review',
        );
      }
    } catch {
      this.logger.warn('Company email dispatch unavailable; persistent notification retained');
    }
  }

  @Cron('15 * * * * *')
  async retryPending(): Promise<void> {
    if (!workersEnabled() || this.scanning || !this.config.get<string>('RESEND_API_KEY')) return;
    this.scanning = true;
    try {
      const now = new Date();
      const rows = await this.prisma.companyEmailNotification.findMany({
        where: {
          status: { in: ['pending', 'sending'] },
          available_at: { lte: now },
          OR: [{ lease_until: null }, { lease_until: { lte: now } }],
        },
        select: { event_key: true },
        orderBy: { available_at: 'asc' },
        take: 10,
      });
      for (const row of rows) await this.dispatch(row.event_key);
    } catch {
      this.logger.warn('Company email recovery scan unavailable; it will retry');
    } finally {
      this.scanning = false;
    }
  }
}
