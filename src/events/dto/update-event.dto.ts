/**
 * @file DTO for updating an event.
 * @module events/dto/update-event.dto
 * @since 1.0.0
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';
import { EVENT_RECURRENCES, type EventRecurrence } from './create-event.dto';

export class UpdateEventDto {
  @ApiPropertyOptional({ description: 'Event title', example: 'Sunday Worship Service' })
  @IsString()
  @IsOptional()
  title?: string;

  @ApiPropertyOptional({ description: 'Event description' })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({
    description: 'Event type',
    enum: ['service', 'conference', 'lifecycle', 'training', 'social'],
  })
  @IsEnum(['service', 'conference', 'lifecycle', 'training', 'social'] as const)
  @IsOptional()
  type?: string;

  @ApiPropertyOptional({ description: 'Start date and time (ISO 8601)' })
  @IsDateString()
  @IsOptional()
  startDate?: string;

  @ApiPropertyOptional({ description: 'End date and time (ISO 8601)' })
  @IsDateString()
  @IsOptional()
  endDate?: string;

  @ApiPropertyOptional({
    description: 'How the event repeats',
    enum: EVENT_RECURRENCES,
  })
  @IsOptional()
  @IsIn(EVENT_RECURRENCES)
  recurrence?: EventRecurrence;

  @ApiPropertyOptional({ description: 'Event location' })
  @IsString()
  @IsOptional()
  location?: string;

  @ApiPropertyOptional({ description: 'Maximum capacity' })
  @IsInt()
  @Min(1)
  @IsOptional()
  capacity?: number;

  @ApiPropertyOptional({ description: 'Whether the event is free' })
  @IsBoolean()
  @IsOptional()
  isFree?: boolean;

  @ApiPropertyOptional({ description: 'Ticket price in Naira' })
  @IsInt()
  @Min(0)
  @IsOptional()
  price?: number;

  @ApiPropertyOptional({ description: 'Branch ID' })
  @IsUUID()
  @IsOptional()
  branchId?: string;

  @ApiPropertyOptional({ description: 'Custom registration fields (JSON array)' })
  @IsOptional()
  registrationFields?: Record<string, unknown>[];
}
