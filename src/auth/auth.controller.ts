import { ApiBotProtection } from '../bot-protection/api-bot-protection.decorator';
import { AcceptInvitationDto } from './dto/accept-invitation.dto';
/**
 * @file auth.controller.ts
 * @description HTTP endpoints for authentication and profile management.
 *
 * Handles registration, login, logout, password management, profile updates,
 * and session refresh. All endpoints are documented via Swagger.
 *
 * @module auth/auth.controller
 * @since 1.0.0
 */

import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Body,
  Header,
  HttpCode,
  HttpStatus,
  UseGuards,
  Request,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiUnauthorizedResponse,
  ApiOkResponse,
  ApiCreatedResponse,
  ApiBadRequestResponse,
} from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { Login2faDto } from './dto/login-2fa.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { RegisterResponseDto } from './dto/auth-response.dto';
import { LoginResponseDto, RefreshResponseDto } from './dto/session-response.dto';
import { CurrentUser, SupabaseUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { AuthenticatedRequest } from '../common/decorators/current-user.decorator';
import { RateLimit, RateLimitGuard, RATE_LIMITS } from '../common/guards/rate-limit.guard';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get('session')
  @UseGuards(JwtAuthGuard)
  @Header('Cache-Control', 'private, no-store')
  session(@CurrentUser() user: SupabaseUser) {
    return {
      userId: user.sub,
      email: user.email ?? '',
      expiresAt: user.exp,
      sessionEstablished: true,
    };
  }

  /**
   * Register a new church admin account.
   *
   * Creates a Supabase Auth user, a Church record, and an admin Profile.
   * This is a public endpoint — no authentication required.
   */
  @Post('register')
  @ApiBotProtection(RegisterDto)
  @UseGuards(RateLimitGuard)
  @RateLimit(RATE_LIMITS.auth)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Register a new church admin',
    description:
      'Creates a new user account, church, and admin profile. ' +
      'Returns the user ID, profile ID, and church ID.',
  })
  @ApiCreatedResponse({ description: 'Registration successful' })
  @ApiBadRequestResponse({ description: 'Invalid input data' })
  async register(@Body() dto: RegisterDto): Promise<RegisterResponseDto> {
    return this.authService.register(dto);
  }

  /**
   * Login with email and password.
   *
   * Returns JWT tokens and user profile. This is a public endpoint.
   */
  @Header('Cache-Control', 'no-store')
  @Post('login')
  @ApiBotProtection(LoginDto)
  @UseGuards(RateLimitGuard)
  @RateLimit(RATE_LIMITS.auth)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Login with email and password',
    description:
      'Authenticates a user with email and password. Returns JWT access token, refresh token, and user profile.',
  })
  @ApiOkResponse({ description: 'Login successful', type: LoginResponseDto })
  @ApiUnauthorizedResponse({ description: 'Invalid email or password' })
  async login(@Body() dto: LoginDto): Promise<LoginResponseDto> {
    return this.authService.login(dto);
  }

  /**
   * Complete authenticator sign-in or a legacy factor migration.
   *
   * Verifies the 6-digit code emailed during `login` and, on success, returns
   * the full session (access token, refresh token, profile) that was withheld
   * until this point. This is a public endpoint.
   */
  @Header('Cache-Control', 'no-store')
  @Post('login/2fa')
  @ApiBotProtection(Login2faDto)
  @UseGuards(RateLimitGuard)
  @RateLimit(RATE_LIMITS.auth)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Complete authenticator sign-in',
    description:
      'Verifies the current authenticator code with the opaque login challenge. Legacy email factors migrate to authenticator enrollment before a session is issued.',
  })
  @ApiOkResponse({ description: '2FA sign-in successful', type: LoginResponseDto })
  @ApiUnauthorizedResponse({ description: 'Invalid or expired code' })
  async completeTwoFactorLogin(@Body() dto: Login2faDto): Promise<LoginResponseDto> {
    return this.authService.completeTwoFactorLogin(dto);
  }

  /**
   * Logout the current user.
   *
   * Blacklists the JWT token in Redis so it can no longer be used.
   */
  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('supabase-auth')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Logout current user',
    description: 'Blacklists the current JWT token and logs the logout event.',
  })
  @ApiOkResponse({ description: 'Logout successful' })
  @ApiUnauthorizedResponse({ description: 'Invalid or missing JWT token' })
  async logout(@CurrentUser() user: SupabaseUser, @Request() req: AuthenticatedRequest) {
    const token = req.headers.authorization?.replace('Bearer ', '') || '';
    const churchId = req.profile?.church_id || '';
    await this.authService.logout(user.id, token, churchId);
    return { success: true };
  }

  /**
   * Request a password reset email.
   *
   * Always returns success to prevent email enumeration.
   * The company email sender delivers a one-time recovery link.
   */
  @Post('forgot-password')
  @ApiBotProtection(ForgotPasswordDto)
  @UseGuards(RateLimitGuard)
  @RateLimit(RATE_LIMITS.auth)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Request password reset',
    description:
      'Sends a password reset email to the specified address. ' +
      'Always returns success to prevent email enumeration.',
  })
  @ApiOkResponse({ description: 'If the email exists, a reset link has been sent' })
  async forgotPassword(@Body() dto: ForgotPasswordDto): Promise<{ success: boolean }> {
    await this.authService.forgotPassword(dto.email);
    return { success: true };
  }

  /**
   * Accept a one-time staff invitation and choose a password.
   */
  @Post('accept-invitation')
  @ApiBotProtection(AcceptInvitationDto)
  @UseGuards(RateLimitGuard)
  @RateLimit(RATE_LIMITS.auth)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Accept a staff invitation and choose a password' })
  async acceptInvitation(@Body() dto: AcceptInvitationDto): Promise<{ success: boolean }> {
    await this.authService.acceptInvitation(dto.token, dto.newPassword);
    return { success: true };
  }

  @Patch('reset-password')
  @ApiBotProtection(ResetPasswordDto)
  @UseGuards(RateLimitGuard)
  @RateLimit(RATE_LIMITS.auth)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reset password with recovery token',
    description: 'Completes the password reset flow using the token from the email link.',
  })
  @ApiOkResponse({ description: 'Password reset successful' })
  @ApiBadRequestResponse({ description: 'Invalid or expired recovery token' })
  async resetPassword(@Body() dto: ResetPasswordDto): Promise<{ success: boolean }> {
    await this.authService.resetPassword(dto.token, dto.newPassword);
    return { success: true };
  }

  /**
   * Change password for the authenticated user.
   *
   * Requires the current password for verification before setting the new one.
   */
  @Put('password')
  @ApiBotProtection(ChangePasswordDto)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('supabase-auth')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Change password',
    description:
      'Changes the password for the authenticated user. ' +
      'Requires current password for verification.',
  })
  @ApiOkResponse({ description: 'Password changed successfully' })
  @ApiUnauthorizedResponse({ description: 'Current password is incorrect' })
  async changePassword(
    @CurrentUser() user: SupabaseUser,
    @Body() dto: ChangePasswordDto,
  ): Promise<{ success: boolean }> {
    await this.authService.changePassword(user.id, dto.currentPassword, dto.newPassword);
    return { success: true };
  }

  /**
   * Refresh the current session tokens.
   *
   * Returns new access and refresh tokens.
   */
  @Post('refresh')
  @RateLimit(RATE_LIMITS.auth)
  @ApiBearerAuth('supabase-auth')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Refresh session tokens',
    description: 'Refreshes the current session and returns new access and refresh tokens.',
  })
  @ApiOkResponse({ description: 'Session refreshed successfully', type: RefreshResponseDto })
  @ApiUnauthorizedResponse({ description: 'Invalid or expired refresh token' })
  async refreshSession(@Request() req: AuthenticatedRequest): Promise<RefreshResponseDto> {
    const refreshToken = req.body?.refreshToken;
    return this.authService.refreshSession(refreshToken);
  }
}
