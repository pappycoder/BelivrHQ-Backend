import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Param,
  Post,
  Request,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request as ExpressRequest } from 'express';
import { GivingService } from '../giving/giving.service';
@Controller('integrations/payments/webhook')
export class PaymentCallbacksController {
  constructor(private readonly giving: GivingService) {}
  @Post(':provider')
  @HttpCode(200)
  async receive(
    @Param('provider') provider: string,
    @Headers() headers: Record<string, string>,
    @Request() req: RawBodyRequest<ExpressRequest>,
  ) {
    if (!['paystack', 'flutterwave'].includes(provider) || !req.rawBody)
      throw new BadRequestException('Unsupported payment callback');
    const payload = req.rawBody.toString('utf8');
    await this.giving.handleWebhook(
      payload,
      headers[provider === 'paystack' ? 'paystack-signature' : 'flutterwave-signature'] ??
        headers['x-paystack-signature'] ??
        headers['verif-hash'] ??
        '',
      provider,
    );
    return { received: true };
  }
}
