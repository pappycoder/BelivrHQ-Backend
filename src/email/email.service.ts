import { RequestContextService } from '../common/services/request-context.service';
/**
 * @file email.service.ts
 * @description Service for internal in-app email (email-style private messaging).
 *
 * Messages are stored as a body (email_messages) with per-recipient copies
 * (email_recipients). Recipients are restricted to eligible staff roles
 * within the same church. Trash is a soft-delete: setting
 * `deleted_at` on the recipient copy (inbox trash) or the message (sent trash);
 * hard-deleting from trash permanently removes the rows.
 *
 * @module email/email.service
 * @since 1.0.0
 */

import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLoggingService } from '../common/services/audit-logging.service';
import { SendEmailDto } from './dto/send-email.dto';
import {
  EmailContactDto,
  EmailDetailDto,
  EmailItemDto,
  EmailListEnvelopeDto,
} from './dto/email-response.dto';
import { EmailBox } from './dto/list-emails.dto';
import { Prisma } from '@prisma/client';

/**
 * Staff roles eligible to receive/send internal email.
 */
export const MAIN_ROLES = [
  'super_admin',
  'senior_pastor',
  'church_admin',
  'branch_pastor',
  'department_head',
  'secretary',
  'treasurer',
  'usher',
] as const;

interface ContactRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  role: string[];
  status: string;
  branch_id: string | null;
  avatar_url: string | null;
  branch?: { id: string; name: string } | null;
}

