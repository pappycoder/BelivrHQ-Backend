/**
 * @file list-forms.dto.ts
 * @description DTO for listing and filtering forms.
 *
 * @module forms/dto
 * @since 1.0.0
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { FormStatus } from '@prisma/client';

export class ListFormsDto {
  @ApiPropertyOptional({ description: 'Filter forms by branch' })
  @IsUUID()
  @IsOptional()
  branchId?: string;

  @ApiPropertyOptional({ description: 'Filter by form status', enum: FormStatus })
  @IsEnum(FormStatus)
  @IsOptional()
  status?: FormStatus;

  @ApiPropertyOptional({ description: 'Filter by template flag' })
  @IsBoolean()
  @Type(() => Boolean)
  @IsOptional()
  isTemplate?: boolean;

  @ApiPropertyOptional({ description: 'Search by title or description' })
  @IsString()
  @IsOptional()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ description: 'Page number', default: 1 })
  @Type(() => Number)
  @IsOptional()
  page?: number;

  @ApiPropertyOptional({ description: 'Items per page', default: 20 })
  @Type(() => Number)
  @IsOptional()
  limit?: number;

  @ApiPropertyOptional({
    description: 'List archived forms only (default: active only)',
    default: false,
  })
  @Type(() => Boolean)
  @IsOptional()
  @IsBoolean()
  archived?: boolean;

  @ApiPropertyOptional({
    description: 'Sort field (default: updatedAt desc)',
    enum: ['title', 'createdAt', 'updatedAt', 'submissionCount'],
  })
  @IsIn(['title', 'createdAt', 'updatedAt', 'submissionCount'])
  @IsOptional()
  sortBy?: 'title' | 'createdAt' | 'updatedAt' | 'submissionCount';

  @ApiPropertyOptional({ description: 'Sort direction', enum: ['asc', 'desc'], default: 'desc' })
  @IsIn(['asc', 'desc'])
  @IsOptional()
  sortOrder?: 'asc' | 'desc';
}
