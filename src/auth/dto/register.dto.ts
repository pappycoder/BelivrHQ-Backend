import { Transform } from 'class-transformer';
import { SubscriptionPlan, BillingCycle } from '@prisma/client';
/**
 * @file register.dto.ts
 * @description DTO for user registration endpoint.
 *
 * Validates all required fields for creating a new church admin account.
 * Includes email/password for Supabase Auth, personal details, and church name.
 *
 * @module auth/dto/register
 * @since 1.0.0
 */

import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MinLength,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RegisterDto {
  @ApiPropertyOptional({
    description: 'Explicit agreement to the published website and service terms',
  })
  @IsOptional()
  // Preserve the actual declaration: implicit Boolean('false') must not become consent.
  @Transform(({ obj }: { obj: { termsAccepted?: unknown } }) => obj.termsAccepted, {
    toClassOnly: true,
  })
  @IsBoolean()
  termsAccepted?: boolean;

  @ApiPropertyOptional({
    description: 'Version of the terms explicitly accepted during registration',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  acceptedTermsVersion?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  churchAddress?: string;
  @IsOptional()
  @IsIn([SubscriptionPlan.essentials, SubscriptionPlan.community, SubscriptionPlan.network])
  plan?: Exclude<SubscriptionPlan, 'enterprise'>;
  @IsOptional()
  @IsEnum(BillingCycle)
  billingCycle?: BillingCycle;

  @ApiProperty({
    description: 'Admin email address',
    example: 'pastor@demo.com',
  })
  @IsEmail()
  @IsNotEmpty()
  email!: string;

  @ApiProperty({
    description: 'User password (minimum 8 characters)',
    example: 'BelivrHQ2026!',
    minLength: 8,
  })
  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters long' })
  @IsNotEmpty()
  password!: string;

  @ApiProperty({
    description: 'Admin first name',
    example: 'Adebayo',
  })
  @IsString()
  @IsNotEmpty()
  firstName!: string;

  @ApiProperty({
    description: 'Admin last name',
    example: 'Ogundimu',
  })
  @IsString()
  @IsNotEmpty()
  lastName!: string;

  @ApiPropertyOptional({
    description: 'Phone number (Nigerian format)',
    example: '+234 803 456 7890',
  })
  @IsString()
  @IsOptional()
  phone?: string;

  @ApiProperty({
    description: 'Church name',
    example: 'Grace Community Church',
  })
  @IsString()
  @IsNotEmpty()
  churchName!: string;

  @ApiPropertyOptional({
    description: 'Church denomination',
    example: 'Pentecostal',
  })
  @IsString()
  @IsOptional()
  denomination?: string;
}
