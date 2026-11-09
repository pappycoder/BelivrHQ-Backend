import { record, parsePaymentEvent, PaymentAdjustment } from './payment-lifecycle';
/**
 * @file flutterwave.service.ts
 * @description Flutterwave payment integration service.
 *
 * Handles payment initialization, transaction verification, and webhook
 * signature validation for Flutterwave's v3 REST API.
 *
 * @module giving/services/flutterwave.service
 * @since 1.0.0
 */

import {
  Injectable,
  Logger,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PaymentVerificationPendingException } from './payment-verification-pending.exception';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import {
  PaymentGatewayProvider,
  PaymentInitializeResult,
  PaymentVerifyResult,
  WebhookEvent,
} from './payment-gateway.interface';

/**
 * Flutterwave initialize response.
 */
interface FlutterwaveInitializeResponse {
  status: string;
  message: string;
  data: {
    link: string;
  };
}

/**
 * Flutterwave verify response.
 */
interface FlutterwaveVerifyResponse {
  status: string;
  message: string;
  data: {
    id: number;
    tx_ref: string;
    flw_ref?: string;
    amount: number;
    currency: string;
    status: string;
    created_at: string;
    payment_type: string;
    customer: {
      name: string;
      email: string;
    };
  } | null;
}

/**
 * Service for interacting with the Flutterwave payment API.
 * Provides payment initialization, verification, and webhook validation.
 *
 * Flutterwave API docs: https://developer.flutterwave.com/docs
 */
@Injectable()
export class FlutterwaveService implements PaymentGatewayProvider {
  readonly name = 'flutterwave';
  private readonly logger = new Logger(FlutterwaveService.name);
  private readonly secretKey: string;
  private readonly baseUrl = 'https://api.flutterwave.com/v3';

  constructor(private readonly config: ConfigService) {
    this.secretKey = this.config.get<string>('FLUTTERWAVE_SECRET_KEY', '');
  }

  /**
   * Checks if Flutterwave is configured.
   */
  isConfigured(): boolean {
    return !!this.secretKey;
  }

