/**
 * @file form-response.dto.ts
 * @description Response DTOs for forms and submissions.
 *
 * @module forms/dto
 * @since 1.0.0
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { FormStatus, SubmissionStatus } from '@prisma/client';
import { FormFieldDto } from './form-field.dto';

/**
 * Attachment metadata stored on a form submission.
 */
export class SubmissionAttachmentDto {
  @ApiProperty({ description: 'Media asset ID', example: '11111111-1111-1111-1111-111111111111' })
  assetId!: string;

  @ApiProperty({ description: 'Public URL of the file' })
  url!: string;

  @ApiProperty({ description: 'File name' })
  filename!: string;

  @ApiProperty({ description: 'MIME type' })
  mimeType!: string;
}

/**
 * Response shape for a single form.
 */
export class FormResponseDto {
  @ApiPropertyOptional({ description: 'Owning church name' })
  churchName?: string;
  @ApiPropertyOptional({ description: 'Owning church logo; use app logo only when absent' })
  churchLogoUrl?: string;
  @ApiPropertyOptional({ description: 'Assigned branch ID' })
  branchId?: string;

  @ApiPropertyOptional({ description: 'Assigned branch name' })
  branchName?: string;

  @ApiProperty({ description: 'Form ID' })
  id!: string;

  @ApiProperty({ description: 'Church ID' })
  churchId!: string;

  @ApiProperty({ description: 'Form title' })
  title!: string;

  @ApiPropertyOptional({ description: 'Form description' })
  description?: string;

  @ApiProperty({ description: 'Field definitions', type: [FormFieldDto] })
  @Type(() => FormFieldDto)
  fields!: FormFieldDto[];

  @ApiProperty({ description: 'Form status', enum: FormStatus })
  status!: FormStatus;

  @ApiProperty({ description: 'Whether this form is a reusable template' })
  isTemplate!: boolean;

  @ApiProperty({ description: 'Whether public submissions are enabled' })
  isPublic!: boolean;

  @ApiPropertyOptional({ description: 'Public submission token' })
  publicToken?: string;

  @ApiPropertyOptional({
    description: 'Field key used to detect duplicate public submissions',
  })
  uniqueField?: string;

  @ApiProperty({ description: 'Maximum submissions (0 = unlimited)', default: 0 })
  submissionLimit!: number;

  @ApiProperty({ description: 'Number of submissions received for this form', default: 0 })
  submissionCount!: number;

  @ApiPropertyOptional({ description: 'Set when the form is archived' })
  archivedAt?: string;

  @ApiProperty({ description: 'Creation timestamp' })
  createdAt!: Date;

  @ApiProperty({ description: 'Last update timestamp' })
  updatedAt!: Date;
}

/**
 * Response shape for the public-facing metadata used to render a form for
 * anonymous respondents, including public church branding but no submissions.
 */
export class PublicFormMetaDto {
  @ApiPropertyOptional({ description: 'Owning church name' })
  churchName?: string;
  @ApiPropertyOptional({ description: 'Owning church logo; use app logo only when absent' })
  churchLogoUrl?: string;
  @ApiProperty({ description: 'Form title' })
  title!: string;

  @ApiPropertyOptional({ description: 'Form description' })
  description?: string;

  @ApiProperty({ description: 'Field definitions', type: [FormFieldDto] })
  @Type(() => FormFieldDto)
  fields!: FormFieldDto[];
}

/**
 * Response shape for a single form submission.
 */
export class FormSubmissionResponseDto {
  @ApiProperty({ description: 'Submission ID' })
  id!: string;

  @ApiProperty({ description: 'Form ID' })
  formId!: string;

  @ApiProperty({ description: 'Church ID' })
  churchId!: string;

  @ApiProperty({ description: 'Submitted data' })
  data!: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'ID of the user who submitted (null for public submissions)',
  })
  submittedBy?: string;

  @ApiProperty({ description: 'Submission status', enum: SubmissionStatus })
  status!: SubmissionStatus;

  @ApiPropertyOptional({ description: 'ID of the user who approved/rejected' })
  approvedById?: string;

  @ApiPropertyOptional({ description: 'Approval/rejection timestamp' })
  approvedAt?: Date;

  @ApiPropertyOptional({ description: 'Reason for rejection' })
  rejectionReason?: string;

  @ApiProperty({ description: 'File attachments', type: [SubmissionAttachmentDto] })
  @Type(() => SubmissionAttachmentDto)
  attachments!: SubmissionAttachmentDto[];

  @ApiProperty({ description: 'Submission timestamp' })
  createdAt!: Date;
}
