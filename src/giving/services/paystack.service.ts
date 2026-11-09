import { PaymentVerificationPendingException } from './payment-verification-pending.exception';
import { record, parsePaymentEvent, PaymentAdjustment } from './payment-lifecycle';
/**
 * @file paystack.service.ts
 * @description Paystack payment integration service.
 *
 * Handles payment initialization, transaction verification, and webhook
 * signature validation. All API calls go to Paystack's REST API.
 *
 * @module giving/services/paystack.service
 * @since 1.0.0
 */

import {
  Injectable,
  Logger,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual, randomBytes } from 'crypto';
import {
  PaymentGatewayProvider,
  PaymentInitializeResult,
  PaymentVerifyResult,
  ChargeAuthorizationResult,
  WebhookEvent,
} from './payment-gateway.interface';

/**
 * Paystack initialization response.
 */
interface PaystackInitializeResponse {
  status: boolean;
  message: string;
  data: {
    authorization_url: string;
    access_code: string;
    reference: string;
  };
}

/**
 * Paystack verification response.
 */
interface PaystackVerifyResponse {
  status: boolean;
  message: string;
  data: {
    id: number;
    domain: string;
    amount: number;
    currency: string;
    reference: string;
    status: string;
    gateway_response: string;
    paid_at: string;
    created_at: string;
    channel: string;
    metadata: Record<string, unknown>;
    customer: {
      id: number;
      email: string;
    };
    authorization?: {
      authorization_code: string;
      card_type: string;
      last4: string;
      exp_month: string;
      exp_year: string;
      bank: string;
    };
  };
}

/**
 * Service for interacting with the Paystack payment API.
 * Provides payment initialization, verification, and webhook validation.
 */
@Injectable()
export class PaystackService implements PaymentGatewayProvider {
  readonly name = 'paystack';
  private readonly logger = new Logger(PaystackService.name);
  private readonly secretKey: string;
  private readonly baseUrl = 'https://api.paystack.co';

  constructor(private readonly config: ConfigService) {
    this.secretKey = this.config.get<string>('PAYSTACK_SECRET_KEY', '');
  }

  /**
   * Checks if Paystack is configured.
   */
  isConfigured(): boolean {
    return !!this.secretKey;
  }

  /**
   * Performs a Paystack API request, mapping network/transport failures (DNS,
   * timeout, connection refused, bad JSON) to a clean ServiceUnavailableException
   * so callers never surface an untyped Node `fetch` error. HTTP-level provider
   * errors are left for the caller to interpret from the parsed body.
   */
  private async request<T>(
    url: string,
    init: RequestInit,
    onResponse?: (status: number) => void,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      this.logger.error(`Paystack network error: provider request failed`);
      throw new ServiceUnavailableException(
        'Paystack gateway is temporarily unavailable. Please try again.',
      );
    }

