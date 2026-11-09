/**
 * @file create-form.dto.ts
 * @description DTO for creating a new form.
 *
 * @module forms/dto
 * @since 1.0.0
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { FormStatus } from '@prisma/client';
import { FormFieldDto } from './form-field.dto';

export class CreateFormDto {
  @ApiPropertyOptional({ description: 'Branch that owns this form' })
  @IsUUID()
  @IsOptional()
  branchId?: string;

  @ApiProperty({ description: 'Form title', example: 'Membership Application' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title!: string;

  @ApiPropertyOptional({ description: 'Form description', example: 'Apply to become a member' })
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  description?: string;

  @ApiProperty({ description: 'Field definitions', type: [FormFieldDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FormFieldDto)
  fields!: FormFieldDto[];

  @ApiPropertyOptional({ description: 'Form status', enum: FormStatus, default: FormStatus.draft })
  @IsEnum(FormStatus)
  @IsOptional()
  status?: FormStatus;

  @ApiPropertyOptional({ description: 'Whether this form is a reusable template', default: false })
  @IsBoolean()
  @IsOptional()
  isTemplate?: boolean;

  @ApiPropertyOptional({ description: 'Allow public submissions via token', default: false })
  @IsBoolean()
  @IsOptional()
  isPublic?: boolean;

  @ApiPropertyOptional({
    description:
      'Field key (e.g. "email") whose value must be unique across public submissions: blocks duplicate submissions',
  })
  @IsString()
  @IsOptional()
  @MaxLength(100)
  uniqueField?: string;

  @ApiPropertyOptional({
    description: 'Maximum number of submissions (0 = unlimited)',
    default: 0,
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  submissionLimit?: number;
}