interface MessageLike {
  id: string;
  church_id: string;
  sender_id: string;
  sender_name: string | null;
  subject: string;
  body: string;
  reply_to_id: string | null;
  deleted_at: Date | null;
  created_at: Date;
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly requestContext: RequestContextService,
    private readonly audit: AuditLoggingService,
  ) {}

  /**
   * Send an internal email to one or more main-role recipients in the same church.
   */
  async send(
    dto: SendEmailDto,
    churchId: string,
    senderId: string,
    userId: string,
  ): Promise<EmailDetailDto> {
    if (dto.replyToId) {
      const parent = await this.prisma.emailMessage.findFirst({
        where: {
          id: dto.replyToId,
          church_id: churchId,
          OR: [{ sender_id: senderId }, { recipients: { some: { profile_id: senderId } } }],
        },
      });
      if (!parent) throw new NotFoundException('Reply message not found');
    }
    const recipientIds = [...new Set(dto.recipientIds)];
    if (recipientIds.includes(senderId)) {
      throw new BadRequestException('You cannot send an email to yourself');
    }

    const recipients = await this.fetchRecipients(churchId, recipientIds);
    if (recipients.length === 0) {
      throw new BadRequestException('No valid recipients selected');
    }

    const sender = await this.prisma.profile.findFirst({
      where: { id: senderId, church_id: churchId },
      select: { first_name: true, last_name: true },
    });
    const senderName = sender
      ? [sender.first_name, sender.last_name].filter(Boolean).join(' ').trim()
      : undefined;

    const message = await this.prisma.emailMessage.create({
      data: {
        church_id: churchId,
        sender_id: senderId,
        sender_name: senderName || null,
        subject: dto.subject,
        body: dto.body,
        reply_to_id: dto.replyToId ?? null,
      },
    });

    await this.prisma.emailRecipient.createMany({
      data: recipients.map((r) => ({
        message_id: message.id,
        profile_id: r.id,
      })),
    });

    await this.audit.log({
      churchId,
      userId,
      entity: 'email',
      action: 'CREATE',
      entityId: message.id,
      newValues: {
        subject: dto.subject,
        sender_id: senderId,
        recipient_ids: recipientIds,
      },
    });

    const detail = await this.buildDetail(message, recipients, churchId);
    this.logger.log(
      `Email ${message.id} sent by ${senderId} to ${recipients.length} recipient(s) in church ${churchId}`,
    );
    return detail;
  }

  /**
   * List emails for the current user across the inbox or sent box.
   */
  async list(
    churchId: string,
    profileId: string,
    page = 1,
    limit = 30,
    box: EmailBox = EmailBox.Inbox,
    includeTrashed = false,
  ): Promise<EmailListEnvelopeDto> {
    const skip = (page - 1) * limit;
    const trashFilter = includeTrashed ? { deleted_at: { not: null } } : { deleted_at: null };

    if (box === EmailBox.Sent) {
      const where: Prisma.EmailMessageWhereInput = {
        church_id: churchId,
        sender_id: profileId,
        ...trashFilter,
      };
      const [messages, total] = await Promise.all([
        this.prisma.emailMessage.findMany({
          where,
          orderBy: { created_at: 'desc' },
          skip,
          take: limit,
        }),
        this.prisma.emailMessage.count({ where }),
      ]);

      const recipientRows = await this.fetchRecipientRows(
        churchId,
        messages.map((m) => m.id),
      );

      const senderAvatar = await this.resolveSenderAvatars(churchId, [profileId]);
      const myAvatar = senderAvatar.get(profileId);

      const data = messages.map((m) =>
        this.mapSentItem(m, recipientRows.get(m.id) || [], myAvatar),
      );

      return { data, total, unreadCount: 0 };
    }

    const where: Prisma.EmailRecipientWhereInput = {
      profile_id: profileId,
      message: { church_id: churchId },
      ...trashFilter,
    };
    const [recipientCopies, total, unreadCount] = await Promise.all([
      this.prisma.emailRecipient.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.emailRecipient.count({ where }),
      this.prisma.emailRecipient.count({
        where: { profile_id: profileId, read_at: null, deleted_at: null },
      }),
    ]);

    const messageIds = recipientCopies.map((r) => r.message_id);
    const messageRows = await this.fetchMessages(churchId, messageIds);

    const senderIds = [...new Set([...messageRows.values()].map((m) => m.sender_id))];
    const avatarMap = await this.resolveSenderAvatars(churchId, senderIds);

    const data = recipientCopies
      .map((copy) => {
        const msg = messageRows.get(copy.message_id);
        if (!msg) return null;
        return this.mapInboxItem(copy, msg, avatarMap.get(msg.sender_id));
      })
      .filter((item): item is EmailItemDto => item !== null);

    return { data, total, unreadCount };
  }

  /** Read-only, participant-scoped thread traversal. Inaccessible parents stop traversal. */
  async getThread(
    messageId: string,
    churchId: string,
    profileId: string,
  ): Promise<{ data: EmailDetailDto[]; truncated: boolean }> {
    const access: Prisma.EmailMessageWhereInput = {
      church_id: churchId,
      OR: [{ sender_id: profileId }, { recipients: { some: { profile_id: profileId } } }],
    };
    const first = await this.prisma.emailMessage.findFirst({
      where: { AND: [access, { id: messageId }] },
    });
    if (!first) throw new NotFoundException('Email not found');
    let root: MessageLike = first;
    const ancestors = new Set<string>([root.id]);
    let truncated = false;
    while (root.reply_to_id && ancestors.size < 50) {
      if (ancestors.has(root.reply_to_id)) {
        truncated = true;
        break;
      }
      const parent = await this.prisma.emailMessage.findFirst({
        where: { AND: [access, { id: root.reply_to_id }] },
      });
      if (!parent) break;
      ancestors.add(parent.id);
      root = parent;
    }
    if (ancestors.size === 50 && root.reply_to_id) truncated = true;
    const messages = new Map<string, MessageLike>([[root.id, root]]);
    let frontier = [root.id];
    while (frontier.length && messages.size < 200) {
      const children = await this.prisma.emailMessage.findMany({
        where: {
          AND: [access, { reply_to_id: { in: frontier }, id: { notIn: [...messages.keys()] } }],
        },
        orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
        take: 201 - messages.size,
      });
      frontier = [];
      for (const child of children) {
        if (messages.size === 200) {
          truncated = true;
          break;
        }
        messages.set(child.id, child);
        frontier.push(child.id);
      }
    }
    if (frontier.length && messages.size === 200) truncated = true;
    // A wide branch must not push the message the caller opened out of a bounded result.
    if (!messages.has(first.id)) {
      if (messages.size >= 200) messages.delete([...messages.keys()][messages.size - 1]);
      messages.set(first.id, first);
      truncated = true;
    }
    const ordered = [...messages.values()].sort(
      (a, b) => a.created_at.getTime() - b.created_at.getTime() || a.id.localeCompare(b.id),
    );
    const copies = await this.prisma.emailRecipient.findMany({
      where: {
        message_id: { in: ordered.map((message) => message.id) },
        message: { church_id: churchId },
        OR: [{ profile_id: profileId }, { message: { sender_id: profileId } }],
      },
    });
    const senders = await this.prisma.profile.findMany({
      where: {
        church_id: churchId,
        id: { in: [...new Set(ordered.map((message) => message.sender_id))] },
      },
      select: { id: true, first_name: true, last_name: true, avatar_url: true },
    });
    const senderMap = new Map(senders.map((sender) => [sender.id, sender]));
    const data: EmailDetailDto[] = ordered.map((message) => {
      const visibleCopies = copies.filter(
        (copy) =>
          copy.message_id === message.id &&
          (message.sender_id === profileId || copy.profile_id === profileId),
      );
      const ownCopy = visibleCopies.find((copy) => copy.profile_id === profileId);
      const sender = senderMap.get(message.sender_id);
      return {
        id: message.id,
        subject: message.subject,
        body: message.body,
        senderId: message.sender_id,
        senderName:
          message.sender_name ??
          (sender
            ? [sender.first_name, sender.last_name].filter(Boolean).join(' ').trim()
            : undefined),
        senderAvatarUrl: sender?.avatar_url ?? undefined,
        recipientIds: visibleCopies.map((copy) => copy.profile_id),
        readAt: ownCopy?.read_at?.toISOString(),
        deletedAt: (
          ownCopy?.deleted_at ?? (message.sender_id === profileId ? message.deleted_at : undefined)
        )?.toISOString(),
        replyToId: message.reply_to_id ?? undefined,
        createdAt: message.created_at.toISOString(),
      };
    });
    return { data, truncated };
  }

  /** Get a single email, marking only the caller's unread inbox copy read. */
  async getOne(messageId: string, churchId: string, profileId: string): Promise<EmailDetailDto> {
    const message = await this.prisma.emailMessage.findFirst({
      where: { id: messageId, church_id: churchId },
    });
    if (!message) {
      throw new NotFoundException('Email not found');
    }

    const copies = await this.prisma.emailRecipient.findMany({
      where: { message_id: messageId, profile_id: profileId },
    });

    const isRecipient = copies.length > 0;
    const isSender = message.sender_id === profileId;
    if (!isRecipient && !isSender) {
      throw new NotFoundException('Email not found');
    }

    let readAt: Date | undefined;
    let deletedAt: Date | undefined;
    if (isRecipient) {
      const copy = copies[0];
      readAt = copy.read_at ?? undefined;
      deletedAt = copy.deleted_at ?? undefined;
      if (!copy.read_at) {
        await this.prisma.emailRecipient.update({
          where: { id: copy.id },
          data: { read_at: new Date() },
        });
        readAt = new Date();
      }
    } else {
      deletedAt = message.deleted_at ?? undefined;
    }

    const visibleCopies = isSender
      ? ((await this.prisma.emailRecipient.findMany({ where: { message_id: messageId } })) ?? [])
      : copies;
    const recipients = await this.fetchRecipients(
      churchId,
      visibleCopies.map((c) => c.profile_id),
    );
    return this.buildDetail(message, recipients, churchId, readAt, deletedAt);
  }

  /**
   * Get the unread inbox count for the current user.
   */
  async getUnreadCount(churchId: string, profileId: string): Promise<number> {
    return this.prisma.emailRecipient.count({
      where: {
        profile_id: profileId,
        read_at: null,
        deleted_at: null,
        message: { church_id: churchId },
      },
    });
  }

  /**
   * Mark a received email as read.
   */
  async markRead(
    messageId: string,
    churchId: string,
    profileId: string,
  ): Promise<{ success: boolean }> {
    const copy = await this.prisma.emailRecipient.findFirst({
      where: { message_id: messageId, profile_id: profileId, message: { church_id: churchId } },
    });
    if (!copy) throw new NotFoundException('Email not found');
    if (!copy.read_at) {
      await this.prisma.emailRecipient.update({
        where: { id: copy.id },
        data: { read_at: new Date() },
      });
    }
    return { success: true };
  }

  /**
   * Mark a received email as unread.
   */
  async markUnread(
    messageId: string,
    churchId: string,
    profileId: string,
  ): Promise<{ success: boolean }> {
    const copy = await this.prisma.emailRecipient.findFirst({
      where: { message_id: messageId, profile_id: profileId, message: { church_id: churchId } },
    });
    if (!copy) throw new NotFoundException('Email not found');
    await this.prisma.emailRecipient.update({
      where: { id: copy.id },
      data: { read_at: null },
    });
    return { success: true };
  }

  /**
   * Soft-delete (move to trash). Inbox copies soft-delete the recipient copy;
   * sent messages soft-delete the message.
   */
  async trash(
    messageId: string,
    churchId: string,
    profileId: string,
  ): Promise<{ success: boolean }> {
    const message = await this.prisma.emailMessage.findFirst({
      where: { id: messageId, church_id: churchId },
    });
    if (!message) throw new NotFoundException('Email not found');

    const copy = await this.prisma.emailRecipient.findFirst({
      where: { message_id: messageId, profile_id: profileId },
    });

    if (copy) {
      await this.prisma.emailRecipient.update({
        where: { id: copy.id },
        data: { deleted_at: new Date() },
      });
    } else if (message.sender_id === profileId) {
      await this.prisma.emailMessage.update({
        where: { id: messageId },
        data: { deleted_at: new Date() },
      });
    } else {
      throw new NotFoundException('Email not found');
    }

    return { success: true };
  }

  /**
   * Restore a trashed email back to its active box.
   */
  async restore(
    messageId: string,
    churchId: string,
    profileId: string,
  ): Promise<{ success: boolean }> {
    const message = await this.prisma.emailMessage.findFirst({
      where: { id: messageId, church_id: churchId },
    });
    if (!message) throw new NotFoundException('Email not found');

    const copy = await this.prisma.emailRecipient.findFirst({
      where: { message_id: messageId, profile_id: profileId },
    });

    if (copy) {
      await this.prisma.emailRecipient.update({
        where: { id: copy.id },
        data: { deleted_at: null },
      });
    } else if (message.sender_id === profileId) {
      await this.prisma.emailMessage.update({
        where: { id: messageId },
        data: { deleted_at: null },
      });
    } else {
      throw new NotFoundException('Email not found');
    }

    return { success: true };
  }

  /**
   * Hard-delete a trashed email (permanent purge from trash).
   */
  async deleteForever(
    messageId: string,
    churchId: string,
    profileId: string,
  ): Promise<{ success: boolean }> {
    const message = await this.prisma.emailMessage.findFirst({
      where: { id: messageId, church_id: churchId },
    });
    if (!message) throw new NotFoundException('Email not found');

    const copy = await this.prisma.emailRecipient.findFirst({
      where: { message_id: messageId, profile_id: profileId },
    });

    if (copy) {
      if (!copy.deleted_at) {
        throw new BadRequestException('Email must be trashed before permanent deletion');
      }
      await this.prisma.emailRecipient.delete({ where: { id: copy.id } });
    } else if (message.sender_id === profileId) {
      if (!message.deleted_at) {
        throw new BadRequestException('Email must be trashed before permanent deletion');
      }
      // Remove this sender's message; other recipients' copies are independent.
      await this.prisma.emailMessage.delete({ where: { id: messageId } });
    } else {
      throw new NotFoundException('Email not found');
    }

    return { success: true };
  }

  /**
   * List selectable recipient contacts (main roles in the same church), excluding
   * the requesting user unless `includeSelf` is true.
   */
  async listContacts(
    churchId: string,
    excludeId: string,
    search?: string,
    branchId?: string,
    role?: string,
    includeSelf = false,
  ): Promise<{ data: EmailContactDto[]; total: number }> {
    const where: Prisma.ProfileWhereInput = {
      church_id: churchId,
      status: { not: 'inactive' },
      role: { hasSome: [...MAIN_ROLES] },
    };

    if (!includeSelf) {
      where.id = { not: excludeId };
    }
    if (branchId) {
      where.branch_id = branchId;
    }
    Object.assign(where, this.requestContext.branchWhere(churchId));
    if (role && (MAIN_ROLES as readonly string[]).includes(role)) {
      where.role = { has: role };
    }
    if (search) {
      const q = search.trim();
      if (q) {
        where.OR = [
          { first_name: { contains: q, mode: 'insensitive' } },
          { last_name: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
        ];
      }
    }

    const profiles = await this.prisma.profile.findMany({
      where,
      take: 100,
      orderBy: [{ first_name: 'asc' }, { last_name: 'asc' }],
      include: { branch: { select: { id: true, name: true } } },
    });

    const data = profiles.map((p) => this.mapContact(p));
    return { data, total: data.length };
  }

  // ── private helpers ────────────────────────────────────────

  /**
   * Fetch and validate recipient profiles (main roles, same church).
   * Returns only rows present in the DB; callers treat missing rows as invalid.
   */
  private async fetchRecipients(churchId: string, ids: string[]): Promise<ContactRow[]> {
    const rows = await this.prisma.profile.findMany({
      where: {
        id: { in: ids },
        church_id: churchId,
        ...this.requestContext.branchWhere(churchId),
      },
      select: {
        id: true,
        first_name: true,
        last_name: true,
        email: true,
        role: true,
        status: true,
        branch_id: true,
        avatar_url: true,
        branch: { select: { id: true, name: true } },
      },
    });
    return rows.filter(
      (r) =>
        r.status !== 'inactive' &&
        (r.role as string[]).some((rr) => (MAIN_ROLES as readonly string[]).includes(rr)),
    );
  }

  private async fetchRecipientRows(
    churchId: string,
    messageIds: string[],
  ): Promise<Map<string, ContactRow[]>> {
    const map = new Map<string, ContactRow[]>();
    if (messageIds.length === 0) return map;

    const copies = await this.prisma.emailRecipient.findMany({
      where: { message_id: { in: messageIds } },
      select: { message_id: true, profile_id: true },
    });

    const ids = [...new Set(copies.map((c) => c.profile_id))];
    const rows = await this.prisma.profile.findMany({
      where: { id: { in: ids }, church_id: churchId },
      select: {
        id: true,
        first_name: true,
        last_name: true,
        email: true,
        role: true,
        status: true,
        branch_id: true,
        avatar_url: true,
        branch: { select: { id: true, name: true } },
      },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));

    for (const copy of copies) {
      const row = byId.get(copy.profile_id);
      if (row) {
        map.set(copy.message_id, [...(map.get(copy.message_id) || []), row]);
      }
    }
    return map;
  }

  private async fetchMessages(
    churchId: string,
    messageIds: string[],
  ): Promise<Map<string, MessageLike>> {
    const map = new Map<string, MessageLike>();
    if (messageIds.length === 0) return map;
    const rows = await this.prisma.emailMessage.findMany({
      where: { id: { in: messageIds }, church_id: churchId },
    });
    for (const r of rows) map.set(r.id, r);
    return map;
  }

  private async buildDetail(
    message: MessageLike,
    recipients: ContactRow[],
    churchId: string,
    readAt?: Date,
    deletedAt?: Date,
  ): Promise<EmailDetailDto> {
    let senderName: string | undefined;
    let senderAvatarUrl: string | undefined;
    if (message.sender_name) {
      senderName = message.sender_name;
      const senderProfile = await this.prisma.profile.findFirst({
        where: { id: message.sender_id, church_id: churchId },
        select: { avatar_url: true },
      });
      senderAvatarUrl = senderProfile?.avatar_url ?? undefined;
    } else {
      const sender = await this.prisma.profile.findFirst({
        where: { id: message.sender_id, church_id: churchId },
        select: { first_name: true, last_name: true, avatar_url: true },
      });
      senderName = sender
        ? [sender.first_name, sender.last_name].filter(Boolean).join(' ').trim()
        : undefined;
      senderAvatarUrl = sender?.avatar_url ?? undefined;
    }

    return {
      id: message.id,
      subject: message.subject,
      body: message.body,
      senderId: message.sender_id,
      senderName,
      senderAvatarUrl,
      recipientIds: recipients.map((r) => r.id),
      readAt: readAt ? readAt.toISOString() : undefined,
      deletedAt: deletedAt ? deletedAt.toISOString() : undefined,
      replyToId: message.reply_to_id ?? undefined,
      createdAt: message.created_at.toISOString(),
    };
  }

  private async resolveSenderAvatars(
    churchId: string,
    senderIds: string[],
  ): Promise<Map<string, string | undefined>> {
    const map = new Map<string, string | undefined>();
    if (senderIds.length === 0) return map;
    const profiles = await this.prisma.profile.findMany({
      where: { id: { in: senderIds }, church_id: churchId },
      select: { id: true, avatar_url: true },
    });
    for (const p of profiles) map.set(p.id, p.avatar_url ?? undefined);
    return map;
  }

  private mapInboxItem(
    copy: { message_id: string; read_at: Date | null; deleted_at: Date | null },
    msg: {
      id: string;
      subject: string;
      body: string;
      sender_id: string;
      sender_name: string | null;
      created_at: Date;
    },
    senderAvatarUrl?: string,
  ): EmailItemDto {
    return {
      id: msg.id,
      subject: msg.subject,
      preview: this.preview(msg.body),
      senderId: msg.sender_id,
      senderName: msg.sender_name ?? undefined,
      senderAvatarUrl,
      recipientId: '',
      recipientName: '',
      readAt: copy.read_at ? copy.read_at.toISOString() : undefined,
      deletedAt: copy.deleted_at ? copy.deleted_at.toISOString() : undefined,
      createdAt: msg.created_at.toISOString(),
    };
  }

  private mapSentItem(
    msg: {
      id: string;
      subject: string;
      body: string;
      sender_id: string;
      sender_name: string | null;
      created_at: Date;
      deleted_at: Date | null;
    },
    recipients: ContactRow[],
    senderAvatarUrl?: string,
  ): EmailItemDto {
    return {
      id: msg.id,
      subject: msg.subject,
      preview: this.preview(msg.body),
      senderId: msg.sender_id,
      senderName: msg.sender_name ?? undefined,
      senderAvatarUrl,
      recipientId: recipients[0]?.id ?? '',
      recipientName: recipients.map((r) => this.fullName(r)).join(', '),
      readAt: undefined,
      deletedAt: msg.deleted_at ? msg.deleted_at.toISOString() : undefined,
      createdAt: msg.created_at.toISOString(),
    };
  }

  private mapContact(
    p: Record<string, unknown> & {
      id: string;
      first_name: string | null;
      last_name: string | null;
      email: string | null;
      role: string[];
      branch_id: string | null;
      avatar_url: string | null;
      branch?: { id: string; name: string } | null;
    },
  ): EmailContactDto {
    return {
      id: p.id,
      name: this.fullName(p),
      role: (p.role as string[])[0] || '',
      email: p.email ?? undefined,
      branchId: p.branch_id ?? undefined,
      branchName: p.branch?.name,
      avatarUrl: p.avatar_url ?? undefined,
    };
  }

  private fullName(p: { first_name: string | null; last_name: string | null }): string {
    return [p.first_name, p.last_name].filter(Boolean).join(' ').trim();
  }

  private preview(body: string): string {
    const clean = body.replace(/\s+/g, ' ').trim();
    return clean.length > 120 ? `${clean.slice(0, 120)}…` : clean;
  }
}
