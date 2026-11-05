import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthenticatedRequest } from '../common/decorators/current-user.decorator';
import { RawResponse } from '../common/decorators/raw-response.decorator';
import { RateLimit } from '../common/guards/rate-limit.guard';
import { BotProtectionService } from './bot-protection.service';
import { protectedAction } from './protected-actions';

@ApiTags('Bot protection')
@Controller('bot-protection')
export class BotProtectionController {
  constructor(private readonly bots: BotProtectionService) {}

  private issue(method: string, path: string, authenticated: boolean, userId?: string) {
    const policy =
      typeof path === 'string' && path.length < 250 ? protectedAction(method, path) : null;
    if (!policy || policy.authenticated !== authenticated)
      throw new BadRequestException('Invalid verification action');
    return this.bots.challenge(method, path, userId);
  }

  @Get('challenge')
  @RawResponse()
  @Header('Cache-Control', 'no-store')
  @RateLimit({ limit: 30, windowSeconds: 60 })
  @ApiOperation({ summary: 'Issue a single-use ALTCHA challenge for a public action' })
  challenge(@Query('method') method: string, @Query('path') path: string) {
    return this.issue(method, path, false);
  }

  @Get('authenticated-challenge')
  @UseGuards(JwtAuthGuard)
  @RawResponse()
  @Header('Cache-Control', 'private, no-store')
  @RateLimit({ limit: 30, windowSeconds: 60 })
  @ApiOperation({ summary: 'Issue a user-bound ALTCHA challenge for a sensitive action' })
  authenticatedChallenge(
    @Query('method') method: string,
    @Query('path') path: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.issue(method, path, true, req.user.sub);
  }
}