    onResponse?.(response.status);
    try {
      return (await response.json()) as T;
    } catch {
      this.logger.error(`Paystack invalid response: provider request failed`);
      throw new ServiceUnavailableException(
        'Paystack gateway returned an invalid response. Please try again.',
      );
    }
  }

  /**
   * Initializes a Paystack transaction.
   *
   * @param email - Payer email address
   * @param amount - Amount in Naira (converted to Kobo internally)
   * @param reference - Unique transaction reference
   * @param metadata - Additional metadata to attach to the transaction
   * @returns Authorization URL and access code
   * @throws BadRequestException if Paystack is not configured or API call fails
   */
  async initializeTransaction(
    email: string,
    amount: number,
    reference: string,
    metadata?: Record<string, unknown>,
    options?: { callbackUrl?: string; currency?: string },
  ): Promise<PaymentInitializeResult> {
    if (!this.isConfigured()) {
      throw new BadRequestException('Paystack is not configured. Set PAYSTACK_SECRET_KEY.');
    }

    // Convert Naira to Kobo (Paystack expects smallest currency unit)
    const amountInKobo = Math.round(amount * 100);

    const body: Record<string, unknown> = {
      email,
      amount: amountInKobo,
      reference,
      currency: options?.currency || 'NGN',
    };

    if (metadata) {
      body.metadata = metadata;
    }
    if (options?.callbackUrl) body.callback_url = options.callbackUrl;

    const result = await this.request<PaystackInitializeResponse>(
      `${this.baseUrl}/transaction/initialize`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );

    if (!result.status) {
      this.logger.error(`Paystack initialize failed: check provider configuration`);
      throw new BadRequestException(`Payment initialization failed: check provider configuration`);
    }

    return {
      authorizationUrl: result.data.authorization_url,
      accessCode: result.data.access_code,
      reference: result.data.reference,
    };
  }

  /**
   * Verifies a Paystack transaction by reference.
   *
   * @param reference - Transaction reference to verify
   * @returns Verification data including amount, status, and payment details
   * @throws BadRequestException if Paystack is not configured or verification fails
   */
  async verifyTransaction(reference: string): Promise<PaymentVerifyResult> {
    if (!this.isConfigured()) {
      throw new BadRequestException('Paystack is not configured. Set PAYSTACK_SECRET_KEY.');
    }

    let httpStatus = 200;
    const result = await this.request<PaystackVerifyResponse>(
      `${this.baseUrl}/transaction/verify/${encodeURIComponent(reference)}`,
      { method: 'GET', headers: { Authorization: `Bearer ${this.secretKey}` } },
      (status) => {
        httpStatus = status;
      },
    );
    if (
      [200, 400, 404].includes(httpStatus) &&
      result?.status === false &&
      /^(?:transaction reference not found|transaction not found)\.?$/i.test(result.message ?? '')
    )
      throw new PaymentVerificationPendingException();
    if (
      httpStatus >= 400 ||
      result?.status !== true ||
      !result.data ||
      typeof result.data.reference !== 'string' ||
      typeof result.data.currency !== 'string' ||
      typeof result.data.status !== 'string' ||
      !Number.isFinite(result.data.amount)
    ) {
      this.logger.warn(`Paystack verification unavailable (HTTP ${httpStatus})`);
      throw new ServiceUnavailableException(
        'Paystack could not confirm this payment. Please try again or contact support with your reference.',
      );
    }

    return {
      providerTransactionId: result.data.id == null ? undefined : String(result.data.id),
      currency: result.data.currency,
      reference: result.data.reference,
      amount: result.data.amount / 100, // Convert Kobo to Naira
      status:
        result.data.status === 'success'
          ? 'success'
          : ['failed', 'abandoned'].includes(result.data.status)
            ? 'failed'
            : result.data.status === 'reversed'
              ? 'reversed'
              : 'pending',
      paidAt: result.data.paid_at,
      channel: result.data.channel,
      customerEmail: result.data.customer?.email ?? '',
      authorization: result.data.authorization,
    };
  }

  async listAdjustments(payment: {
    reference: string;
    providerTransactionId: string;
    providerReference?: string | null;
    currency: string;
    createdAt: Date;
  }): Promise<PaymentAdjustment[]> {
    const adjustments: PaymentAdjustment[] = [];
    const paths = ['refund', 'dispute'];
    for (const path of paths) {
      for (let page = 1; page <= 100; page++) {
        const result = await this.request<{
          status: boolean;
          data: unknown[];
          meta?: { pageCount?: number };
        }>(
          `${this.baseUrl}/${path}?transaction=${encodeURIComponent(payment.providerTransactionId)}&perPage=100&page=${page}`,
          { method: 'GET', headers: { Authorization: `Bearer ${this.secretKey}` } },
        );
        if (!result.status || !Array.isArray(result.data))
          throw new ServiceUnavailableException('Payment adjustment recovery is unavailable');
        for (const item of result.data) {
          const data = record(item);
          const parsed = parsePaymentEvent('paystack', {
            event:
              path === 'refund'
                ? `refund.${data.status}`
                : data.status === 'resolved'
                  ? 'charge.dispute.resolve'
                  : 'charge.dispute.create',
            data,
          });
          if (
            parsed.providerTransactionId !== payment.providerTransactionId &&
            parsed.reference !== payment.reference
          )
            continue;
          if (parsed.adjustment) adjustments.push(parsed.adjustment);
        }
        if (result.data.length < 100 || (result.meta?.pageCount && page >= result.meta.pageCount))
          break;
        if (page === 100)
          throw new ServiceUnavailableException('Payment adjustment history requires review');
      }
    }
    return adjustments;
  }

  /**
   * Validates a Paystack webhook signature.
   *
   * Uses HMAC-SHA512 with the secret key to verify the webhook payload
   * was sent by Paystack.
   *
   * @param payload - Raw webhook body (string)
   * @param signature - Value from x-paystack-signature header
   * @returns true if signature is valid, false otherwise
   */
  validateWebhookSignature(payload: string, signature: string): boolean {
    if (!this.isConfigured() || !signature) {
      return false;
    }

    try {
      if (signature.split(',').some((part) => /^\s*(t|v1)=/.test(part))) {
        const secret = this.config.get<string>('PAYSTACK_WEBHOOK_SECRET');
        const parts = signature.split(',').map((part) => part.trim());
        const timestamps = parts.filter((part) => part.startsWith('t='));
        if (!secret || timestamps.length !== 1 || !/^t=\d+$/.test(timestamps[0])) return false;
        const timestamp = timestamps[0].slice(2);
        if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
        const expected = createHmac('sha512', secret)
          .update(`${timestamp}.${payload}`)
          .digest('hex');
        return parts
          .filter((part) => part.startsWith('v1='))
          .some((part) => {
            const hex = part.slice(part.indexOf(':') + 1);
            return (
              /^v1=whk_[^:]+:/.test(part) &&
              /^[a-f0-9]{128}$/.test(hex) &&
              timingSafeEqual(Buffer.from(expected), Buffer.from(hex))
            );
          });
      }
      const expected = createHmac('sha512', this.secretKey).update(payload).digest('hex');

      return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    } catch {
      this.logger.warn('Webhook signature validation failed');
      return false;
    }
  }

  /**
   * Parses a Paystack webhook event payload.
   *
   * @param payload - Raw webhook body string
   * @returns Parsed event object with standardized fields
   * @throws BadRequestException if payload is invalid JSON
   */
  parseWebhookEvent(payload: string): WebhookEvent {
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      const normalized = parsePaymentEvent('paystack', parsed);
      if (!normalized.event) throw new BadRequestException('Invalid webhook payload structure');
      const data = normalized.data;
      return {
        event: normalized.event,
        reference: normalized.reference,
        providerTransactionId: normalized.providerTransactionId,
        providerReference: normalized.providerReference,
        adjustment: normalized.adjustment,
        amount: data.amount as number | undefined,
        channel: data.channel as string | undefined,
        customerEmail: (data.customer as Record<string, unknown>)?.email as string | undefined,
        authorizationCode: (data.authorization as Record<string, unknown>)?.authorization_code as
          string | undefined,
        rawData: parsed,
      };
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      throw new BadRequestException('Invalid webhook payload');
    }
  }

  /**
   * Maps Paystack event to a transaction status.
   *
   * @param event - Paystack event name
   * @returns Mapped TransactionStatus or null if event is not relevant
   */
  mapEventToStatus(event: string): 'success' | 'failed' | 'reversed' | null {
    switch (event) {
      case 'charge.success':
        return 'success';
      case 'charge.failed':
        return 'failed';

      default:
        return null;
    }
  }

  /**
   * Maps Paystack channel to transaction payment method.
   *
   * @param channel - Paystack payment channel
   * @returns Mapped payment method string
   */
  mapChannelToPaymentMethod(channel: string): string {
    switch (channel) {
      case 'card':
        return 'card';
      case 'bank':
        return 'bank_transfer';
      case 'ussd':
        return 'ussd';
      case 'mobile_money':
        return 'mobile_money';
      default:
        return 'digital';
    }
  }

  /**
   * Charges a saved payment authorization for recurring giving.
   *
   * @param authorizationCode - Paystack authorization code from a previous successful charge
   * @param amount - Amount in Naira (converted to Kobo internally)
   * @param currency - Currency code (e.g. 'NGN')
   * @param metadata - Additional metadata to attach to the transaction
   * @returns Charge result with reference and status
   * @throws BadRequestException if Paystack is not configured or API call fails
   */
  async chargeAuthorization(
    authorizationCode: string,
    amount: number,
    currency: string,
    metadata?: Record<string, unknown>,
  ): Promise<ChargeAuthorizationResult> {
    if (!this.isConfigured()) {
      throw new BadRequestException('Paystack is not configured. Set PAYSTACK_SECRET_KEY.');
    }

    const amountInKobo = Math.round(amount * 100);
    const reference = `RCHG${Date.now()}${randomBytes(4).toString('hex')}`;

    const body: Record<string, unknown> = {
      authorization_code: authorizationCode,
      amount: amountInKobo,
      currency,
      reference,
    };

    if (metadata) {
      body.metadata = metadata;
    }

    const result = await this.request<{
      status: boolean;
      message: string;
      data: {
        reference: string;
        amount: number;
        status: string;
        paid_at?: string;
        channel?: string;
      };
    }>(`${this.baseUrl}/transaction/charge_authorization`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!result.status) {
      this.logger.error(`Paystack charge authorization failed: check provider configuration`);
      throw new BadRequestException(`Recurring charge failed: check provider configuration`);
    }

    return {
      success: result.data.status === 'success',
      reference: result.data.reference,
      amount: result.data.amount / 100,
      paidAt: result.data.paid_at,
      channel: result.data.channel,
    };
  }
}
