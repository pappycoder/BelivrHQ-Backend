import { RequestContextService } from '../common/services/request-context.service';
import { nextEventOccurrence } from '../attendance/schedule-occurrence';
/**
 * @file whatsapp.service.ts
 * @description WhatsApp Business API integration service.
 *
 * Handles inbound webhook processing, command routing, outbound message sending,
 * and message logging for the Termii WhatsApp API (single platform for
 * WhatsApp + SMS).
 *
 * Command Router:
 *   CHECKIN — Mark attendance for today's service
 *   GIVE    — Provide giving link / instructions
 *   HELP    — Show available commands
 *   PRAYER  — Acknowledge prayer request
 *   EVENTS  — Show upcoming events
 *   STATUS  — Show member giving/attendance summary
 *
 * @module whatsapp/whatsapp.service
 * @since 1.0.0
 */

import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLoggingService } from '../common/services/audit-logging.service';
import { MessagingDeliveryService } from '../communication/messaging-delivery.service';
import { WebhookBodyDto } from './dto/webhook.dto';
import { MessageResponseDto } from './dto/message-response.dto';
import { Prisma, MessageDirection } from '@prisma/client';
import { INTEGRATION_ALERT_SERVICE_TOKEN } from '../notifications/notification-tokens';

/**
 * Raw Termii inbound webhook payload shape. Termii delivers a flat object
 * (not the Meta/360dialog envelope). Type is either 'inbound' (a message)
 * or a delivery/status event.
 */
interface TermiiWebhookPayload {
  type?: string;
  id?: string;
  message_id?: string;
  receiver?: string;
  sender?: string;
  message?: string;
  received_at?: string;
  status?: string;
  channel?: string;
}

/**
 * Normalized inbound message used by the command router.
 */
interface NormalizedMessage {
  phone: string;
  body: string;
  messageId: string;
  timestamp: string;
  memberId: string | null;
  churchId: string;
}

