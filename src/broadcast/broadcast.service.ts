import { contentBranch } from '../common/services/content-branch';
import { UpdateBroadcastDto } from './dto/update-broadcast.dto';
import { RequestContextService } from '../common/services/request-context.service';
/**
 * @file broadcast.service.ts
 * @description Business logic for broadcast messaging.
 *
 * Handles broadcast creation, scheduling, audience filtering, and dispatch.
 * Broadcasts use a template and target a filtered audience. The actual
 * per-recipient delivery is delegated to channel-specific outbound queues.
 *
 * @module broadcast/broadcast.service
 * @since 1.0.0
 */

import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLoggingService } from '../common/services/audit-logging.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateBroadcastDto } from './dto/create-broadcast.dto';
import { ListBroadcastsDto } from './dto/list-broadcasts.dto';
import { BroadcastResponseDto } from './dto/broadcast-response.dto';
import { Prisma } from '@prisma/client';
import { channel } from '../integrations/provider-catalog';
import { IntegrationAccountsService } from '../integrations/integration-accounts.service';

/**
 * Audience filter structure for broadcast recipient queries.
 */
interface AudienceFilter {
  status?: string;
  branchId?: string;
  gender?: string;
  search?: string;
}

@Injectable()
export class BroadcastService {
  private readonly logger = new Logger(BroadcastService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly requestContext: RequestContextService,
    private readonly audit: AuditLoggingService,
    private readonly notifications: NotificationsService,
    @InjectQueue('broadcast') private readonly broadcastQueue: Queue,
    @InjectQueue('whatsapp-outbound') private readonly whatsappQueue: Queue,
    @InjectQueue('sms-outbound') private readonly smsQueue: Queue,
    @InjectQueue('email-outbound') private readonly emailQueue: Queue,
    private readonly integrations: IntegrationAccountsService,
  ) {}

  /**
   * Creates a new broadcast.
   *
   * Validates the template, resolves the audience count, and queues the
   * broadcast for processing if scheduled immediately.
   */
  async create(
    dto: CreateBroadcastDto,
    churchId: string,
    userId: string,
  ): Promise<BroadcastResponseDto> {
    const branchId = await this.resolveBranch(
      churchId,
      dto.branchId ?? (dto.audienceFilter?.branchId as string | undefined),
    );
    if (branchId) dto.audienceFilter = { ...dto.audienceFilter, branchId };
    const template = await this.prisma.template.findFirst({
      where: {
        id: dto.templateId,
        church_id: churchId,
        ...(branchId ? { OR: [{ branch_id: branchId }, { branch_id: null }] } : {}),
      },
    });

    if (!template) {
      throw new NotFoundException('Template not found');
    }

    if (template.channel !== dto.channel) {
      throw new BadRequestException(
        `Template channel (${template.channel}) does not match broadcast channel (${dto.channel})`,
      );
    }

    if (template.status !== 'published') {
      throw new BadRequestException('Template must be published before use in a broadcast');
    }

    await this.integrations.resolve(churchId, dto.channel);

    const audienceFilter = (dto.audienceFilter ?? {}) as AudienceFilter;
    const recipients = await this.findRecipients(churchId, dto.channel, audienceFilter);

    if (recipients.length === 0) {
      throw new BadRequestException('No recipients match the selected audience filter');
    }

    const status = dto.scheduledAt ? 'scheduled' : 'draft';

    const broadcast = await this.prisma.broadcast.create({
      data: {
        church_id: churchId,
        name: dto.name,
        template_id: dto.templateId,
        channel: dto.channel,
        audience_filter: audienceFilter as Prisma.InputJsonValue,
        status,
        scheduled_at: dto.scheduledAt ? new Date(dto.scheduledAt) : null,
        total_recipients: recipients.length,
      },
    });

    await this.prisma.broadcastRecipient.createMany({
      data: recipients.map((r) => ({
        broadcast_id: broadcast.id,
        member_id: r.memberId,
        phone: r.phone,
        status: 'pending',
      })),
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'broadcast',
      action: 'CREATE',
      entityId: broadcast.id,
      newValues: {
        name: dto.name,
        templateId: dto.templateId,
        channel: dto.channel,
        totalRecipients: recipients.length,
      },
    });

    this.logger.log(`Broadcast created: ${broadcast.id} (${recipients.length} recipients)`);

    if (!dto.scheduledAt) {
      await this.broadcastQueue.add(
        'send',
        { broadcastId: broadcast.id, churchId },
        { jobId: `broadcast-${broadcast.id}` },
      );
      await this.prisma.broadcast.update({
        where: { id: broadcast.id },
        data: { status: 'sending' },
      });
    }

    return (
      await this.withBranchNames([this.mapToResponseDto(broadcast, template.name)], churchId)
    )[0];
  }

