/**
 * @file scan-asset.dto.ts
 * @description DTO for scanning an asset via QR or asset tag.
 *
 * @module assets/dto
 * @since 1.0.0
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class ScanAssetDto {
  @ApiPropertyOptional({
    description: 'QR code data',
    example: 'BELIVRHQ:ASSET:11111111-1111-1111-1111-111111111111',
  })
  @IsString()
  @IsOptional()
  qrData?: string;

  @ApiPropertyOptional({ description: 'Asset tag', example: 'AUD-001' })
  @IsString()
  @IsOptional()
  assetTag?: string;
}
