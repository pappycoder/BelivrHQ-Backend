/**
 * @file DTO for transaction responses.
 * @module giving/dto/transaction-response.dto
 * @since 1.0.0
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class TransactionResponseDto {
  @ApiProperty({ description: 'Payment held for review after a partial refund or dispute' })
  paymentReview!: boolean;
  @ApiProperty({ description: 'Total completed refunds in the original payment currency' })
  refundedAmount!: number;
  @ApiProperty({ description: 'Giving source', enum: ['normal', 'cell_group'] })
  givingType!: string;
  @ApiPropertyOptional({ description: 'Giving record title' })
  title?: string;
  @ApiPropertyOptional({ description: 'Giving record description' })
  description?: string;
  @ApiPropertyOptional({ description: 'Cell group that recorded the giving' })
  cellGroupId?: string;
  @ApiPropertyOptional({ description: 'Cell group name at the time of recording' })
  cellGroupName?: string;
  @ApiPropertyOptional({ description: 'Cell group meeting date' })
  cellGroupMeetingDate?: string;
  @ApiProperty({ description: 'Transaction ID', example: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' })
  transactionId!: string;

  @ApiProperty({ description: 'Church ID' })
  churchId!: string;

  @ApiPropertyOptional({ description: 'Branch ID' })
  branchId?: string;

  @ApiPropertyOptional({ description: 'Giving branch name' })
  branchName?: string;

  @ApiPropertyOptional({ description: 'Member ID' })
  memberId?: string;

  @ApiPropertyOptional({ description: 'Member full name', example: 'Chioma Eze' })
  memberName?: string;

  @ApiPropertyOptional({ description: 'Linked service ID' })
  serviceId?: string;

  @ApiPropertyOptional({ description: 'Linked service name', example: 'Sunday First Service' })
  serviceName?: string;

  @ApiPropertyOptional({ description: 'Linked event ID' })
  eventId?: string;

  @ApiPropertyOptional({ description: 'Linked event title', example: 'Harvest 2026' })
  eventName?: string;

  @ApiProperty({ description: 'Category ID' })
  categoryId!: string;

  @ApiProperty({ description: 'Category name', example: 'Tithe' })
  categoryName!: string;

  @ApiProperty({ description: 'Amount', example: 5000 })
  amount!: number;

  @ApiProperty({ description: 'Currency', example: 'NGN' })
  currency!: string;

  @ApiProperty({ description: 'Transaction type', enum: ['digital', 'cash', 'bank_transfer'] })
  type!: string;

  @ApiProperty({
    description: 'Transaction status',
    enum: ['pending', 'success', 'failed', 'reversed'],
  })
  status!: string;

  @ApiPropertyOptional({ description: 'Payment reference', example: 'TITHSEED17000000001' })
  paymentReference?: string;

  @ApiProperty({
    description: 'Payment gateway used',
    enum: ['paystack', 'flutterwave', 'manual'],
    example: 'paystack',
  })
  paymentGateway!: string;

  @ApiPropertyOptional({ description: 'Payment method/channel', example: 'card' })
  paymentMethod?: string;

  @ApiPropertyOptional({ description: 'Receipt number', example: 'GCC/TIT/2026/0001' })
  receiptNumber?: string;

  @ApiPropertyOptional({ description: 'Receipt URL' })
  receiptUrl?: string;

  @ApiPropertyOptional({ description: 'Additional notes' })
  notes?: string;

  @ApiProperty({ description: 'Creation date', example: '2026-07-20T10:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ description: 'Giving date (YYYY-MM-DD)' })
  givingDate!: string;

  @ApiProperty({ description: 'Last update date', example: '2026-07-20T10:00:00.000Z' })
  updatedAt!: string;
}
