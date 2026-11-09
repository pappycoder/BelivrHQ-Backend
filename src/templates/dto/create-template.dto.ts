/**
 * @file create-template.dto.ts
 * @description DTO for creating a new message template.
 *
 * @module templates/dto/create-template.dto
 * @since 1.0.0
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsIn, IsArray, IsUUID } from 'class-validator';

export class CreateTemplateDto {
  @ApiPropertyOptional({ description: 'Branch that owns this template' })
  @IsUUID()
  @IsOptional()
  branchId?: string;

  @ApiProperty({ example: 'Welcome Message' })
  @IsString()
  name!: string;

  @ApiProperty({ example: 'Hello {{name}}, welcome to {{church}}!' })
  @IsString()
  content!: string;

  @ApiProperty({ enum: ['whatsapp', 'sms', 'email'], example: 'whatsapp' })
  @IsString()
  @IsIn(['whatsapp', 'sms', 'email'])
  channel!: string;

  @ApiPropertyOptional({ example: 'en' })
  @IsOptional()
  @IsString()
  language?: string;

  @ApiPropertyOptional({
    description: 'WhatsApp template category (WhatsApp only)',
    enum: ['MARKETING', 'UTILITY', 'AUTHENTICATION'],
    example: 'MARKETING',
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
    description: 'Initial status of the template. Defaults to "draft" if omitted.',
    enum: ['draft', 'published'],
    example: 'draft',
  })
  @IsOptional()
  @IsString()
  @IsIn(['draft', 'published'])
  status?: string;

  @ApiPropertyOptional({
    description: 'External template ID/name from WhatsApp (e.g. namespace:template_name)',
    example: 'belivrhq:welcome_message',
  })
  @IsOptional()
  @IsString()
  externalId?: string;
}
