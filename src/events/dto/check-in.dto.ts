import { AttendanceDateDto } from '../../common/dto/attendance-date.dto';
import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

export class BulkCheckInDto extends AttendanceDateDto {
  @ApiProperty({ description: 'Member IDs to check in', type: [String] })
  @IsArray()
  @IsUUID('4', { each: true })
  @IsNotEmpty()
  memberIds!: string[];
}

export class WalkInCheckInDto extends AttendanceDateDto {
  @ApiProperty({ description: 'First name', example: 'John' })
  @IsString()
  @IsNotEmpty()
  firstName!: string;

  @ApiProperty({ description: 'Last name', example: 'Doe' })
  @IsString()
  @IsNotEmpty()
  lastName!: string;

  @ApiProperty({ description: 'Phone number', example: '+2348012345678' })
  @IsString()
  @IsNotEmpty()
  phone!: string;

  @ApiProperty({ description: 'Email (optional)' })
  @IsString()
  @IsOptional()
  email?: string;

  @ApiProperty({ description: 'Gender (optional)', enum: ['male', 'female'] })
  @IsString()
  @IsOptional()
  gender?: string;
}