  /**
   * Lists broadcasts for a church with pagination and filters.
   */
  async findAll(
    churchId: string,
    query: ListBroadcastsDto,
  ): Promise<{ data: BroadcastResponseDto[]; total: number }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.BroadcastWhereInput = {
      church_id: churchId,
      ...this.broadcastScope(churchId),
    };
    const ownBranch = this.requestContext.branchWhere(churchId).branch_id;
    if (!ownBranch && query.branchId)
      where.audience_filter = { path: ['branchId'], equals: query.branchId };
    if (query.search?.trim()) {
      const existing = where.AND ? (Array.isArray(where.AND) ? where.AND : [where.AND]) : [];
      where.AND = [
        ...existing,
        {
          OR: [
            { name: { contains: query.search.trim(), mode: 'insensitive' } },
            { template: { name: { contains: query.search.trim(), mode: 'insensitive' } } },
          ],
        },
      ];
    }
    if (query.status) where.status = query.status;
    if (query.channel) where.channel = query.channel;

    const sortFields = {
      name: 'name',
      createdAt: 'created_at',
      scheduledAt: 'scheduled_at',
      sentAt: 'sent_at',
      totalRecipients: 'total_recipients',
      channel: 'channel',
      status: 'status',
    } as const;
    const sortField = sortFields[query.sortBy ?? 'createdAt'] ?? 'created_at';
    const orderBy: Prisma.BroadcastOrderByWithRelationInput[] = [
      { [sortField]: query.sortOrder ?? 'desc' },
      { id: 'asc' },
    ];
    const [broadcasts, total] = await Promise.all([
      this.prisma.broadcast.findMany({
        where,
        orderBy,
        skip,
        take: limit,
      }),
      this.prisma.broadcast.count({ where }),
    ]);

    const templateIds = [...new Set(broadcasts.map((b) => b.template_id))];
    const templates = await this.prisma.template.findMany({
      where: { id: { in: templateIds } },
      select: { id: true, name: true },
    });
    const templateMap = new Map(templates.map((t) => [t.id, t.name]));

