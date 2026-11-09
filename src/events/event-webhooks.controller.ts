import { GivingService } from '../giving/giving.service';
/**
 * @file event-webhooks.controller.ts
 * @description Public, signature-verified payment webhooks for event tickets.
 */

import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { RawBodyRequest } from '@nestjs/common';
import { Request } from 'express';
import { SkipRateLimit } from '../common/guards/rate-limit.guard';

@ApiTags('Events')
@Controller('events')
export class EventWebhooksController {
  constructor(private readonly giving: GivingService) {}

  @Post(':eventId/webhook/paystack')
  @SkipRateLimit()
  @HttpCode(HttpStatus.OK)
  @ApiHeader({ name: 'x-paystack-signature', description: 'Paystack HMAC-SHA512 signature' })
  @ApiOperation({
    summary: 'Paystack event-ticket webhook',
    description: 'Validates the provider signature and settles the matching event registration.',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID (not trusted for tenant resolution)' })
  async handlePaystackWebhook(
    @Param('eventId') _eventId: string,
    @Headers() headers: Record<string, string>,
    @Req() request: RawBodyRequest<Request>,
  ): Promise<{ received: boolean }> {
    const rawBody = request.rawBody?.toString('utf8');
    if (!rawBody) {
      throw new BadRequestException('Missing raw webhook payload');
    }

    await this.giving.handleWebhook(
      rawBody,
      headers['paystack-signature'] ?? headers['x-paystack-signature'] ?? '',
      'paystack',
    );

    return { received: true };
  }
}
