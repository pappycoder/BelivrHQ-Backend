/**
 * @file payment-gateway.interface.ts
 * @description Shared interface and types for payment gateway providers.
 *
 * Defines the contract that all payment gateway services (Paystack, Flutterwave,
 * etc.) must implement. This enables the GivingService to be gateway-agnostic.
 *
 * @module giving/services/payment-gateway.interface
 * @since 1.0.0
 */

/**
 * Result of initializing a payment transaction with a gateway.
 */
export interface PaymentInitializeResult {
  /** Gateway-specific authorization URL to redirect the payer */
  authorizationUrl: string;
  /** Unique transaction reference */
  reference: string;
  /** Optional gateway-specific access code (Paystack uses this) */
  accessCode?: string;
}

/**
 * Result of verifying a payment with a gateway.
 */
export interface PaymentVerifyResult {
  providerTransactionId?: string;
  providerReference?: string;
  currency?: string;
  reference?: string;
  /** Amount in Naira */
  amount: number;
  /** Payment status as reported by the gateway */
  status: 'success' | 'failed' | 'reversed' | 'pending';
  /** ISO timestamp of when payment was completed */
  paidAt: string;
  /** Payment channel (card, bank, ussd, mobile_money, etc.) */
  channel: string;
  /** Payer email */
  customerEmail: string;
  /** Gateway authorization details for recurring charges (Paystack only) */
  authorization?: {
    authorization_code: string;
    card_type: string;
    last4: string;
    exp_month: string;
    exp_year: string;
    bank: string;
  };
}

/**
 * Result of charging a saved authorization (recurring giving).
 */
export interface ChargeAuthorizationResult {
  /** Whether the charge was successful */
  success: boolean;
  /** Gateway transaction reference */
  reference: string;
  /** Amount charged in Naira */
  amount: number;
  /** ISO timestamp of when the charge was completed */
  paidAt?: string;
  /** Payment channel used */
  channel?: string;
}

/**
 * Parsed webhook event from a payment gateway.
 */
export interface WebhookEvent {
  /** Gateway-specific event name (e.g. charge.success, charge.completed) */
  event: string;
  /** Reference to identify the transaction */
  reference: string;
  /** Amount paid */
  amount?: number;
  /** Payment channel */
  channel?: string;
  /** Payer email */
  customerEmail?: string;
  /** Authorization code for recurring charges (Paystack charge.success only) */
  authorizationCode?: string;
  /** Raw event data for gateway-specific processing */
  rawData: Record<string, unknown>;
  providerTransactionId?: string;
  providerReference?: string;
  adjustment?: import('./payment-lifecycle').PaymentAdjustment;
}

/**
 * Contract for payment gateway provider implementations.
 *
 * Each gateway (Paystack, Flutterwave, etc.) must implement this interface.
 * The GivingService uses this interface to interact with any gateway
 * without knowing the specific API details.
 */
export interface PaymentGatewayProvider {
  /** Unique gateway identifier matching the PaymentGateway enum */
  readonly name: string;

  /** Whether this gateway has valid credentials configured */
  isConfigured(): boolean;

  /** Initialize a payment transaction, returning authorization details */
  initializeTransaction(
    email: string,
    amount: number,
    reference: string,
    metadata?: Record<string, unknown>,
    options?: { callbackUrl?: string; currency?: string },
  ): Promise<PaymentInitializeResult>;

  /** Verify a payment by reference */
  verifyTransaction(reference: string): Promise<PaymentVerifyResult>;

  listAdjustments?(payment: {
    reference: string;
    providerTransactionId: string;
    providerReference?: string | null;
    currency: string;
    createdAt: Date;
  }): Promise<import('./payment-lifecycle').PaymentAdjustment[]>;

  /** Validate that a webhook payload was signed by this gateway */
  validateWebhookSignature(payload: string, signature: string): boolean;

  /** Parse a raw webhook payload into a structured event */
  parseWebhookEvent(payload: string): WebhookEvent;

  /** Map a gateway event name to an internal transaction status */
  mapEventToStatus(event: string): 'success' | 'failed' | 'reversed' | null;

  /** Map a gateway payment channel to an internal payment method string */
  mapChannelToPaymentMethod(channel: string): string;

  /** Charge a saved payment authorization for recurring giving */
  chargeAuthorization?(
    authorizationCode: string,
    amount: number,
    currency: string,
    metadata?: Record<string, unknown>,
  ): Promise<ChargeAuthorizationResult>;
}

/**
 * Injection token for the payment gateway registry map.
 * Provided by GivingModule via a factory that populates
 * registered PaymentGatewayProvider instances.
 */
export const PAYMENT_GATEWAY_REGISTRY = 'PAYMENT_GATEWAY_REGISTRY';
