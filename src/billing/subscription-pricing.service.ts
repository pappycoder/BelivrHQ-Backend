import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
import { RedisService } from '../redis/redis.service';
import { SUBSCRIPTION_PLANS, PLAN_CAPACITIES } from './plans';

export const PRICING_CURRENCIES = [
  'USD',
  'NGN',
  'EUR',
  'GBP',
  'CAD',
  'GHS',
  'KES',
  'ZAR',
  'UGX',
  'XAF',
  'XOF',
] as const;
export type PricingCurrency = (typeof PRICING_CURRENCIES)[number];
interface RateData {
  updatedAt: string;
  expiresAt: number;
  rates: Record<string, number>;
}
export interface LockedQuote {
  plan: string;
  cycle: string;
  gateway: string;
  currency: string;
  amount: number;
  usdAmount: number;
  exchangeRate: number;
  rateUpdatedAt: string | null;
  intent: string;
  effectiveAt: string;
  renewBy: string;
  credit: number;
  expiresAt: string;
  base: { plan: string; cycle: string; paidUntil: string | null; periodStartedAt: string | null };
}
/** Decimal arithmetic avoids accidentally rounding an exact whole-unit price up again. */
export function convertedPrice(usd: number, rate: number): number {
  const result = new Prisma.Decimal(usd).mul(rate).ceil().toNumber();
  if (!Number.isSafeInteger(result) || result <= 0 || result > 2147483647)
    throw new BadRequestException('The converted price is outside the supported payment range.');
  return result;
}
@Injectable()
export class SubscriptionPricingService {
  private readonly logger = new Logger(SubscriptionPricingService.name);
  private cachedRates?: RateData;
  private inflight?: Promise<RateData>;
  constructor(
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  currency(value: string): PricingCurrency {
    if (!PRICING_CURRENCIES.includes(value as PricingCurrency))
      throw new BadRequestException('Choose a supported subscription currency.');
    return value as PricingCurrency;
  }
  gatewayCurrencies(gateway: string): string[] {
    const supported =
      gateway === 'paystack' ? ['NGN', 'USD', 'GHS', 'KES', 'ZAR'] : PRICING_CURRENCIES;
    const key =
      gateway === 'paystack'
        ? 'SUBSCRIPTION_PAYSTACK_CURRENCIES'
        : 'SUBSCRIPTION_FLUTTERWAVE_CURRENCIES';
    // Enable only currencies approved on the platform merchant account. Existing accounts charge NGN.
    const configured = this.config.get<string>(key, 'NGN');
    return configured
      .split(',')
      .map((c) => c.trim().toUpperCase())
      .filter((c, i, all) => supported.includes(c as PricingCurrency) && all.indexOf(c) === i);
  }
  assertGatewayCurrency(gateway: string, currency: string) {
    this.currency(currency);
    if (!this.gatewayCurrencies(gateway).includes(currency))
      throw new BadRequestException(
        'This gateway is not enabled for that currency. Choose an available payment currency.',
      );
  }
  private async rates(): Promise<RateData> {
    if (this.validRates(this.cachedRates)) return this.cachedRates;
    if (!this.inflight)
      this.inflight = this.loadRates().finally(() => {
        this.inflight = undefined;
      });
    try {
      return await this.inflight;
    } catch {
      throw new ServiceUnavailableException(
        'Currency conversion is temporarily unavailable. You can select USD or try again later.',
      );
    }
  }
  private validRates(value: unknown): value is RateData {
    if (!value || typeof value !== 'object') return false;
    const data = value as RateData;
    const updated = Date.parse(data.updatedAt);
    return (
      Number.isFinite(updated) &&
      updated <= Date.now() + 300000 &&
      Date.now() - updated <= 172800000 &&
      Number.isFinite(data.expiresAt) &&
      data.expiresAt > Date.now() &&
      data.rates?.USD === 1 &&
      PRICING_CURRENCIES.every((currency) => {
        const rate = data.rates[currency];
        return Number.isFinite(rate) && rate > 0 && rate <= 1e8;
      })
    );
  }
  private async loadRates(): Promise<RateData> {
    try {
      const cached = await this.redis.get<RateData>('subscription:fx:usd:v1');
      if (this.validRates(cached)) {
        this.cachedRates = cached;
        return cached;
      }
    } catch {
      this.logger.warn('FX cache read failed; fetching validated provider rates');
    }
    const result = await this.fetchRates();
    this.cachedRates = result;
    try {
      await this.redis.set(
        'subscription:fx:usd:v1',
        result,
        Math.max(1, Math.floor((result.expiresAt - Date.now()) / 1000)),
      );
    } catch {
      this.logger.warn('FX cache write failed; using validated in-process rates');
    }
    return result;
  }
  private async fetchRates(): Promise<RateData> {
    const response = await fetch('https://open.er-api.com/v6/latest/USD', {
      signal: AbortSignal.timeout(8000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error('FX provider unavailable');
    const body = (await response.json()) as {
      result: string;
      base_code: string;
      time_last_update_unix: number;
      time_next_update_unix: number;
      rates: Record<string, number>;
    };
    const updated = body.time_last_update_unix * 1000;
    if (
      body.result !== 'success' ||
      body.base_code !== 'USD' ||
      !Number.isFinite(updated) ||
      updated > Date.now() + 300000 ||
      Date.now() - updated > 172800000
    )
      throw new Error('Invalid or stale rates');
    for (const currency of PRICING_CURRENCIES) {
      const rate = body.rates?.[currency];
      if (!Number.isFinite(rate) || rate <= 0 || rate > 1e8) throw new Error('Invalid rate');
    }
    if (body.rates.USD !== 1) throw new Error('Invalid base');
    const next = body.time_next_update_unix * 1000;
    const expiresAt = Math.min(
      updated + 172800000,
      Math.max(Date.now() + 3600000, Number.isFinite(next) ? next : Date.now() + 3600000),
    );
    const result = { updatedAt: new Date(updated).toISOString(), expiresAt, rates: body.rates };
    return result;
  }
  async exchange(currency: string) {
    this.currency(currency);
    if (currency === 'USD') return { rate: 1, updatedAt: null };
    const rates = await this.rates();
    return { rate: rates.rates[currency], updatedAt: rates.updatedAt };
  }
  async catalog(currency: string = 'USD') {
    const { rate, updatedAt } = await this.exchange(currency);
    return {
      baseCurrency: 'USD',
      currency,
      rateUpdatedAt: updatedAt,
      currencies: PRICING_CURRENCIES,
      plans: Object.entries(SUBSCRIPTION_PLANS).map(([id, price]) => ({
        id,
        name: price.name,
        monthly: convertedPrice(price.monthly, rate),
        annual: convertedPrice(price.annual, rate),
        baseMonthly: price.monthly,
        baseAnnual: price.annual,
        limits: PLAN_CAPACITIES[id as keyof typeof PLAN_CAPACITIES],
      })),
    };
  }
  async saveQuote(churchId: string, payload: LockedQuote) {
    const id = `BHQQUOTE_${randomBytes(16).toString('hex')}`;
    try {
      await this.redis.set(`subscription:quote:${churchId}:${id}`, payload, 900);
    } catch {
      throw new ServiceUnavailableException(
        'Unable to prepare your payment quote. Please try again.',
      );
    }
    return id;
  }
  async getQuote(churchId: string, id?: string): Promise<LockedQuote> {
    if (!id) throw new BadRequestException('Review a fresh payment quote before checkout.');
    let quote: LockedQuote | null;
    try {
      quote = await this.redis.get<LockedQuote>(`subscription:quote:${churchId}:${id}`);
    } catch {
      throw new ServiceUnavailableException(
        'Unable to retrieve your payment quote. Please try again.',
      );
    }
    if (!quote || Date.parse(quote.expiresAt) <= Date.now())
      throw new BadRequestException(
        'Your payment quote expired. Review a new quote before paying.',
      );
    return quote;
  }
}
