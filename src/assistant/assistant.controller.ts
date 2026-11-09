import { Body, Controller, Get, Header, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RateLimit, RateLimitGuard } from '../common/guards/rate-limit.guard';
import { AuthenticatedRequest } from '../common/decorators/current-user.decorator';
import { AssistantQuestionDto } from './assistant.dto';
import { AssistantService } from './assistant.service';

@ApiTags('Ask BelivrHQ')
@ApiBearerAuth('supabase-auth')
@Controller('assistant')
@UseGuards(JwtAuthGuard, RateLimitGuard)
export class AssistantController {
  constructor(private readonly assistant: AssistantService) {}
  @Get('context')
  @Header('Cache-Control', 'private, no-store')
  context(@Req() request: AuthenticatedRequest) {
    return this.assistant.context(request.profile);
  }

  @Post('message')
  @HttpCode(200)
  @RateLimit({ limit: 10, windowSeconds: 60 })
  @Header('Cache-Control', 'private, no-store')
  ask(@Body() input: AssistantQuestionDto, @Req() request: AuthenticatedRequest) {
    return this.assistant.ask(input, request.profile);
  }
}
