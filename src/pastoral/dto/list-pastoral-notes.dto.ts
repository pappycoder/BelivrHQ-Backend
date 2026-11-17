import { QueryBoolean } from '../../common/decorators/query-boolean.decorator';
/**
 * @file list-pastoral-notes.dto.ts
 * @description DTO for listing pastoral notes with pagination and filters.
 *
 * Supports filtering by member ID, author ID, confidentiality level,
 * and tags. All queries are scoped by church_id.
 *
 * @module pastoral/dto/list-pastoral-notes.dto
 * @since 1.0.0
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsInt, Min, Max, IsEnum, IsArray, IsBoolean } from 'class-validator';

export class ListPastoralNotesDto {
  // Default page number starting at 1
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  // Page size capped between 1 and 100
  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  // Optional member ID filter
  @ApiPropertyOptional({ description: 'Filter by member ID' })
  @IsOptional()
  @IsString()
  memberId?: string;

  // Optional author ID filter
  @ApiPropertyOptional({ description: 'Filter by author ID' })
  @IsOptional()
  @IsString()
  authorId?: string;

  // Optional confidentiality level filter
  @ApiPropertyOptional({
    description: 'Filter by confidentiality level',
    enum: ['standard', 'confidential', 'restricted'],
  })
  @IsOptional()
  @IsEnum(['standard', 'confidential', 'restricted'])
  confidentiality?: 'standard' | 'confidential' | 'restricted';

  // Optional tags filter (AND logic — all specified tags must be present)
  @ApiPropertyOptional({
    description: 'Filter by tags (notes must contain ALL specified tags)',
    example: ['prayer', 'counseling'],
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  // Sort field defaults to created_at
  @ApiPropertyOptional({
    description: 'Sort by field',
    enum: ['created_at', 'updated_at'],
    default: 'created_at',
  })
  @IsOptional()
  @IsString()
  sortBy?: string;

  // Sort direction defaults to descending
  @ApiPropertyOptional({
    description: 'Sort direction',
    enum: ['asc', 'desc'],
    default: 'desc',
  })
  @IsOptional()
  @IsString()
  sortOrder?: 'asc' | 'desc';

  // List archived notes only when true (default: active only)
  @ApiPropertyOptional({
    description: 'List archived records only (default: active only)',
    default: false,
  })
  @QueryBoolean()
  @IsOptional()
  @IsBoolean()
  archived?: boolean;
}
