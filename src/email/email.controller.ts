/**
 * @file email.controller.ts
 * @description HTTP endpoints for internal in-app email.
 *
 * Provides send, mailbox list, detail/read, read/unread toggling, trash,
 * restore, permanent delete, and recipient-contact lookup. All endpoints are
 * auth-protected and permission-gated by `emails:*`.
 *
 * @module email/email.controller
 * @since 1.0.0
 */

import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import {
  ApiGetEndpoint,
  ApiUpdateEndpoint,
  ApiDeleteEndpoint,
  ApiCreateEndpoint,
} from '../common/decorators/api-standard-responses.decorator';
import { EmailService } from './email.service';
import { SendEmailDto } from './dto/send-email.dto';
import { ListEmailsDto, EmailBox } from './dto/list-emails.dto';
import { ListEmailContactsDto } from './dto/list-email-contacts.dto';
import { EmailContactDto, EmailDetailDto, EmailListEnvelopeDto } from './dto/email-response.dto';

@ApiTags('Emails')
@ApiBearerAuth('supabase-auth')
@UseGuards(JwtAuthGuard)
@Controller('email')
export class EmailController {
  constructor(private readonly emailService: EmailService) {}

  private getProfile(req: Record<string, unknown>): { church_id: string; id: string } {
    return req['profile'] as { church_id: string; id: string };
  }

  private getUserId(req: Record<string, unknown>): string {
    const user = req['user'] as { sub?: string; id?: string } | undefined;
    return user?.sub || user?.id || '';
  }

  /**
   * List recipient contacts for the compose picker.
   * Declared before the `:messageId` param route to avoid shadowing.
   */
  @Get('contacts')
  @RequirePermissions('emails:read')
  @ApiGetEndpoint('List email contacts', 'Lists selectable recipient contacts (main roles).')
  async listContacts(
    @Query() query: ListEmailContactsDto,
    @Request() req: Record<string, unknown>,
  ): Promise<{ data: EmailContactDto[]; total: number }> {
    const profile = this.getProfile(req);
    return this.emailService.listContacts(
      profile.church_id,
      profile.id,
      query.search,
      query.branchId,
      query.role,
      query.includeSelf,
    );
  }

  /**
   * Get the unread inbox count for the current user.
   */
  @Get('unread-count')
  @RequirePermissions('emails:read')
  @ApiGetEndpoint(
    'Get unread count',
    'Returns the count of unread emails in the current user inbox.',
  )
  async getUnreadCount(@Request() req: Record<string, unknown>): Promise<{ count: number }> {
    const profile = this.getProfile(req);
    const count = await this.emailService.getUnreadCount(profile.church_id, profile.id);
    return { count };
  }

  /**
   * List emails for the current user (inbox or sent).
   */
  @Get()
  @RequirePermissions('emails:read')
  @ApiGetEndpoint('List emails', 'Lists emails in the current user inbox or sent box.')
  async list(
    @Query() query: ListEmailsDto,
    @Request() req: Record<string, unknown>,
  ): Promise<EmailListEnvelopeDto> {
    const profile = this.getProfile(req);
    return this.emailService.list(
      profile.church_id,
      profile.id,
      query.page ?? 1,
      query.limit ?? 30,
      query.box ?? EmailBox.Inbox,
      query.includeTrashed ?? false,
    );
  }

  /**
   * Send an internal email to main-role recipients.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('emails:create')
  @ApiCreateEndpoint(
    'Send email',
    'Sends an internal in-app email to one or more main-role recipients.',
  )
  async send(
    @Body() dto: SendEmailDto,
    @Request() req: Record<string, unknown>,
  ): Promise<EmailDetailDto> {
    const profile = this.getProfile(req);
    const userId = this.getUserId(req);
    return this.emailService.send(dto, profile.church_id, profile.id, userId);
  }

  /**
   * Get a single email (marks it read when fetched from the inbox).
   */
  @Get(':messageId')
  @RequirePermissions('emails:read')
  @ApiGetEndpoint('Get email', 'Returns a single email, marking it read when from the inbox.')
  async getOne(
    @Param('messageId') messageId: string,
    @Request() req: Record<string, unknown>,
  ): Promise<EmailDetailDto> {
    const profile = this.getProfile(req);
    return this.emailService.getOne(messageId, profile.church_id, profile.id);
  }

  /**
   * Mark a received email as read.
   * Self-scoped (only the caller's own EmailRecipient copy flips), so the
   * mailbox read grant is the floor — same rule as the detail GET, which
   * already marks read on open.
   */
  @Post(':messageId/read')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('emails:read')
  @ApiUpdateEndpoint('Mark as read', 'Marks a received email as read.')
  async markRead(
    @Param('messageId') messageId: string,
    @Request() req: Record<string, unknown>,
  ): Promise<{ success: boolean }> {
    const profile = this.getProfile(req);
    return this.emailService.markRead(messageId, profile.church_id, profile.id);
  }

  /**
   * Mark a received email as unread.
   * Self-scoped like mark-read — the caller only ever clears their own copy.
   */
  @Post(':messageId/unread')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('emails:read')
  @ApiUpdateEndpoint('Mark as unread', 'Marks a received email as unread.')
  async markUnread(
    @Param('messageId') messageId: string,
    @Request() req: Record<string, unknown>,
  ): Promise<{ success: boolean }> {
    const profile = this.getProfile(req);
    return this.emailService.markUnread(messageId, profile.church_id, profile.id);
  }

  /**
   * Soft-delete (move to trash).
   */
  @Delete(':messageId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('emails:delete')
  @ApiDeleteEndpoint('Trash email', 'Soft-deletes (moves to trash) an email for the current user.')
  async trash(
    @Param('messageId') messageId: string,
    @Request() req: Record<string, unknown>,
  ): Promise<{ success: boolean }> {
    const profile = this.getProfile(req);
    return this.emailService.trash(messageId, profile.church_id, profile.id);
  }

  /**
   * Restore a trashed email back to its active box.
   */
  @Post(':messageId/restore')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('emails:update')
  @ApiUpdateEndpoint('Restore email', 'Restores a trashed email back to its active box.')
  async restore(
    @Param('messageId') messageId: string,
    @Request() req: Record<string, unknown>,
  ): Promise<{ success: boolean }> {
    const profile = this.getProfile(req);
    return this.emailService.restore(messageId, profile.church_id, profile.id);
  }

  /**
   * Permanently delete a trashed email.
   */
  @Delete(':messageId/permanent')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('emails:delete')
  @ApiDeleteEndpoint(
    'Permanently delete',
    'Permanently deletes an email from trash (cannot be undone).',
  )
  async deleteForever(
    @Param('messageId') messageId: string,
    @Request() req: Record<string, unknown>,
  ): Promise<{ success: boolean }> {
    const profile = this.getProfile(req);
    return this.emailService.deleteForever(messageId, profile.church_id, profile.id);
  }
}
