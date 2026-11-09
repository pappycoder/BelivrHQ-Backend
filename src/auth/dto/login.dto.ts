import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsString } from 'class-validator';

/**
 * DTO for user login with email and password.
 *
 * @module auth/dto/login.dto
 */
export class LoginDto {
  @ApiProperty({
    description: 'User email address',
    example: 'pastor@demo.com',
  })
  @IsEmail()
  @IsNotEmpty()
  email!: string;

  @ApiProperty({
    description: 'User password',
    example: 'BelivrHQ2026!',
    minLength: 8,
  })
  @IsString()
  @IsNotEmpty()
  password!: string;
}
