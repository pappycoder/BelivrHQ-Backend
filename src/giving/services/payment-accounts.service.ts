import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntegrationAccountsService } from '../../integrations/integration-accounts.service';
import { PaystackService } from './paystack.service';
import { FlutterwaveService } from './flutterwave.service';
import { PaymentGatewayProvider } from './payment-gateway.interface';
@Injectable()
export class PaymentAccountsService {
  constructor(
    private readonly accounts: IntegrationAccountsService,
    private readonly config: ConfigService = new ConfigService(),
  ) {}
  private gateway(name: string, credentials: Record<string, string>): PaymentGatewayProvider {
    if (!['paystack', 'flutterwave'].includes(name))
      throw new BadRequestException('Unsupported payment gateway');
    if (typeof credentials.secretKey !== 'string' || !credentials.secretKey.trim())
      throw new BadRequestException('Church merchant credentials are missing');
    const provider =
      name === 'paystack'
        ? new PaystackService(
            new ConfigService({
              PAYSTACK_SECRET_KEY: credentials.secretKey,
              PAYSTACK_WEBHOOK_SECRET: credentials.webhookSecret,
            }),
          )
        : new FlutterwaveService(
            new ConfigService({
              FLUTTERWAVE_SECRET_KEY: credentials.secretKey,
              FLUTTERWAVE_WEBHOOK_SECRET: credentials.webhookSecret ?? '',
              WEB_URL: this.config.get<string>('WEB_URL', 'http://localhost:3000'),
            }),
          );
    if (!provider.isConfigured())
      throw new BadRequestException('Payment gateway is not configured');
    return provider;
  }
  async defaultGateway(churchId: string): Promise<string | null> {
    return (await this.accounts.resolve(churchId, 'payment'))?.provider ?? null;
  }
  async current(churchId: string, name: string) {
    const account = await this.accounts.resolve(churchId, 'payment');
    if (!account) throw new BadRequestException('Configure a church payment account first');
    if (account.provider !== name)
      throw new BadRequestException('This gateway is not enabled for the church');
    return { provider: this.gateway(name, account.credentials), accountId: account.accountId };
  }
  async historical(churchId: string, name: string, id?: string | null) {
    if (!id) throw new BadRequestException('A church payment account is required');
    const account = await this.accounts.account(churchId, id, true);
    if (account.provider !== name)
      throw new BadRequestException('Payment account does not match gateway');
    return this.gateway(name, account.credentials);
  }
}
