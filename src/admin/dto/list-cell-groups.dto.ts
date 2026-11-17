import { QueryBoolean } from '../../common/decorators/query-boolean.decorator';
/**
 * @file list-cell-groups.dto.ts
 * @description Query DTO for listing / exporting cell groups with filters.
 *
 * @module admin/dto/list-cell-groups.dto
 * @since 1.0.0
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

// Query DTO for the cell-group list / export endpoints.
export class ListCellGroupsDto {
  @ApiPropertyOptional({ description: 'List archived groups only' })
  @IsOptional()
  @QueryBoolean()
  @IsBoolean()
  archived?: boolean;

  @ApiPropertyOptional({
    description: 'Search by group name, meet-up address, or leader name',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ description: 'Filter by branch ID' })
  @IsOptional()
  @IsString()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({ example: 'Sunday', description: 'Filter by meeting day of the week' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  meetingDay?: string;
}
