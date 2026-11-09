/**
 * @file DTO for recording cash/bank transfer giving.
 * @module giving/dto/record-cash.dto
 * @since 1.0.0
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  Matches,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';

export class RecordCashDto {
  @ApiPropertyOptional({
    description: 'Giving date (YYYY-MM-DD); defaults to today',
    example: '2026-10-18',
  })
  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  givingDate?: string;
  @ApiPropertyOptional({ description: 'Cell group meeting date (YYYY-MM-DD)' })
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsOptional()
  cellGroupMeetingDate?: string;
  @ApiPropertyOptional({ description: 'Cell group this giving belongs to' })
  @IsUUID()
  @IsOptional()
  cellGroupId?: string;
  @ApiProperty({
    description: 'Giving category ID',
    example: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  })
  @IsUUID()
  @IsNotEmpty()
  categoryId!: string;

  @ApiProperty({ description: 'Amount in Naira', example: 10000 })
  @IsNumber()
  @Min(1)
  amount!: number;

  @ApiProperty({
    description: 'Transaction type',
    enum: ['cash', 'bank_transfer'],
    example: 'cash',
  })
  @IsEnum(['cash', 'bank_transfer'] as const)
  @IsNotEmpty()
  type!: 'cash' | 'bank_transfer';

  @ApiPropertyOptional({
    description: 'Member ID',
    example: '11111111-1111-1111-1111-111111111111',
  })
  @IsUUID()
  @IsOptional()
  memberId?: string;

  @ApiPropertyOptional({
    description: 'Branch ID',
    example: '33333333-3333-3333-3333-333333333333',
  })
  @IsUUID()
  @IsOptional()
  branchId?: string;

  @ApiPropertyOptional({
    description: 'Service ID: tags the gift against a church service',
  })
  @IsUUID()
  @IsOptional()
  serviceId?: string;

  @ApiPropertyOptional({
    description: 'Event ID: tags the gift against a church event',
  })
  @IsUUID()
  @IsOptional()
  eventId?: string;

  @ApiPropertyOptional({ description: 'Notes', example: 'Cash offering from Sunday service' })
  @IsString()
  @IsOptional()
  notes?: string;

  @ApiPropertyOptional({ description: 'Currency', default: 'NGN' })
  @IsString()
  @IsOptional()
  currency?: string;
}
