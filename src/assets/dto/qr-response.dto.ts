/**
 * @file qr-response.dto.ts
 * @description Response DTO for asset QR code data.
 *
 * @module assets/dto
 * @since 1.0.0
 */

import { ApiProperty } from '@nestjs/swagger';

export class QrResponseDto {
  @ApiProperty({ description: 'Asset ID' })
  assetId!: string;

  @ApiProperty({
    description: 'QR code data string',
    example: 'BELIVRHQ:ASSET:11111111-1111-1111-1111-111111111111',
  })
  qrData!: string;
}
