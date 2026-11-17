import { QueryBoolean } from '../../common/decorators/query-boolean.decorator';
/**
 * @file list-appointment-contacts.dto.ts
 * @description DTO for listing appointment participant contacts (the pickers).
 *
 * @module appointments/dto/list-appointment-contacts.dto
 * @since 1.0.0
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * DTO for listing the selectable participant set when creating/editing an
 * appointment (the With/pastor picker and the Who/person picker).
 * `kind: 'with'` returns pastor-role profiles; `kind: 'who'` returns all
 * profiles (any role) plus optional visitors.
 */
export class ListAppointmentContactsDto {
  @ApiProperty({
    description: 'Which picker: "with" = the pastor partner picker, "who" = the person picker.',
    enum: ['with', 'who'],
    example: 'with',
  })
  @IsIn(['with', 'who'])
  kind!: 'with' | 'who';

  @ApiPropertyOptional({ description: 'Page number', default: 1, example: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number;

  @ApiPropertyOptional({ description: 'Items per page', default: 50, example: 50 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  @IsOptional()
  limit?: number;

  @ApiPropertyOptional({
    description: 'Search by first name, last name, or email',
    example: 'Pastor',
  })
  @IsString()
  @IsOptional()
  search?: string;

  @ApiPropertyOptional({
    description: 'When kind is "who", also include existing visitors in the results',
    example: true,
  })
  @QueryBoolean()
  @IsOptional()
  @IsBoolean()
  includeVisitors?: boolean;

  @ApiPropertyOptional({
    description: 'Filter by exact role',
    example: 'branch_pastor',
  })
  @IsString()
  @IsOptional()
  role?: string;

  @ApiPropertyOptional({
    description: 'Filter by branch ID',
    example: '33333333-3333-3333-3333-333333333333',
  })
  @IsUUID('4')
  @IsOptional()
  branchId?: string;
}
