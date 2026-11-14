/**
 * @file update-submission-status.dto.ts
 * @description DTO for approving or rejecting a form submission.
 *
 * @module forms/dto
 * @since 1.0.0
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { SubmissionStatus } from '@prisma/client';

export class UpdateSubmissionStatusDto {
  @ApiProperty({
    description: 'New submission status',
    enum: [SubmissionStatus.approved, SubmissionStatus.rejected],
  })
  @IsIn([SubmissionStatus.approved, SubmissionStatus.rejected])
  status!: SubmissionStatus;

  @ApiPropertyOptional({ description: 'Optional reason for rejection' })
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  rejectionReason?: string;
}