  /**
   * Performs a Flutterwave API request, mapping network/transport failures (DNS,
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
      this.logger.error(`Flutterwave network error: provider request failed`);
      throw new ServiceUnavailableException(
        'Flutterwave gateway is temporarily unavailable. Please try again.',
      );
    }

    onResponse?.(response.status ?? 200);
    try {
      return (await response.json()) as T;
    } catch {
      this.logger.error(`Flutterwave invalid response: provider request failed`);
      throw new ServiceUnavailableException(
        'Flutterwave gateway returned an invalid response. Please try again.',
      );
    }
  }

  /**
   * Initializes a Flutterwave payment.
   *
   * @param email - Payer email address
   * @param amount - Amount in Naira (no conversion needed — Flutterwave uses Naira directly)
   * @param reference - Unique transaction reference
   * @param metadata - Additional metadata to attach to the transaction
   * @returns Authorization URL for the payer
   * @throws BadRequestException if Flutterwave is not configured or API call fails
   */
  async initializeTransaction(
    email: string,
    amount: number,
    reference: string,
    metadata?: Record<string, unknown>,
    options?: { callbackUrl?: string; currency?: string },
  ): Promise<PaymentInitializeResult> {
    if (!this.isConfigured()) {
      throw new BadRequestException('Flutterwave is not configured. Set FLUTTERWAVE_SECRET_KEY.');
    }

    const body: Record<string, unknown> = {
      tx_ref: reference,
      amount,
      currency: options?.currency || 'NGN',
      redirect_url:
        options?.callbackUrl ||
        metadata?.redirect_url ||
        `${this.config.get<string>('WEB_URL', 'http://localhost:3000').replace(/\/$/, '')}/payment/complete`,
      customer: { email },
      meta: metadata,
    };

    const result = await this.request<FlutterwaveInitializeResponse>(`${this.baseUrl}/payments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (result.status !== 'success') {
      this.logger.error(`Flutterwave initialize failed: check provider configuration`);
      throw new BadRequestException(`Payment initialization failed: check provider configuration`);
    }

    return {
      authorizationUrl: result.data.link,
      reference,
    };
  }

  /**
   * Verifies a Flutterwave transaction by reference.
   *
   * Note: Flutterwave verify uses tx_ref, not a numeric ID.
   * We query by tx_ref using the transactions endpoint.
   *
   * @param reference - Transaction reference (tx_ref) to verify
   * @returns Verification data including amount, status, and payment details
   * @throws BadRequestException if Flutterwave is not configured or verification fails
   */
  async verifyTransaction(reference: string): Promise<PaymentVerifyResult> {
    if (!this.isConfigured()) {
      throw new BadRequestException('Flutterwave is not configured. Set FLUTTERWAVE_SECRET_KEY.');
    }

    // Flutterwave verify endpoint requires transaction ID, not tx_ref.
    // Official v3 reference endpoint (the similarly named verify_by_tx_ref
    // path returns an HTML page, even with HTTP 200).
    let httpStatus = 200;
    const result = await this.request<FlutterwaveVerifyResponse>(
      `${this.baseUrl}/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
        },
      },
      (status) => {
        httpStatus = status;
      },
    );

    if (httpStatus === 401 || httpStatus === 403) {
      this.logger.error(`Flutterwave verification rejected: authentication (HTTP ${httpStatus})`);
      throw new ServiceUnavailableException(
        'Payment verification is unavailable. Contact ChurchOS support to check the Flutterwave account configuration.',
      );
    }
    if (
      [200, 400, 404].includes(httpStatus) &&
      result?.status === 'error' &&
      result.data == null &&
      typeof result.message === 'string' &&
      /^no transaction (?:was )?found(?: for this (?:id|ref|reference))?\.?$/i.test(
        result.message.trim(),
      )
    ) {
      throw new PaymentVerificationPendingException();
    }
    if (httpStatus >= 400 || result?.status !== 'success') {
      this.logger.error(`Flutterwave verification rejected: provider_error (HTTP ${httpStatus})`);
      throw new ServiceUnavailableException(
        'Flutterwave could not confirm this payment. Please try again or contact support with your payment reference.',
      );
    }
    if (
      !result.data ||
      typeof result.data.tx_ref !== 'string' ||
      !result.data.tx_ref ||
      typeof result.data.currency !== 'string' ||
      !result.data.currency ||
      typeof result.data.amount !== 'number' ||
      !Number.isFinite(result.data.amount) ||
      typeof result.data.status !== 'string'
    ) {
      this.logger.error('Flutterwave verification rejected: invalid_response');
      throw new ServiceUnavailableException(
        'Flutterwave returned incomplete payment details. Please try again.',
      );
    }

    const status = this.mapFlutterwaveStatus(result.data.status);

    return {
      providerTransactionId: result.data.id == null ? undefined : String(result.data.id),
      providerReference: result.data.flw_ref,
      currency: result.data.currency,
      reference: result.data.tx_ref,
      amount: result.data.amount,
      status,
      paidAt: result.data.created_at,
      channel: result.data.payment_type,
      customerEmail: result.data.customer?.email ?? '',
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
    const from = payment.createdAt.toISOString().slice(0, 10);
    const to = new Date().toISOString().slice(0, 10);
    // Refund references identify the refund, not the original charge. Filter the
    // returned original transaction IDs before associating any adjustment.
    const paths = [
      `refunds?from=${from}&to=${to}&currency=${encodeURIComponent(payment.currency)}`,
      `chargebacks?from=${from}&to=${to}&currency=${encodeURIComponent(payment.currency)}${payment.providerReference ? `&flw_ref=${encodeURIComponent(payment.providerReference)}` : ''}`,
    ];
    for (const path of paths) {
      for (let page = 1; page <= 100; page++) {
        const result = await this.request<{
          status: string;
          data: unknown[];
          meta?: { page_info?: { total_pages?: number } };
        }>(`${this.baseUrl}/${path}&page=${page}`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${this.secretKey}` },
        });
        if (result.status !== 'success' || !Array.isArray(result.data))
          throw new ServiceUnavailableException('Payment adjustment recovery is unavailable');
        for (const item of result.data) {
          const data = record(item);
          const parsed = parsePaymentEvent('flutterwave', {
            event: path.startsWith('refunds') ? 'refund.update' : `chargeback.${data.status}`,
            data,
          });
          if (
            parsed.providerTransactionId !== payment.providerTransactionId &&
            parsed.reference !== payment.reference &&
            !(payment.providerReference && parsed.providerReference === payment.providerReference)
          )
            continue;
          if (parsed.adjustment) adjustments.push(parsed.adjustment);
        }
        const lastPage = result.meta?.page_info?.total_pages;
        if (!result.data.length || !lastPage || page >= lastPage) break;
        if (page === 100)
          throw new ServiceUnavailableException('Payment adjustment history requires review');
      }
    }
    return adjustments;
  }

  /**
   * Validates a Flutterwave webhook signature.
   *
   * Flutterwave uses HMAC-SHA512 with the secret key, sending the
   * hash in the `verif-hash` header.
   *
   * @param payload - Raw webhook body (string)
   * @param signature - Value from verif-hash header
   * @returns true if signature is valid, false otherwise
   */
  validateWebhookSignature(payload: string, signature: string): boolean {
    if (!this.isConfigured() || !signature) {
      return false;
    }

    try {
      const webhookSecret = this.config.get<string>('FLUTTERWAVE_WEBHOOK_SECRET');
      const expected =
        webhookSecret || createHmac('sha512', this.secretKey).update(payload).digest('hex');
      const modern = webhookSecret
        ? createHmac('sha256', webhookSecret).update(payload).digest('base64')
        : '';
      if (
        modern &&
        modern.length === signature.length &&
        timingSafeEqual(Buffer.from(modern), Buffer.from(signature))
      )
        return true;

      return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    } catch {
      this.logger.warn('Webhook signature validation failed');
      return false;
    }
  }

  /**
   * Parses a Flutterwave webhook event payload.
   *
   * @param payload - Raw webhook body string
   * @returns Parsed event object with standardized fields
   * @throws BadRequestException if payload is invalid JSON
   */
  parseWebhookEvent(payload: string): WebhookEvent {
    try {
      const event = JSON.parse(payload) as Record<string, unknown>;
      const normalized = parsePaymentEvent('flutterwave', event);
      if (!normalized.event) throw new BadRequestException('Invalid webhook payload structure');
      const data = normalized.data;
      return {
        event: normalized.event,
        reference: normalized.reference,
        providerTransactionId: normalized.providerTransactionId,
        providerReference: normalized.providerReference,
        adjustment: normalized.adjustment,
        amount: data.amount as number | undefined,
        channel: data.payment_type as string | undefined,
        customerEmail: (data.customer as Record<string, unknown>)?.email as string | undefined,
        authorizationCode: (data.authorization as Record<string, unknown>)?.authorization_code as
          string | undefined,
        rawData: event,
      };
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      throw new BadRequestException('Invalid webhook payload');
    }
  }

  /**
   * Maps Flutterwave event to a transaction status.
   *
   * @param event - Flutterwave event name
   * @returns Mapped TransactionStatus or null if event is not relevant
   */
  mapEventToStatus(event: string): 'success' | 'failed' | 'reversed' | null {
    switch (event) {
      case 'charge.completed':
        return 'success';
      case 'charge.failed':
        return 'failed';

      default:
        return null;
    }
  }

  /**
   * Maps Flutterwave payment type to internal payment method.
   *
   * @param channel - Flutterwave payment type
   * @returns Mapped payment method string
   */
  mapChannelToPaymentMethod(channel: string): string {
    switch (channel) {
      case 'card':
        return 'card';
      case 'banktransfer':
        return 'bank_transfer';
      case 'bank_transfer':
        return 'bank_transfer';
      case 'ussd':
        return 'ussd';
      case 'mobile_money':
        return 'mobile_money';
      case 'account':
        return 'bank_transfer';
      default:
        return 'digital';
    }
  }

  /**
   * Maps Flutterwave transaction status to internal status.
   */
  private mapFlutterwaveStatus(status: string): 'success' | 'failed' | 'reversed' | 'pending' {
    switch (status) {
      case 'successful':
        return 'success';
      case 'failed':
        return 'failed';
      case 'reversed':
        return 'reversed';
      default:
        return 'pending';
    }
  }
}
