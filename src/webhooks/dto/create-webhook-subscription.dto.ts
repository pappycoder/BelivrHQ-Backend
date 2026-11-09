/**
 * @file create-webhook-subscription.dto.ts
 * @description DTO for creating webhook subscriptions.
 *
 * @module webhooks/dto/create-webhook-subscription.dto
 * @since 1.0.0
 */

import { IsArray, IsNotEmpty, IsString, IsOptional, IsUrl, ArrayNotEmpty } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateWebhookSubscriptionDto {
  @ApiProperty({
    description: 'URL to receive webhook payloads',
    example: 'https://example.com/webhooks/belivrhq',
  })
  @IsUrl({ protocols: ['https'], require_protocol: true, disallow_auth: true })
  @IsNotEmpty()
  url!: string;

  @ApiProperty({
    description: 'Events to subscribe to',
    example: ['member.created', 'transaction.completed'],
    type: [String],
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  events!: string[];

  @ApiPropertyOptional({
    description: 'Secret key for HMAC-SHA256 signature verification (auto-generated if omitted)',
  })
  @IsOptional()
  @IsString()
  secret?: string;
}
