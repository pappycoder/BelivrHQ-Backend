import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthenticatedRequest } from '../common/decorators/current-user.decorator';
import { ApiBotProtection } from '../bot-protection/api-bot-protection.decorator';
import { RateLimit } from '../common/guards/rate-limit.guard';
import {
  IntakeAcceptedResponseDto,
  IntakeLinkResponseDto,
  IntakeMetaResponseDto,
  IntakePendingResponseDto,
  IntakeSubmittedResponseDto,
  IntakeAnswersDto,
  IntakeKindDto,
  IntakeLinkDto,
  IntakeListDto,
  IntakeListResponseDto,
} from './intake.dto';
import { IntakeService } from './intake.service';

@ApiTags('People registration')
@Controller('intake/public')
export class IntakePublicController {
  constructor(private readonly service: IntakeService) {}
  @Get(':token/meta')
  @ApiOkResponse({ type: IntakeMetaResponseDto })
  @ApiOperation({ summary: 'Read church-branded registration fields for a public branch link' })
  meta(@Param('token') token: string) {
    return this.service.meta(token);
  }
  @Post(':token/submit')
  @ApiCreatedResponse({ type: IntakeSubmittedResponseDto })
  @ApiBotProtection(IntakeAnswersDto)
  @RateLimit({ limit: 5, windowSeconds: 60 })
  @ApiOperation({ summary: 'Submit a registration for staff review; no account required' })
  submit(@Param('token') token: string, @Body() body: IntakeAnswersDto) {
    return this.service.submit(token, body.data);
  }
}

@ApiTags('People registration')
@ApiBearerAuth('supabase-auth')
@UseGuards(JwtAuthGuard)
@Controller('intake')
export class IntakeController {
  constructor(private readonly service: IntakeService) {}
  @Post('links')
  @ApiCreatedResponse({ type: IntakeLinkResponseDto })
  @ApiOperation({
    summary: 'Get or create a stable branch link; requires the register create permission',
  })
  link(@Request() req: AuthenticatedRequest, @Body() body: IntakeLinkDto) {
    return this.service.link(req.profile!, body.kind, body.branchId);
  }
  @Get('submissions')
  @ApiOkResponse({ type: IntakeListResponseDto })
  @ApiOperation({
    summary: 'List and sort pending registrations; requires register read and create permissions',
    description:
      'Sorts the full scoped queue before pagination. Includes the active registration field catalog for optional list columns.',
  })
  list(@Request() req: AuthenticatedRequest, @Query() query: IntakeListDto) {
    return this.service.list(req.profile!, query);
  }
  @Get('submissions/:id')
  @ApiOkResponse({ type: IntakePendingResponseDto })
  @ApiOperation({
    summary:
      'Inspect a pending registration and its editable fields; requires register read and create',
  })
  detail(
    @Request() req: AuthenticatedRequest,
    @Query() query: IntakeKindDto,
    @Param('id') id: string,
  ) {
    return this.service.detail(req.profile!, query.kind, id);
  }
  @Post('submissions/:id/accept')
  @ApiCreatedResponse({ type: IntakeAcceptedResponseDto })
  @ApiOperation({
    summary:
      'Accept corrected answers and create the member or visitor atomically; requires register read and create',
  })
  accept(
    @Request() req: AuthenticatedRequest,
    @Query() query: IntakeKindDto,
    @Param('id') id: string,
    @Body() body: IntakeAnswersDto,
  ) {
    return this.service.accept(req.profile!, query.kind, id, body.data, req.user.id);
  }
  @Delete('submissions/:id')
  @ApiOperation({
    summary: 'Permanently reject and delete a pending response; requires register read and create',
  })
  reject(
    @Request() req: AuthenticatedRequest,
    @Query() query: IntakeKindDto,
    @Param('id') id: string,
  ) {
    return this.service.reject(req.profile!, query.kind, id, req.user.id);
  }
}
