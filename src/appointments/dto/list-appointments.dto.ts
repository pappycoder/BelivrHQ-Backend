/**
 * @file list-appointments.dto.ts
 * @description DTO for listing appointments with pagination and filters.
 *
 * @module appointments/dto/list-appointments.dto
 * @since 1.0.0
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsISO8601,
  IsInt,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { APPOINTMENT_STATUS } from './appointment-response.dto';

/**
 * DTO for listing appointments in the current user's scope.
 */
export class ListAppointmentsDto {
  @ApiPropertyOptional({ description: 'Filter appointments by branch' })
  @IsUUID()
  @IsOptional()
  branchId?: string;

  @ApiPropertyOptional({ description: 'Page number', default: 1, example: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number;

  @ApiPropertyOptional({ description: 'Items per page', default: 30, example: 30 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  @IsOptional()
  limit?: number;

  @ApiPropertyOptional({
    description: 'Filter by status',
    enum: APPOINTMENT_STATUS,
    example: 'confirmed',
  })
  @IsIn(APPOINTMENT_STATUS)
  @IsOptional()
  status?: string;

  @ApiPropertyOptional({
    description: 'Show archived appointments (true = archived view)',
    example: false,
  })
  @Type(() => Boolean)
  @IsBoolean()
  @IsOptional()
  archived?: boolean;

  @ApiPropertyOptional({
    description: 'Lower bound of the scheduled range (inclusive)',
    example: '2026-09-01',
  })
  @IsISO8601()
  @IsOptional()
  startDate?: string;

  @ApiPropertyOptional({
    description: 'Upper bound of the scheduled range (inclusive)',
    example: '2026-09-30',
  })
  @IsISO8601()
  @IsOptional()
  endDate?: string;

  @ApiPropertyOptional({ description: 'Search by title, location, or notes', example: 'budget' })
  @IsString()
  @IsOptional()
  search?: string;
}
