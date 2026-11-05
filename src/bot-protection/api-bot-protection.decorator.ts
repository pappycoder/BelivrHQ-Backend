import { applyDecorators, Type } from '@nestjs/common';
import { ApiBody, ApiExtraModels, ApiProperty, getSchemaPath } from '@nestjs/swagger';

export class BotProtectionFieldsDto {
  @ApiProperty({
    description: 'Base64-encoded solved ALTCHA proof; single-use and action-bound',
    maxLength: 8192,
  })
  altcha!: string;

  @ApiProperty({ description: 'Honeypot; must be an empty string', example: '' })
  website!: string;
}

/** Runtime enforcement is centralized; these fields are stripped before DTO validation. */
export function ApiBotProtection(dto?: Type<unknown>) {
  return applyDecorators(
    ApiExtraModels(BotProtectionFieldsDto, ...(dto ? [dto] : [])),
    ApiBody({
      schema: {
        allOf: [
          ...(dto ? [{ $ref: getSchemaPath(dto) }] : []),
          { $ref: getSchemaPath(BotProtectionFieldsDto) },
        ],
      },
    }),
  );
}
