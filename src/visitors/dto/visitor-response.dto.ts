import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class VisitorResponseDto {
  @ApiProperty({ description: 'Visitor ID' })
  id!: string;

  @ApiProperty({ description: 'Church ID' })
  churchId!: string;

  @ApiPropertyOptional({ description: 'Branch the visitor was received in' })
  branchId?: string;

  @ApiPropertyOptional({ description: 'Branch name (resolved server-side)' })
  branchName?: string;

  @ApiProperty({ description: 'First name' })
  firstName!: string;

  @ApiPropertyOptional({ description: 'Last name' })
  lastName?: string;

  @ApiPropertyOptional({ description: 'Gender (male or female)' })
  gender?: string;

  @ApiPropertyOptional({ description: 'Phone number' })
  phone?: string;

  @ApiPropertyOptional({ description: 'WhatsApp number' })
  whatsappNumber?: string;

  @ApiPropertyOptional({ description: 'Email address' })
  email?: string;

  @ApiProperty({ description: 'First visit date' })
  firstVisitDate!: string;

  @ApiProperty({
    description: 'Follow-up status',
    enum: ['new', 'contacted', 'follow_up_scheduled', 'interested', 'converted', 'dropped_off'],
  })
  followUpStatus!: string;

  @ApiPropertyOptional({ description: 'Assigned follow-up team member ID' })
  assignedToId?: string;

  @ApiPropertyOptional({ description: 'Assigned follow-up team member name' })
  assignedToName?: string;

  @ApiPropertyOptional({ description: 'Notes' })
  notes?: string;

  @ApiPropertyOptional({ description: 'Additional custom fields as JSON' })
  customFields?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Converted member ID' })
  convertedMemberId?: string;

  @ApiPropertyOptional({ description: 'Conversion date' })
  convertedAt?: string;

  @ApiPropertyOptional({
    description: 'Archive timestamp: set when the visitor is archived',
    example: '2026-08-28T10:30:00.000Z',
  })
  archivedAt?: string;

  @ApiProperty({ description: 'Created timestamp' })
  createdAt!: string;

  @ApiProperty({ description: 'Last updated timestamp' })
  updatedAt!: string;
}
