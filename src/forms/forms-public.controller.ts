/**
 * @file forms-public.controller.ts
 * @description Public HTTP endpoint for anonymous form submissions.
 *
 * Allows anyone with a valid public token to submit a published form.
 * This endpoint is intentionally not protected by JWT authentication.
 *
 * @module forms/forms-public.controller
 * @since 1.0.0
 */

import { ApiBotProtection } from '../bot-protection/api-bot-protection.decorator';
import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { RateLimit } from '../common/guards/rate-limit.guard';
import { FormsService } from './forms.service';
import { CreateFormSubmissionDto, FormSubmissionResponseDto, PublicFormMetaDto } from './dto';

@ApiTags('Forms')
@Controller('forms/public')
export class FormsPublicController {
  constructor(private readonly formsService: FormsService) {}

  /**
   * Returns public form metadata for rendering an anonymous submission form.
   */
  @Get(':publicToken/meta')
  @ApiOperation({
    summary: 'Get public form metadata',
    description:
      'Returns the title, description, and field definitions needed to render a public form. No auth required.',
  })
  @ApiParam({ name: 'publicToken', description: 'Public form token' })
  async getPublicFormMeta(@Param('publicToken') publicToken: string): Promise<PublicFormMetaDto> {
    return this.formsService.getPublicFormMeta(publicToken);
  }

  /**
   * Submits a form using a public token.
   */
  @Post(':publicToken/submit')
  @ApiBotProtection(CreateFormSubmissionDto)
  @RateLimit({ limit: 5, windowSeconds: 60 })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Submit a form publicly',
    description: 'Anonymous submission using a public token.',
  })
  @ApiParam({ name: 'publicToken', description: 'Public form token' })
  async submitPublicForm(
    @Param('publicToken') publicToken: string,
    @Body() dto: CreateFormSubmissionDto,
  ): Promise<FormSubmissionResponseDto> {
    return this.formsService.submitByPublicToken(publicToken, dto);
  }
}
