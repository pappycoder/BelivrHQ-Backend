/**
 * @file update-template.dto.ts
 * @description DTO for updating an existing message template.
 *
 * All fields are optional — only provided fields are updated.
 *
 * @module templates/dto/update-template.dto
 * @since 1.0.0
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsUUID, IsOptional, IsIn, IsArray } from 'class-validator';

export class UpdateTemplateDto {
  @ApiPropertyOptional({ description: 'Branch that owns this record' })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  content?: string;

  @ApiPropertyOptional({ enum: ['whatsapp', 'sms', 'email'] })
  @IsOptional()
  @IsString()
  @IsIn(['whatsapp', 'sms', 'email'])
  channel?: string;

  @ApiPropertyOptional({ enum: ['draft', 'published', 'archived'] })
  @IsOptional()
  @IsString()
  @IsIn(['draft', 'published', 'archived'])
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  language?: string;

  @ApiPropertyOptional({
    description: 'WhatsApp template category (WhatsApp only)',
    enum: ['MARKETING', 'UTILITY', 'AUTHENTICATION'],
  })
  @IsOptional()
  @IsString()
  @IsIn(['MARKETING', 'UTILITY', 'AUTHENTICATION'])
  category?: string;

  @ApiPropertyOptional({
    description: 'Variable names used in the template content',
    example: ['name', 'church'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  variables?: string[];

  @ApiPropertyOptional({
    description: 'External template ID/name from WhatsApp',
    example: 'belivrhq:welcome_message',
  })
  @IsOptional()
  @IsString()
  externalId?: string;

  @ApiPropertyOptional({
    description: 'External approval status from WhatsApp',
    enum: ['APPROVED', 'PENDING', 'REJECTED'],
  })
  @IsOptional()
  @IsString()
  @IsIn(['APPROVED', 'PENDING', 'REJECTED'])
  externalStatus?: string;
}
