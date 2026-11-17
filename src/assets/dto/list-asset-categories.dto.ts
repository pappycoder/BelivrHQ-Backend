import { QueryBoolean } from '../../common/decorators/query-boolean.decorator';
/**
 * @file list-asset-categories.dto.ts
 * @description Query DTO for listing asset categories.
 *
 * @module assets/dto
 * @since 1.0.0
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

export class ListAssetCategoriesDto {
  @ApiPropertyOptional({
    description: 'List archived records only (default: active only)',
    default: false,
  })
  @QueryBoolean()
  @IsOptional()
  @IsBoolean()
  archived?: boolean;
}