    return {
      data: await this.withBranchNames(
        broadcasts.map((b) => this.mapToResponseDto(b, templateMap.get(b.template_id) || '')),
        churchId,
      ),
      total,
    };
  }

  /**
   * Gets a single broadcast by ID.
   */
  async findById(broadcastId: string, churchId: string): Promise<BroadcastResponseDto> {
    const broadcast = await this.prisma.broadcast.findFirst({
      where: { id: broadcastId, church_id: churchId, ...this.broadcastScope(churchId) },
    });

    if (!broadcast) {
      throw new NotFoundException('Broadcast not found');
    }

    const template = await this.prisma.template.findUnique({
      where: { id: broadcast.template_id },
      select: { name: true },
    });

    return (
      await this.withBranchNames([this.mapToResponseDto(broadcast, template?.name || '')], churchId)
    )[0];
  }

  /** Atomically replace the audience before the worker claims a scheduled broadcast. */
  async update(
    broadcastId: string,
    dto: UpdateBroadcastDto,
    churchId: string,
    userId: string,
  ): Promise<BroadcastResponseDto> {
    const existing = await this.prisma.broadcast.findFirst({
      where: { id: broadcastId, church_id: churchId, ...this.broadcastScope(churchId) },
    });
    if (!existing) throw new NotFoundException('Broadcast not found');
    if (
      existing.status !== 'scheduled' ||
      !existing.scheduled_at ||
      existing.scheduled_at <= new Date()
    ) {
      throw new BadRequestException('Only future scheduled broadcasts can change branch');
    }
    const branchId = await this.resolveBranch(churchId, dto.branchId);
    const template = await this.prisma.template.findFirst({
      where: {
        id: existing.template_id,
        church_id: churchId,
        status: 'published',
        archived_at: null,
        OR: [{ branch_id: branchId }, { branch_id: null }],
      },
    });
    if (!template)
      throw new BadRequestException('The template is not available in the selected branch');
    const filter = { ...(existing.audience_filter as AudienceFilter), branchId: branchId! };
    const recipients = await this.findRecipients(churchId, existing.channel, filter);
    if (!recipients.length)
      throw new BadRequestException('No recipients match the selected audience filter');
    await this.prisma.$transaction(async (tx) => {
      // The conditional row update serializes against the worker's sending-state update.
      const claimed = await tx.broadcast.updateMany({
        where: {
          id: broadcastId,
          church_id: churchId,
          status: 'scheduled',
          scheduled_at: { gt: new Date() },
        },
        data: {
          audience_filter: filter as Prisma.InputJsonValue,
          total_recipients: recipients.length,
        },
      });
      if (claimed.count !== 1)
        throw new BadRequestException('Broadcast sending has already started');
      await tx.broadcastRecipient.deleteMany({ where: { broadcast_id: broadcastId } });
      await tx.broadcastRecipient.createMany({
        data: recipients.map((recipient) => ({
          broadcast_id: broadcastId,
          member_id: recipient.memberId,
          phone: recipient.phone,
          status: 'pending',
        })),
      });
    });
    await this.audit.log({
      userId,
      churchId,
      entity: 'broadcast',
      action: 'UPDATE',
      entityId: broadcastId,
      oldValues: { audienceFilter: existing.audience_filter },
      newValues: { branchId, totalRecipients: recipients.length },
    });
    return this.findById(broadcastId, churchId);
  }

  private resolveBranch(churchId: string, requested?: string) {
    const ownBranch = this.requestContext.branchWhere(churchId).branch_id;
    return contentBranch(
      this.prisma,
      { churchOnly: !ownBranch, branchId: ownBranch },
      churchId,
      requested,
    );
  }

  private async withBranchNames(rows: BroadcastResponseDto[], churchId: string) {
    const ids = [...new Set(rows.flatMap((row) => (row.branchId ? [row.branchId] : [])))];
    if (!ids.length) return rows;
    const branches = await this.prisma.branch.findMany({
      where: { id: { in: ids }, church_id: churchId },
      select: { id: true, name: true },
    });
    const names = new Map(branches.map((branch) => [branch.id, branch.name]));
    return rows.map((row) => ({
      ...row,
      branchName: row.branchId ? names.get(row.branchId) : undefined,
    }));
  }

  /**
   * Cancels a scheduled or draft broadcast.
   */
  async cancel(broadcastId: string, churchId: string, userId: string): Promise<void> {
    const broadcast = await this.prisma.broadcast.findFirst({
      where: { id: broadcastId, church_id: churchId, ...this.broadcastScope(churchId) },
    });

    if (!broadcast) {
      throw new NotFoundException('Broadcast not found');
    }

    if (broadcast.status === 'sent' || broadcast.status === 'cancelled') {
      throw new BadRequestException(`Cannot cancel a ${broadcast.status} broadcast`);
    }

    await this.prisma.broadcast.update({
      where: { id: broadcastId },
      data: { status: 'cancelled' },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'broadcast',
      action: 'UPDATE',
      entityId: broadcastId,
      oldValues: { status: broadcast.status },
      newValues: { status: 'cancelled' },
    });

    this.logger.log(`Broadcast cancelled: ${broadcastId}`);
  }

  /**
   * Processes a broadcast by enqueuing messages for each recipient.
   *
   * Called by the BroadcastProcessor.
   */
  async processBroadcast(broadcastId: string, churchId: string): Promise<void> {
    const broadcast = await this.prisma.broadcast.findFirst({
      where: { id: broadcastId, church_id: churchId, ...this.broadcastScope(churchId) },
      include: { template: true },
    });

    if (!broadcast) {
      this.logger.warn(`Broadcast not found: ${broadcastId}`);
      return;
    }

    if (broadcast.status === 'cancelled' || broadcast.status === 'sent') {
      this.logger.log(`Broadcast ${broadcastId} is ${broadcast.status}, skipping`);
      return;
    }

    await this.integrations.resolve(churchId, channel(broadcast.channel));

    await this.prisma.broadcast.update({
      where: { id: broadcastId },
      data: { status: 'sending' },
    });

    const recipients = await this.prisma.broadcastRecipient.findMany({
      where: { broadcast_id: broadcastId, status: 'pending' },
    });

    const template = broadcast.template;
    const variables = Array.isArray(template.variables) ? (template.variables as string[]) : [];

    for (const recipient of recipients) {
      try {
        const member = recipient.member_id
          ? await this.prisma.member.findUnique({
              where: { id: recipient.member_id },
            })
          : null;

        const variableValues = this.buildVariableValues(variables, member);

        await this.enqueueMessage(
          broadcast.channel,
          recipient.phone,
          template.content,
          variableValues,
          churchId,
          recipient.member_id ?? undefined,
          {
            name: template.name,
            externalId: template.external_id,
            language: template.language,
          },
        );

        await this.prisma.broadcastRecipient.update({
          where: { id: recipient.id },
          data: { status: 'sent', sent_at: new Date() },
        });
      } catch (error) {
        this.logger.error(
          `Failed to enqueue broadcast message for ${recipient.phone}: ${error instanceof Error ? error.message : String(error)}`,
        );
        await this.prisma.broadcastRecipient.update({
          where: { id: recipient.id },
          data: {
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }

    await this.prisma.broadcast.update({
      where: { id: broadcastId },
      data: { status: 'sent', sent_at: new Date() },
    });

    await this.notifications
      .broadcastToChurch(
        churchId,
        'broadcast',
        'Broadcast Sent',
        `A ${broadcast.channel} broadcast has been sent to ${recipients.length} recipients.`,
        { broadcastId, channel: broadcast.channel, recipientCount: recipients.length },
      )
      .catch((err) => this.logger.warn(`Broadcast notification failed: ${(err as Error).message}`));

    this.logger.log(`Broadcast processed: ${broadcastId}`);
  }

  /**
   * Finds recipients matching the audience filter.
   */
  private broadcastScope(churchId: string): Prisma.BroadcastWhereInput {
    const branchId = this.requestContext.branchWhere(churchId).branch_id;
    return branchId ? { audience_filter: { path: ['branchId'], equals: branchId } } : {};
  }

  private async findRecipients(
    churchId: string,
    channel: string,
    filter: AudienceFilter,
  ): Promise<{ memberId: string | null; phone: string }[]> {
    const where: Prisma.MemberWhereInput = { church_id: churchId };

    if (filter.status) where.status = filter.status as Prisma.EnumMemberStatusFilter;
    if (filter.branchId) where.branch_id = filter.branchId;
    Object.assign(where, this.requestContext.branchWhere(churchId));
    if (filter.gender) where.gender = filter.gender;

    if (filter.search) {
      const term = filter.search.trim();
      where.OR = [
        { first_name: { contains: term, mode: 'insensitive' } },
        { last_name: { contains: term, mode: 'insensitive' } },
        { email: { contains: term, mode: 'insensitive' } },
        { phone: { contains: term, mode: 'insensitive' } },
      ];
    }

    const members = await this.prisma.member.findMany({
      where,
      select: {
        id: true,
        phone: true,
        whatsapp_number: true,
        email: true,
      },
    });

    return members
      .map((m) => {
        let contact = '';
        if (channel === 'email') {
          contact = m.email || '';
        } else if (channel === 'whatsapp') {
          contact = m.whatsapp_number || m.phone || '';
        } else {
          contact = m.phone || '';
        }
        return { memberId: m.id, phone: contact };
      })
      .filter((r) => r.phone.length > 0);
  }

  /**
   * Builds variable values for a recipient from member data.
   */
  private buildVariableValues(
    variables: string[],
    member: { first_name: string; last_name: string; phone: string | null } | null,
  ): Record<string, string> {
    const values: Record<string, string> = {};

    for (const variable of variables) {
      switch (variable) {
        case 'name':
          values[variable] = member ? `${member.first_name} ${member.last_name}` : '';
          break;
        case 'first_name':
          values[variable] = member?.first_name || '';
          break;
        case 'last_name':
          values[variable] = member?.last_name || '';
          break;
        case 'phone':
          values[variable] = member?.phone || '';
          break;
        default:
          values[variable] = '';
      }
    }

    return values;
  }

  /**
   * Enqueues a message to the appropriate outbound queue.
   */
  private async enqueueMessage(
    channel: string,
    to: string,
    content: string,
    variables: Record<string, string>,
    churchId: string,
    memberId: string | undefined,
    template: { name: string; externalId: string | null; language: string },
  ): Promise<void> {
    switch (channel) {
      case 'whatsapp':
        if (template.externalId) {
          await this.whatsappQueue.add('send-template', {
            to,
            templateName: template.externalId,
            language: template.language,
            variables,
            churchId,
            memberId,
          });
        } else {
          const interpolated = this.interpolateTemplate(content, variables);
          await this.whatsappQueue.add('send', {
            to,
            message: interpolated,
            churchId,
            memberId,
          });
        }
        break;
      case 'sms': {
        const interpolated = this.interpolateTemplate(content, variables);
        await this.smsQueue.add('send', { to, message: interpolated, churchId });
        break;
      }
      case 'email': {
        const interpolated = this.interpolateTemplate(content, variables);
        await this.emailQueue.add('send', {
          to,
          subject: template.name,
          html: interpolated,
          churchId,
        });
        break;
      }
      default:
        throw new BadRequestException(`Unsupported broadcast channel: ${channel}`);
    }
  }

  /**
   * Interpolates variables into a template content string.
   */
  private interpolateTemplate(content: string, variables?: Record<string, string>): string {
    if (!variables) return content;

    return content.replace(/\{\{(\w+)\}\}|\{(\w+)\}/g, (_match, double, single) => {
      const key = double || single;
      return variables[key] ?? '';
    });
  }

  /**
   * Maps a Prisma Broadcast to the response DTO.
   */
  private mapToResponseDto(
    broadcast: {
      id: string;
      church_id: string;
      name: string;
      template_id: string;
      audience_filter?: Prisma.JsonValue;
      channel: string;
      status: string;
      scheduled_at: Date | null;
      sent_at: Date | null;
      total_recipients: number;
      created_at: Date;
      updated_at: Date;
    },
    templateName: string,
  ): BroadcastResponseDto {
    return {
      broadcastId: broadcast.id,
      branchId:
        typeof (broadcast.audience_filter as AudienceFilter | null)?.branchId === 'string'
          ? (broadcast.audience_filter as AudienceFilter).branchId
          : undefined,
      churchId: broadcast.church_id,
      name: broadcast.name,
      templateId: broadcast.template_id,
      templateName,
      channel: broadcast.channel,
      status: broadcast.status,
      scheduledAt: broadcast.scheduled_at?.toISOString(),
      sentAt: broadcast.sent_at?.toISOString(),
      totalRecipients: broadcast.total_recipients,
      createdAt: broadcast.created_at.toISOString(),
      updatedAt: broadcast.updated_at.toISOString(),
    };
  }
}
