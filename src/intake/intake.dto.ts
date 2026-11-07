import { FormFieldDto } from '../forms/dto/form-field.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class IntakeKindDto {
  @ApiProperty({ enum: ['members', 'visitors'] })
  @IsIn(['members', 'visitors'])
  kind!: 'members' | 'visitors';
}
export class IntakeLinkDto extends IntakeKindDto {
  @ApiProperty({ description: 'Owning branch; fixed for all responses to this link' })
  @IsUUID()
  branchId!: string;
}
export class IntakeListDto extends IntakeKindDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() branchId?: string;
  @ApiPropertyOptional({ default: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @ApiPropertyOptional({ default: 15 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 15;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) search?: string;
}
export class IntakeAnswersDto {
  @ApiProperty({
    description:
      'Answers keyed by the field keys from metadata; administrative fields are forbidden',
  })
  @IsObject()
  data!: Record<string, unknown>;
}

export class IntakeLinkResponseDto {
  @ApiProperty() token!: string;
  @ApiProperty() branchName!: string;
  @ApiProperty({ enum: ['members', 'visitors'] }) kind!: string;
}
export class IntakeMetaResponseDto {
  @ApiProperty() title!: string;
  @ApiProperty({ enum: ['members', 'visitors'] }) kind!: string;
  @ApiProperty() churchName!: string;
  @ApiPropertyOptional({ nullable: true }) churchLogoUrl?: string | null;
  @ApiProperty() branchName!: string;
  @ApiProperty({ type: [FormFieldDto] }) fields!: FormFieldDto[];
}
export class IntakePendingResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty({ type: 'object', additionalProperties: true }) data!: Record<string, unknown>;
  @ApiPropertyOptional() branchId?: string;
  @ApiProperty() branchName!: string;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
  @ApiPropertyOptional({ type: [FormFieldDto] }) fields?: FormFieldDto[];
}
export class IntakeAcceptedResponseDto {
  @ApiProperty({ description: 'ID of the member or visitor created by acceptance' })
  destinationId!: string;
}
export class IntakeSubmittedResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() message!: string;
}