type CommandHandler = (msg: NormalizedMessage, args: string) => Promise<string>;

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);
  private readonly commandHandlers = new Map<string, CommandHandler>();
  private alertService?: {
    notify(
      churchId: string,
      integration: string,
      title: string,
      message: string,
      data?: Record<string, unknown>,
    ): Promise<void>;
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly requestContext: RequestContextService,
    private readonly config: ConfigService,
    private readonly audit: AuditLoggingService,
    private readonly termiiService: MessagingDeliveryService,
    private readonly moduleRef: ModuleRef,
  ) {
    this.registerCommands();
  }

  /**
   * Lazily resolves the integration alert service and raises a bell alert to
   * the church's admins. Failures are swallowed so alerting can never break
   * the underlying WhatsApp send.
   */
  private async notifyFailure(churchId: string, title: string, message: string): Promise<void> {
    try {
      this.alertService ??= this.moduleRef.get(INTEGRATION_ALERT_SERVICE_TOKEN, {
        strict: false,
      });
      if (!this.alertService) return;
      await this.alertService.notify(churchId, 'termii', title, message);
    } catch (err) {
      this.logger.warn(
        `WhatsApp failure alert skipped: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // ─── COMMAND REGISTRY ──────────────────────────────────────────

  private registerCommands(): void {
    this.commandHandlers.set('HELP', this.handleHelp.bind(this));
    this.commandHandlers.set('CHECKIN', this.handleCheckin.bind(this));
    this.commandHandlers.set('GIVE', this.handleGive.bind(this));
    this.commandHandlers.set('PRAYER', this.handlePrayer.bind(this));
    this.commandHandlers.set('EVENTS', this.handleEvents.bind(this));
    this.commandHandlers.set('STATUS', this.handleStatus.bind(this));
    this.commandHandlers.set('SERMON', this.handleSermon.bind(this));
    this.commandHandlers.set('TESTIMONY', this.handleTestimony.bind(this));
    this.commandHandlers.set('BIRTHDAY', this.handleBirthday.bind(this));
  }

  /**
   * Process an inbound WhatsApp webhook from Termii.
   *
   * Handles both the Termii flat payload shape and the Meta Cloud
   * envelope for backward compatibility during transition.
   */
  async processWebhook(
    body: WebhookBodyDto | Record<string, unknown>,
    webhookChurchId: string,
  ): Promise<{ processed: number }> {
    // Termii flat payloads carry a `type`/`sender`/`message` top-level shape.
    if (body && !('messages' in body) && this.isTermiiPayload(body as Record<string, unknown>)) {
      return this.processTermiiWebhook(body as unknown as TermiiWebhookPayload, webhookChurchId);
    }

    const metaBody = body as WebhookBodyDto;

    if (!metaBody.messages || metaBody.messages.length === 0) {
      // Status update — handle delivery/read receipts
      if (metaBody.statuses && metaBody.statuses.length > 0) {
        await this.handleStatusUpdates(metaBody.statuses, webhookChurchId);
        return { processed: metaBody.statuses.length };
      }
      return { processed: 0 };
    }

    let processed = 0;

    const phoneNumberId = metaBody.metadata?.phone_number_id;

    for (const msg of metaBody.messages) {
      try {
        const normalized = await this.normalizeMessage(
          msg.from,
          msg.id,
          msg.timestamp,
          msg.text?.body,
          phoneNumberId,
          webhookChurchId,
        );
        if (normalized) {
          await this.routeMessage(normalized);
          processed++;
        }
      } catch (err) {
        this.logger.error(`Failed to process message ${msg.id}: ${(err as Error).message}`);
      }
    }

    return { processed };
  }

  /**
   * Determines whether a raw webhook body is a Termii flat payload rather
   * than the Meta/360dialog envelope.
   */
  private isTermiiPayload(body: Record<string, unknown>): boolean {
    if (body.type === 'inbound') return true;
    if (typeof body.sender === 'string' && typeof body.message === 'string') return true;
    if (body.channel === 'whatsapp' && (body.message_id || body.id)) return true;
    return false;
  }

  /**
   * Processes a Termii flat inbound webhook: an inbound text message or a
   * delivery/status event.
   */
  private async processTermiiWebhook(
    body: TermiiWebhookPayload,
    webhookChurchId: string,
  ): Promise<{ processed: number }> {
    // Status / delivery reports carry a status but no inbound text.
    if (body.type && body.type !== 'inbound' && body.status) {
      if (body.id || body.message_id) {
        await this.handleTermiiStatusUpdate(
          body.message_id ?? body.id!,
          body.status,
          webhookChurchId,
        );
      }
      return { processed: 1 };
    }

    const phone = body.sender ? `+${body.sender.replace(/^\+/, '')}` : '';
    const content = body.message ?? '';
    const messageId = body.message_id ?? body.id ?? '';

    if (!phone || !content.trim()) {
      this.logger.debug('Skipping Termii non-text inbound message');
      return { processed: 0 };
    }

    // The verified callback destination selects the tenant; phone lookups never do.
    const normalized = await this.normalizeTermiiMessage(
      phone,
      messageId,
      body.received_at,
      content.trim(),
      webhookChurchId,
    );

    if (normalized) {
      await this.routeMessage(normalized);
      return { processed: 1 };
    }

    return { processed: 0 };
  }

  /**
   * Normalizes a Termii inbound message into the internal message shape used
   * by the command router. Resolves the member by phone within the verified church.
   */
  private async normalizeTermiiMessage(
    phone: string,
    messageId: string,
    timestamp: string | undefined,
    body: string | undefined,
    webhookChurchId: string,
  ): Promise<NormalizedMessage | null> {
    if (!body || body.trim().length === 0) {
      this.logger.debug(`Skipping non-text message from ${phone}`);
      return null;
    }

    const profile = await this.prisma.profile.findFirst({
      where: { phone, church_id: webhookChurchId },
      select: { church_id: true, member_id: true },
    });

    const churchId = webhookChurchId;
    const memberId = profile?.member_id || null;
    if (!churchId) return null;

    // Log inbound message
    await this.prisma.message.create({
      data: {
        church_id: churchId,
        member_id: memberId,
        phone,
        direction: MessageDirection.inbound,
        channel: 'whatsapp',
        content: body,
        status: 'delivered',
        metadata: { termii_message_id: messageId } as Prisma.InputJsonValue,
      },
    });

    return {
      phone,
      body: body.trim(),
      messageId,
      timestamp: timestamp ?? new Date().toISOString(),
      memberId,
      churchId,
    };
  }

  /**
   * Updates the delivery status of a message previously sent via Termii.
   */
  private async handleTermiiStatusUpdate(
    messageId: string,
    status: string,
    churchId: string,
  ): Promise<void> {
    try {
      await this.prisma.message.updateMany({
        where: {
          church_id: churchId,
          OR: [
            { metadata: { path: ['termii_request_id'], equals: messageId } },
            { metadata: { path: ['provider_id'], equals: messageId } },
          ],
        },
        data: { status },
      });
    } catch (err) {
      this.logger.warn(`Failed to update status for ${messageId}: ${(err as Error).message}`);
    }
  }

  /**
   * Send an outbound WhatsApp message via Termii.
   * Logs the message to the database.
   */
  async sendMessage(
    to: string,
    content: string,
    churchId: string,
    memberId?: string,
  ): Promise<MessageResponseDto> {
    try {
      const result = await this.termiiService.sendWhatsAppMessage(to, content, churchId);

      // Log outbound message
      const message = await this.prisma.message.create({
        data: {
          church_id: churchId,
          member_id: memberId ?? null,
          phone: to,
          direction: MessageDirection.outbound,
          channel: 'whatsapp',
          content,
          status: 'sent',
          metadata: {
            termii_request_id: result.requestId,
            ...(result.provider
              ? {
                  provider: result.provider,
                  provider_id: result.requestId,
                  integration_account_id: result.accountId,
                }
              : {}),
          } as Prisma.InputJsonValue,
        },
      });

      this.logger.log(`WhatsApp sent: ${to} (${content.substring(0, 50)}...)`);

      return this.mapMessageToDto(message);
    } catch (err) {
      if (err instanceof InternalServerErrorException) throw err;
      this.logger.error(`WhatsApp send error: ${(err as Error).message}`);
      await this.notifyFailure(churchId, 'WhatsApp message not delivered', (err as Error).message);
      throw new InternalServerErrorException('Failed to send WhatsApp message');
    }
  }

  /**
   * Sends a WhatsApp template message via the Termii WhatsApp Template API.
   *
   * Template messages are required for any outbound message outside the
   * 24-hour customer service window. The template must be pre-approved
   * and registered on the Termii device (subscription page).
   *
   * @param to - Recipient phone number
   * @param templateName - Termii template ID (from the device subscription page)
   * @param language - Template language code (default: en)
   * @param variables - Variable values to populate the template placeholders
   * @param churchId - Church ID for tenant scoping
   * @param memberId - Optional member ID for message logging
   * @returns Created message response
   */
  async sendTemplateMessage(
    to: string,
    templateName: string,
    _language: string,
    variables: Record<string, string> | undefined,
    churchId: string,
    memberId?: string,
  ): Promise<MessageResponseDto> {
    try {
      const result = await this.termiiService.sendWhatsAppTemplate(
        to,
        templateName,
        variables,
        churchId,
      );

      const message = await this.prisma.message.create({
        data: {
          church_id: churchId,
          member_id: memberId ?? null,
          phone: to,
          direction: MessageDirection.outbound,
          channel: 'whatsapp',
          content: `Template: ${templateName}`,
          status: 'sent',
          metadata: {
            termii_request_id: result.requestId,
            ...(result.provider
              ? {
                  provider: result.provider,
                  provider_id: result.requestId,
                  integration_account_id: result.accountId,
                }
              : {}),
            template_name: templateName,
            variables,
          } as Prisma.InputJsonValue,
        },
      });

      this.logger.log(`WhatsApp template sent: ${to} (${templateName})`);

      return this.mapMessageToDto(message);
    } catch (err) {
      if (err instanceof InternalServerErrorException) throw err;
      this.logger.error(`WhatsApp template send error: ${(err as Error).message}`);
      await this.notifyFailure(churchId, 'WhatsApp template not delivered', (err as Error).message);
      throw new InternalServerErrorException('Failed to send WhatsApp template message');
    }
  }

  /**
   * Lists messages with pagination and filters.
   */
  async listMessages(
    churchId: string,
    page = 1,
    limit = 20,
    phone?: string,
    direction?: string,
  ): Promise<{ data: MessageResponseDto[]; total: number }> {
    page = Number.isSafeInteger(page) && page > 0 ? page : 1;
    limit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20;
    const skip = (page - 1) * limit;

    const where: Prisma.MessageWhereInput = {
      church_id: churchId,
    };

    const branchId = this.requestContext.branchWhere(churchId).branch_id;
    if (branchId) {
      const members = await this.prisma.member.findMany({
        where: { church_id: churchId, branch_id: branchId },
        select: { id: true },
      });
      where.member_id = { in: members.map((member) => member.id) };
    }

    if (phone) {
      where.phone = { contains: phone };
    }

    if (direction) {
      where.direction = direction as MessageDirection;
    }

    const [messages, total] = await Promise.all([
      this.prisma.message.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.message.count({ where }),
    ]);

    return {
      data: messages.map((m) => this.mapMessageToDto(m)),
      total,
    };
  }

  // ─── MESSAGE NORMALIZATION ──────────────────────────────────────

  private async normalizeMessage(
    phone: string,
    messageId: string,
    timestamp: string,
    body: string | undefined,
    _phoneNumberId: string | undefined,
    webhookChurchId: string,
  ): Promise<NormalizedMessage | null> {
    if (!body || body.trim().length === 0) {
      this.logger.debug(`Skipping non-text message from ${phone}`);
      return null;
    }

    // Look up member by phone number
    const profile = await this.prisma.profile.findFirst({
      where: { phone, church_id: webhookChurchId },
      select: { church_id: true, member_id: true },
    });

    const churchId = webhookChurchId;
    const memberId = profile?.member_id || null;
    if (!churchId) return null;
    if (!profile) await this.ensureVisitorRecord(phone, churchId);

    // Log inbound message
    await this.prisma.message.create({
      data: {
        church_id: churchId,
        member_id: memberId,
        phone,
        direction: MessageDirection.inbound,
        channel: 'whatsapp',
        content: body,
        status: 'delivered',
        metadata: { wa_message_id: messageId } as Prisma.InputJsonValue,
      },
    });

    return {
      phone,
      body: body.trim(),
      messageId,
      timestamp,
      memberId,
      churchId,
    };
  }

  // ─── COMMAND ROUTER ────────────────────────────────────────────

  private async routeMessage(msg: NormalizedMessage): Promise<void> {
    const text = msg.body.toUpperCase().trim();
    const spaceIdx = text.indexOf(' ');
    const command = spaceIdx === -1 ? text : text.substring(0, spaceIdx);
    const args = spaceIdx === -1 ? '' : msg.body.substring(spaceIdx + 1).trim();

    const handler = this.commandHandlers.get(command);

    if (handler) {
      try {
        const reply = await handler(msg, args);
        if (reply) {
          await this.sendMessage(msg.phone, reply, msg.churchId, msg.memberId ?? undefined);
        }
      } catch (err) {
        this.logger.error(`Command ${command} failed for ${msg.phone}: ${(err as Error).message}`);
        await this.sendMessage(
          msg.phone,
          'Sorry, something went wrong. Please try again later.',
          msg.churchId,
          msg.memberId ?? undefined,
        );
      }
    } else {
      // Unknown command — show help
      const reply = await this.handleHelp(msg, '');
      await this.sendMessage(msg.phone, reply, msg.churchId, msg.memberId ?? undefined);
    }
  }

  // ─── COMMAND HANDLERS ──────────────────────────────────────────

  private async handleHelp(_msg: NormalizedMessage, _args: string): Promise<string> {
    return [
      '🙏 *Welcome to ChurchOS*',
      '',
      'Available commands:',
      '• CHECKIN — Mark your attendance',
      '• GIVE — Get giving instructions',
      '• PRAYER — Submit a prayer request',
      '• EVENTS — See upcoming events',
      '• STATUS — View your giving/attendance',
      '• SERMON — Search recent sermons',
      '• TESTIMONY — Share your testimony',
      '• BIRTHDAY — Check your birthday info',
      '• HELP — Show this message',
    ].join('\n');
  }

  private async handleCheckin(msg: NormalizedMessage, _args: string): Promise<string> {
    if (!msg.memberId) {
      return 'You are not registered as a member. Please visit our church to register.';
    }

    // Find today's service (match day_of_week: 0=Sunday, 6=Saturday)
    const today = new Date();
    const dayOfWeek = today.getDay(); // 0=Sunday

    const service = await this.prisma.service.findFirst({
      where: {
        church_id: msg.churchId,
        is_active: true,
        day_of_week: dayOfWeek,
      },
      orderBy: { created_at: 'asc' },
    });

    if (!service) {
      return 'No service scheduled for today. Check EVENTS for upcoming services.';
    }

    // Check for duplicate check-in
    const existing = await this.prisma.attendance.findFirst({
      where: {
        service_id: service.id,
        member_id: msg.memberId,
      },
    });

    if (existing) {
      return `You are already checked in for today's ${service.name || 'service'}.`;
    }

    // Record attendance
    await this.prisma.attendance.create({
      data: {
        church_id: msg.churchId,
        service_id: service.id,
        member_id: msg.memberId,
        checkin_at: new Date(),
        source: 'whatsapp',
      },
    });

    await this.audit.log({
      userId: msg.memberId,
      churchId: msg.churchId,
      entity: 'attendance',
      action: 'CREATE',
      entityId: service.id,
      newValues: { source: 'whatsapp', phone: msg.phone },
    });

    this.logger.log(`Check-in via WhatsApp: ${msg.phone} → ${service.name || 'service'}`);

    return `✅ You're checked in for ${service.name || "today's service"}! God bless you.`;
  }

  private async handleGive(msg: NormalizedMessage, _args: string): Promise<string> {
    const config = await this.prisma.churchConfig.findUnique({
      where: { church_id_key: { church_id: msg.churchId, key: 'giving_link' } },
    });

    const givingUrl = config?.value || this.config.get<string>('WEB_URL', '');

    return [
      '💰 *Giving Options*',
      '',
      'You can give via:',
      `🏦 Bank Transfer — Use your phone number as reference`,
      `🔗 Online — ${givingUrl}/give`,
      '📱 USSD — *737*000*Amount#',
      '',
      'For Cash giving, visit the church office.',
      'God loves a cheerful giver! 🙏',
    ].join('\n');
  }

  private async handlePrayer(msg: NormalizedMessage, args: string): Promise<string> {
    if (!msg.memberId) {
      return 'You are not registered as a member. Please visit our church to register for prayer requests.';
    }

    if (!args || args.trim().length === 0) {
      return 'Please type your prayer request after the command.\nExample: PRAYER Please pray for my family';
    }

    // Store prayer request as a pastoral note (simplified)
    await this.audit.log({
      userId: msg.memberId,
      churchId: msg.churchId,
      entity: 'prayer_request',
      action: 'CREATE',
      entityId: msg.memberId,
      newValues: { content: args, source: 'whatsapp', phone: msg.phone },
    });

    this.logger.log(`Prayer request from ${msg.phone}: ${args.substring(0, 50)}...`);

    return '🙏 Thank you for your prayer request. Our prayer team will stand with you in prayer. God hears and answers!';
  }

  private async handleEvents(msg: NormalizedMessage, _args: string): Promise<string> {
    const today = new Date();

    const events = await this.prisma.event.findMany({
      where: {
        church_id: msg.churchId,
        // Future starts plus still-live recurring events — same rule as the
        // events list "upcoming" filter, so the desk never misses a weekly.
        AND: [
          {
            OR: [
              { start_date: { gte: today } },
              {
                recurrence: { in: ['weekly', 'multi_day'] },
                start_date: { lt: today },
                OR: [{ end_date: null }, { end_date: { gte: today } }],
              },
            ],
          },
        ],
      },
      orderBy: { start_date: 'asc' },
      take: 15,
    });

    const dated = events
      .map((event) => ({
        event,
        next: nextEventOccurrence(event, today),
      }))
      .filter((row): row is { event: (typeof events)[number]; next: Date } => !!row.next)
      .sort((a, b) => a.next.getTime() - b.next.getTime())
      .slice(0, 5);

    if (dated.length === 0) {
      return '📅 No upcoming events at this time. Check back later!';
    }

    const lines = ['📅 *Upcoming Events*', ''];
    for (const { event, next } of dated) {
      const date = next.toLocaleDateString('en-NG', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      });
      lines.push(`• *${event.title}* — ${date}`);
      if (event.description) {
        lines.push(`  ${event.description.substring(0, 80)}`);
      }
    }

    return lines.join('\n');
  }

  private async handleStatus(msg: NormalizedMessage, _args: string): Promise<string> {
    if (!msg.memberId) {
      return 'You are not registered as a member. Please visit our church to register.';
    }

    // Get attendance count (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const attendanceCount = await this.prisma.attendance.count({
      where: {
        member_id: msg.memberId,
        checkin_at: { gte: thirtyDaysAgo },
      },
    });

    // Get giving total (last 30 days)
    const givingResult = await this.prisma.transaction.aggregate({
      where: {
        member_id: msg.memberId,
        status: 'success',
        created_at: { gte: thirtyDaysAgo },
      },
      _sum: { amount: true },
      _count: true,
    });

    const givingTotal = givingResult._sum.amount || 0;
    const givingCount = givingResult._count;

    return [
      '📊 *Your Status (Last 30 Days)*',
      '',
      `✅ Attendance: ${attendanceCount} service(s)`,
      `💰 Giving: ${givingCount} gift(s) — ₦${givingTotal.toLocaleString()}`,
    ].join('\n');
  }

  private async handleSermon(msg: NormalizedMessage, args: string): Promise<string> {
    if (!msg.memberId) {
      return 'You are not registered as a member. Please visit our church to register.';
    }

    const query: Record<string, unknown> = {
      church_id: msg.churchId,
    };

    if (args) {
      const terms = args.split(/\s+/).filter(Boolean);
      query.OR = terms.map((term) => ({
        OR: [
          { title: { contains: term, mode: 'insensitive' } },
          { speaker: { contains: term, mode: 'insensitive' } },
          { series: { contains: term, mode: 'insensitive' } },
          { tags: { contains: term, mode: 'insensitive' } },
        ],
      }));
    }

    const sermons = await this.prisma.sermon.findMany({
      where: query as never,
      orderBy: { sermon_date: 'desc' },
      take: 5,
    });

    if (sermons.length === 0) {
      return args
        ? `🔍 No sermons found matching "${args}". Try a different search term.`
        : '📚 No sermons available yet. Check back later!';
    }

    const lines = ['📚 *Recent Sermons*', ''];
    for (const sermon of sermons) {
      const date = sermon.sermon_date
        ? new Date(sermon.sermon_date).toLocaleDateString('en-NG', {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
          })
        : '';
      lines.push(`• *${sermon.title}* — ${sermon.speaker || 'Unknown speaker'}`);
      if (date) lines.push(`  ${date}`);
      if (sermon.description) {
        lines.push(`  ${sermon.description.substring(0, 80)}`);
      }
    }

    return lines.join('\n');
  }

  private async handleTestimony(msg: NormalizedMessage, args: string): Promise<string> {
    if (!args.trim()) {
      return [
        '🙌 *Share Your Testimony*',
        '',
        'Type TESTIMONY followed by your testimony:',
        "TESTIMONY God healed me during last week's service!",
      ].join('\n');
    }

    await this.audit.log({
      userId: msg.memberId || 'anonymous',
      churchId: msg.churchId,
      entity: 'testimony',
      action: 'CREATE',
      newValues: {
        phone: msg.phone,
        content: args.substring(0, 500),
        receivedAt: new Date().toISOString(),
      },
    });

    return [
      '🙌 *Thank you for sharing your testimony!*',
      '',
      'Your testimony has been received and will be reviewed by our pastoral team.',
      'May God continue to bless you abundantly!',
    ].join('\n');
  }

  private async handleBirthday(msg: NormalizedMessage, _args: string): Promise<string> {
    if (!msg.memberId) {
      return 'You are not registered as a member. Please visit our church to register.';
    }

    const profile = await this.prisma.profile.findUnique({
      where: { id: msg.memberId },
      select: { first_name: true, member_id: true },
    });

    if (!profile) {
      return 'Profile not found. Please visit our church to register.';
    }

    if (!profile.member_id) {
      return [
        '🎂 *Birthday Update*',
        '',
        "We don't have your birthday on file yet.",
        'Please update your profile at the church reception to add your birthday.',
      ].join('\n');
    }

    const member = await this.prisma.member.findUnique({
      where: { id: profile.member_id },
      select: { date_of_birth: true },
    });

    if (!member?.date_of_birth) {
      return [
        '🎂 *Birthday Update*',
        '',
        "We don't have your birthday on file yet.",
        'Please update your profile at the church reception to add your birthday.',
      ].join('\n');
    }

    const today = new Date();
    const dob = new Date(member.date_of_birth);
    const thisYear = today.getFullYear();
    const birthday = new Date(thisYear, dob.getMonth(), dob.getDate());

    if (birthday < today) {
      birthday.setFullYear(thisYear + 1);
    }

    const daysUntil = Math.ceil((birthday.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

    return [
      `🎂 *Birthday Info for ${profile.first_name || 'Member'}*`,
      '',
      `Your birthday is on ${dob.toLocaleDateString('en-NG', { month: 'long', day: 'numeric' })}.`,
      daysUntil > 0
        ? `⏰ ${daysUntil} day(s) until your next birthday!`
        : `🎉 Today is your birthday! Happy birthday! 🎉`,
    ].join('\n');
  }

  // ─── STATUS UPDATES ────────────────────────────────────────────

  private async handleStatusUpdates(
    statuses: { id: string; status: string; timestamp?: string }[],
    churchId: string,
  ): Promise<void> {
    for (const status of statuses) {
      try {
        await this.prisma.message.updateMany({
          where: {
            church_id: churchId,
            OR: [
              { metadata: { path: ['wa_message_id'], equals: status.id } },
              { metadata: { path: ['provider_id'], equals: status.id } },
              { metadata: { path: ['termii_request_id'], equals: status.id } },
            ],
          },
          data: { status: status.status },
        });
      } catch (err) {
        this.logger.warn(`Failed to update status for ${status.id}: ${(err as Error).message}`);
      }
    }
  }

  // ─── MAPPERS ───────────────────────────────────────────────────

  private async ensureVisitorRecord(phone: string, churchId: string): Promise<void> {
    const existing = await this.prisma.visitor.findFirst({
      where: {
        church_id: churchId,
        whatsapp_number: phone,
      },
      select: { id: true },
    });

    if (existing) {
      return;
    }

    await this.prisma.visitor.create({
      data: {
        church_id: churchId,
        first_name: 'WhatsApp',
        last_name: 'Visitor',
        whatsapp_number: phone,
        phone,
        follow_up_status: 'new',
      },
    });

    this.logger.log(`Visitor record created for ${phone} in church ${churchId}`);
  }

  private mapMessageToDto(
    message: Record<string, unknown> & { id: string; created_at: Date },
  ): MessageResponseDto {
    return {
      messageId: message.id,
      churchId: message.church_id as string,
      memberId: (message.member_id as string) || undefined,
      phone: message.phone as string,
      direction: message.direction as string,
      channel: message.channel as string,
      content: (message.content as string) || undefined,
      mediaUrl: (message.media_url as string) || undefined,
      status: message.status as string,
      createdAt: message.created_at.toISOString(),
    };
  }
}
