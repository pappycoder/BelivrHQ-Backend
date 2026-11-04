/**
 * @file DTO for creating an event.
 * @module events/dto/create-event.dto
 * @since 1.0.0
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';

/** Recurrence modes an event supports. */
export const EVENT_RECURRENCES = ['one_time', 'weekly', 'multi_day'] as const;
export type EventRecurrence = (typeof EVENT_RECURRENCES)[number];

export class CreateEventDto {
  @ApiProperty({ description: 'Event title', example: 'Sunday Worship Service' })
  @IsString()
  @IsNotEmpty()
  title!: string;

  @ApiPropertyOptional({
    description: 'Event description',
    example: 'Weekly Sunday worship service with communion.',
  })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({
    description: 'Event type',
    enum: ['service', 'conference', 'lifecycle', 'training', 'social'],
    default: 'service',
  })
  @IsEnum(['service', 'conference', 'lifecycle', 'training', 'social'] as const)
  @IsOptional()
  type?: string;

  @ApiProperty({
    description: 'Start date and time (ISO 8601)',
    example: '2026-08-01T09:00:00.000Z',
  })
  @IsDateString()
  @IsNotEmpty()
  startDate!: string;

  @ApiPropertyOptional({
    description: 'End date and time (ISO 8601)',
    example: '2026-08-01T12:00:00.000Z',
  })
  @IsDateString()
  @IsOptional()
  endDate?: string;

  @ApiPropertyOptional({
    description:
      'How the event repeats: one_time (default, exactly the start day), weekly (same weekday as startDate, through endDate when set) or multi_day (every day in the start…end window)',
    enum: EVENT_RECURRENCES,
    default: 'one_time',
  })
  @IsOptional()
  @IsIn(EVENT_RECURRENCES)
  recurrence?: EventRecurrence;

  @ApiPropertyOptional({ description: 'Event location', example: 'Main Auditorium' })
  @IsString()
  @IsOptional()
  location?: string;

  @ApiPropertyOptional({ description: 'Maximum capacity (null = unlimited)', example: 200 })
  @IsInt()
  @Min(1)
  @IsOptional()
  capacity?: number;

  @ApiPropertyOptional({ description: 'Whether the event is free', default: true })
  @IsBoolean()
  @IsOptional()
  isFree?: boolean;

  @ApiPropertyOptional({ description: 'Ticket price in Naira (only if not free)', example: 5000 })
  @IsInt()
  @Min(0)
  @IsOptional()
  price?: number;

  @ApiPropertyOptional({
    description: 'Branch ID (null = church-wide)',
    example: '33333333-3333-3333-3333-333333333333',
  })
  @IsUUID()
  @IsOptional()
  branchId?: string;

  @ApiPropertyOptional({
    description: 'Custom registration fields (JSON array)',
    example: [{ name: 'dietary_requirements', type: 'text', required: false }],
  })
  @IsOptional()
  registrationFields?: Record<string, unknown>[];
}
