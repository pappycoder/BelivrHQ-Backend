/**
 * @file template-response.dto.ts
 * @description Response DTO for message template data.
 *
 * @module templates/dto/template-response.dto
 * @since 1.0.0
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class TemplateResponseDto {
  @ApiPropertyOptional({ description: 'Assigned branch ID' })
  branchId?: string;

  @ApiPropertyOptional({ description: 'Assigned branch name' })
  branchName?: string;

  @ApiProperty({ description: 'Unique identifier for the message template' })
  templateId!: string;

  @ApiProperty({ description: 'Identifier of the church that owns this template' })
  churchId!: string;

  @ApiProperty({ description: 'Name or title of the template' })
  name!: string;

  @ApiProperty({
    description: 'Body content of the message template, may include variable placeholders',
  })
  content!: string;

  @ApiProperty({
    description: 'Delivery channel the template is designed for (e.g. whatsapp, sms, email)',
  })
  channel!: string;

  @ApiProperty({ description: 'Language code the template is written in' })
  language!: string;

  @ApiProperty({ description: 'Current status of the template (e.g. draft, published)' })
  status!: string;

  @ApiPropertyOptional({ description: 'Optional category used to group related templates' })
  category?: string;

  @ApiPropertyOptional({
    example: ['name', 'church'],
    description: 'List of placeholder variable names supported by the template',
  })
  variables?: string[];

  @ApiPropertyOptional({
    description: 'External provider identifier when the template is synced externally',
  })
  externalId?: string;

  @ApiPropertyOptional({ description: 'Approval or sync status reported by the external provider' })
  externalStatus?: string;

  @ApiPropertyOptional({
    description: 'Archive timestamp: set when the template is archived',
    example: '2026-08-28T10:30:00.000Z',
  })
  archivedAt?: string;

  @ApiProperty({ description: 'ISO 8601 timestamp when the template was created' })
  createdAt!: string;

  @ApiProperty({ description: 'ISO 8601 timestamp when the template was last updated' })
  updatedAt!: string;
}
