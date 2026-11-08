/**
 * @file list-attendance.dto.ts
 * @description DTO for listing and filtering attendance records.
 *
 * @module attendance/dto/list-attendance.dto
 * @since 1.0.0
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ATTENDANCE_CATEGORIES } from './create-service.dto';

/**
 * DTO for listing attendance records with pagination and filters.
 */
export class ListAttendanceDto {
  @ApiPropertyOptional({ description: 'Case-insensitive search', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({ description: 'Filter attendance by branch' })
  @IsUUID()
  @IsOptional()
  branchId?: string;

  @ApiPropertyOptional({ description: 'Page number', default: 1, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number;

  @ApiPropertyOptional({ description: 'Items per page', default: 20, minimum: 1, maximum: 200 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  @IsOptional()
  limit?: number;

  @ApiPropertyOptional({ description: 'Filter by service ID' })
  @IsString()
  @IsOptional()
  serviceId?: string;

  @ApiPropertyOptional({ description: 'Filter by event ID' })
  @IsString()
  @IsOptional()
  eventId?: string;

  @ApiPropertyOptional({ description: 'Filter by member ID' })
  @IsString()
  @IsOptional()
  memberId?: string;

  @ApiPropertyOptional({ description: 'Filter by linked visitor ID' })
  @IsString()
  @IsOptional()
  visitorId?: string;

  @ApiPropertyOptional({ description: 'Filter by category', enum: ATTENDANCE_CATEGORIES })
  @IsOptional()
  @IsIn(ATTENDANCE_CATEGORIES)
  category?: string;

  @ApiPropertyOptional({
    description: 'Filter by check-in source',
    enum: ['manual', 'whatsapp', 'qr'],
  })
  @IsOptional()
  @IsIn(['manual', 'whatsapp', 'qr'])
  source?: string;

  @ApiPropertyOptional({ description: 'Check-ins from this date (ISO 8601)' })
  @IsISO8601()
  @IsOptional()
  startDate?: string;

  @ApiPropertyOptional({ description: 'Check-ins up to this date (ISO 8601)' })
  @IsISO8601()
  @IsOptional()
  endDate?: string;

  @ApiPropertyOptional({ description: 'Sort field', enum: ['checkinAt', 'createdAt'] })
  @IsOptional()
  @IsIn(['checkinAt', 'createdAt'])
  sortBy?: string;

  @ApiPropertyOptional({ description: 'Sort order', enum: ['asc', 'desc'], default: 'desc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc';
}
