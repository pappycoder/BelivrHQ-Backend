/**
 * @file DTO for church response data.
 * @module ChurchResponseDto
 * @description Data transfer object returned for church queries.
 * Contains church details with branch and member counts.
 * @since 1.0.0
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * DTO for church response data.
 * Contains church details, counts, and timestamps.
 */
export class ChurchResponseDto {
  @ApiProperty({ description: 'Church ID', example: '11111111-0000-0000-0000-000000000000' })
  churchId!: string;

  @ApiProperty({ description: 'Church name', example: 'Redeemed Christian Church of God' })
  name!: string;

  @ApiPropertyOptional({ description: 'Denomination', example: 'Pentecostal' })
  denomination?: string;

  @ApiPropertyOptional({ description: 'Street address', example: '123 Faith Avenue' })
  address?: string;

  @ApiPropertyOptional({ description: 'City', example: 'Lagos' })
  city?: string;

  @ApiPropertyOptional({ description: 'State', example: 'Lagos' })
  state?: string;

  @ApiProperty({ description: 'Country', example: 'Nigeria' })
  country!: string;

  @ApiPropertyOptional({ description: 'Phone number', example: '+234 801 234 5678' })
  phone?: string;

  @ApiPropertyOptional({ description: 'Email address', example: 'info@church.org' })
  email?: string;

  @ApiPropertyOptional({ description: 'Website URL', example: 'https://www.church.org' })
  website?: string;

  @ApiPropertyOptional({ description: 'Logo image URL' })
  logoUrl?: string;

  @ApiProperty({ description: 'Number of branches', example: 3 })
  branchCount!: number;

  @ApiProperty({ description: 'Number of members', example: 150 })
  memberCount!: number;

  @ApiPropertyOptional({
    description: 'Archive timestamp: set when the church is archived (hides it from normal use)',
    example: '2026-08-28T10:30:00.000Z',
  })
  archivedAt?: string;

  @ApiProperty({ description: 'Created timestamp', example: '2024-01-15T10:30:00.000Z' })
  createdAt!: string;

  @ApiProperty({ description: 'Updated timestamp', example: '2024-06-20T14:00:00.000Z' })
  updatedAt!: string;
}
