import { Transform } from 'class-transformer';
import { IsString, MinLength, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RetryWebhookDeliveryDto {
  @ApiProperty({
    description: 'Operator review reason; external delivery may already have occurred',
    minLength: 10,
    maxLength: 500,
  })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;
}
