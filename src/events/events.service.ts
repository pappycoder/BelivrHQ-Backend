import { attendanceConflict, isAttendanceDuplicate } from '../attendance/attendance-duplicates';
import { contentBranch } from '../common/services/content-branch';
import { attendanceDay } from '../attendance/attendance-day';
import { assertEventOccursOn, assertEventSchedule } from '../attendance/schedule-occurrence';
import { assertPlanFeature } from '../billing/entitlements';
import { attendanceSessionId } from '../attendance/attendance-session-links';
import { PaymentAccountsService } from '../giving/services/payment-accounts.service';
import { RequestContextService } from '../common/services/request-context.service';
/**
 * @file events.service.ts
 * @description Business logic for event management, registration, and ticketing.
 *
 * Handles event CRUD, member registration (free and paid), capacity checks,
 * multi-tier ticket pricing, ticket generation, payment confirmation via
 * webhooks, and event-day ticket validation (check-in).
 *
 * Free events: immediate registration + ticket generation.
 * Paid events: pending registration → payment initialization → webhook
 * confirmation → ticket generation.
 *
 * All queries are scoped by church_id for multi-tenant isolation.
 *
 * @module events/events.service
 * @since 1.0.0
 */

import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLoggingService } from '../common/services/audit-logging.service';
import { BranchScopeService, ViewerScope } from '../common/services/branch-scope.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  PaymentGatewayProvider,
  PAYMENT_GATEWAY_REGISTRY,
} from '../giving/services/payment-gateway.interface';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { EventResponseDto } from './dto/event-response.dto';
import { RegistrationResponseDto } from './dto/registration-response.dto';
import { ListEventsDto } from './dto/list-events.dto';
import { WalkInCheckInDto } from './dto/check-in.dto';
import { AttendanceResponseDto } from '../attendance/dto/attendance-response.dto';
import { Prisma } from '@prisma/client';
import * as crypto from 'crypto';

/**
 * Service for managing church events.
 * Provides event CRUD, registration management, paid ticketing,
 * multi-tier pricing, and ticket validation.
 */
@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly requestContext: RequestContextService,
    private readonly audit: AuditLoggingService,
    @Inject(PAYMENT_GATEWAY_REGISTRY)
    _gatewayRegistry: Map<string, PaymentGatewayProvider>,
    private readonly notifications: NotificationsService,
    private readonly branchScope: BranchScopeService,
    private readonly paymentAccounts: PaymentAccountsService,
  ) {}

  // ─── EVENT CRUD ────────────────────────────────────────────────

  /**
   * Creates a new event.
   *
   * @param dto - Event creation data
   * @param churchId - Church ID for tenant scoping
   * @param userId - ID of the user creating the event (for audit)
   * @returns Created event response
   */
  async createEvent(
    dto: CreateEventDto,
    churchId: string,
    userId: string,
  ): Promise<EventResponseDto> {
    const branchId = await contentBranch(
      this.prisma,
      this.branchScope.resolve(),
      churchId,
      dto.branchId,
    );
    const schedule = assertEventSchedule({
      recurrence: dto.recurrence,
      startDate: dto.startDate,
      endDate: dto.endDate,
    });
    const event = await this.prisma.event.create({
      include: { branch: { select: { name: true } } },
      data: {
        church_id: churchId,
        branch_id: branchId,
        title: dto.title,
        description: dto.description,
        type: (dto.type as never) || 'service',
        start_date: new Date(dto.startDate),
        end_date: dto.endDate ? new Date(dto.endDate) : null,
        recurrence: schedule.recurrence,
        location: dto.location,
        capacity: dto.capacity,
        is_free: dto.isFree ?? true,
        price: dto.price,
        registration_fields: (dto.registrationFields ?? []) as unknown as Prisma.InputJsonValue,
      },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'event',
      action: 'CREATE',
      entityId: event.id,
      newValues: { title: dto.title, type: dto.type },
    });

    this.logger.log(`Event created: ${event.id} (${dto.title})`);
    return this.mapEventToDto(event, 0);
  }

  /**
   * Lists events for a church with pagination and filters.
   *
   * @param dto - List query parameters (pagination, filters, sorting)
   * @param churchId - Church ID for tenant scoping
   * @returns Paginated list of events with registration counts
   */
  async listEvents(
    dto: ListEventsDto,
    churchId: string,
    viewer?: ViewerScope | null,
  ): Promise<{ data: EventResponseDto[]; total: number }> {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.EventWhereInput = {
      church_id: churchId,
      archived_at: dto.archived === true ? { not: null } : null,
    };

    // Scoped to the viewer's own branch unless they hold the admin-hq override.
    const scope = this.branchScope.resolve(viewer);
    if (!scope.churchOnly && scope.branchId) {
      where.branch_id = scope.branchId;
    } else if (dto.branchId && scope.churchOnly) {
      where.branch_id = dto.branchId;
    }

    if (dto.type) {
      where.type = dto.type as never;
    }

    if (dto.search) {
      where.OR = [
        { title: { contains: dto.search, mode: 'insensitive' } },
        { description: { contains: dto.search, mode: 'insensitive' } },
      ];
    }

    const dateFilter = dto.dateFilter || dto.status;
    const now = new Date();
    if (dateFilter === 'upcoming') {
      // Live recurring events stay upcoming after their first start date —
      // the same evergreen rule the service schedules follow.
      where.AND = [
        {
          OR: [
            { start_date: { gte: now } },
            {
              recurrence: { in: ['weekly', 'multi_day'] },
              start_date: { lt: now },
              OR: [{ end_date: null }, { end_date: { gte: now } }],
            },
          ],
        },
      ];
    } else if (dateFilter === 'past') {
      where.start_date = { lt: now };
      where.AND = [
        {
          NOT: {
            AND: [
              { recurrence: { in: ['weekly', 'multi_day'] } },
              { OR: [{ end_date: null }, { end_date: { gte: now } }] },
            ],
          },
        },
      ];
    }

    if (dto.startDate) {
      where.start_date = {
        ...(where.start_date as Prisma.DateTimeFilter),
        gte: new Date(dto.startDate),
      };
    }
    if (dto.endDate) {
      where.start_date = {
        ...(where.start_date as Prisma.DateTimeFilter),
        lte: new Date(dto.endDate),
      };
    }

    const normalizedSortBy =
      dto.sortBy === 'startDate'
        ? 'start_date'
        : dto.sortBy === 'createdAt'
          ? 'created_at'
          : (dto.sortBy ?? 'start_date');

    const orderBy: Prisma.EventOrderByWithRelationInput =
      normalizedSortBy === 'title'
        ? { title: dto.sortOrder ?? 'asc' }
        : normalizedSortBy === 'created_at'
          ? { created_at: dto.sortOrder ?? 'desc' }
          : { start_date: dto.sortOrder ?? 'asc' };

    const [events, total] = await Promise.all([
      this.prisma.event.findMany({
        where,
        orderBy,
        skip,
        take: limit,
        include: {
          branch: { select: { name: true } },
          _count: { select: { registrations: true } },
        },
      }),
      this.prisma.event.count({ where }),
    ]);

    return {
      data: events.map((e) => this.mapEventToDto(e, e._count.registrations)),
      total,
    };
  }

  /**
   * Gets a single event by ID with tier details.
   *
   * @param eventId - Event UUID
   * @param churchId - Church ID for tenant scoping
   * @returns Event response with registration count and ticket tiers
   * @throws NotFoundException if event doesn't exist
   */
  async getEvent(eventId: string, churchId: string): Promise<EventResponseDto> {
    const event = await this.prisma.event.findFirst({
      where: {
        id: eventId,
        church_id: churchId,
        ...this.requestContext.branchOrSharedWhere(churchId),
      },
      include: {
        branch: { select: { name: true } },
        _count: { select: { registrations: true } },
        ticket_tiers: { orderBy: { display_order: 'asc' } },
      },
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    return this.mapEventToDto(event, event._count.registrations);
  }

  /**
   * Updates an event.
   *
   * @param eventId - Event UUID to update
   * @param dto - Update data (all fields optional)
   * @param churchId - Church ID for tenant scoping
   * @param userId - ID of the user performing the update (for audit)
   * @returns Updated event response
   * @throws NotFoundException if event doesn't exist
   */
  async updateEvent(
    eventId: string,
    dto: UpdateEventDto,
    churchId: string,
    userId: string,
  ): Promise<EventResponseDto> {
    const existing = await this.prisma.event.findFirst({
      include: { branch: { select: { name: true } } },
      where: { id: eventId, church_id: churchId, ...this.requestContext.branchWhere(churchId) },
    });

    if (!existing) {
      throw new NotFoundException('Event not found');
    }

    if (existing.archived_at) {
      throw new NotFoundException('Event not found');
    }

    const data: Prisma.EventUpdateInput = {};

    // Re-validate the MERGED schedule (DTO over existing row) whenever any
    // recurrence/date field is touched — same rule as updateService.
    if (dto.recurrence !== undefined || dto.startDate !== undefined || dto.endDate !== undefined) {
      const merged = assertEventSchedule({
        recurrence: dto.recurrence ?? existing.recurrence,
        startDate: dto.startDate ?? existing.start_date,
        endDate: dto.endDate === undefined ? existing.end_date : dto.endDate,
      });
      if (dto.recurrence === undefined && existing.recurrence !== merged.recurrence) {
        data.recurrence = merged.recurrence;
      }
    }

    if (dto.title !== undefined) data.title = dto.title;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.type !== undefined) data.type = dto.type as never;
    if (dto.startDate !== undefined) data.start_date = new Date(dto.startDate);
    if (dto.endDate !== undefined) data.end_date = dto.endDate ? new Date(dto.endDate) : null;
    if (dto.recurrence !== undefined) data.recurrence = dto.recurrence;
    if (dto.location !== undefined) data.location = dto.location;
    if (dto.capacity !== undefined) data.capacity = dto.capacity;
    if (dto.isFree !== undefined) data.is_free = dto.isFree;
    if (dto.price !== undefined) data.price = dto.price;
    if (dto.branchId !== undefined) {
      const branchId = await contentBranch(
        this.prisma,
        this.branchScope.resolve(),
        churchId,
        dto.branchId,
      );
      data.branch = { connect: { id: branchId! } };
    }
    if (dto.registrationFields !== undefined)
      data.registration_fields = dto.registrationFields as unknown as Prisma.InputJsonValue;

    const updated = await this.prisma.event.update({
      where: { id: eventId },
      data,
      include: { branch: { select: { name: true } }, _count: { select: { registrations: true } } },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'event',
      action: 'UPDATE',
      oldValues: { branchId: existing.branch_id },
      entityId: eventId,
      newValues: dto as unknown as Record<string, unknown>,
    });

    this.logger.log(`Event updated: ${eventId}`);
    return this.mapEventToDto(updated, updated._count.registrations);
  }

  /**
   * Archives an event by setting archived_at. Archived events drop out of
   * active lists (which filter archived_at: null) but stay reachable by ID on
   * the detail view and can be restored or permanently deleted.
   *
   * @param eventId - Event UUID to archive
   * @param churchId - Church ID for tenant scoping
   * @param userId - ID of the user performing the action (for audit)
   * @returns Updated event response
   * @throws NotFoundException if the event is missing or not in this church
   * @throws ConflictException if the event is already archived
   */
  async archiveEvent(eventId: string, churchId: string, userId: string): Promise<EventResponseDto> {
    const existing = await this.prisma.event.findFirst({
      include: { branch: { select: { name: true } } },
      where: { id: eventId, church_id: churchId, ...this.requestContext.branchWhere(churchId) },
    });

    if (!existing) {
      throw new NotFoundException('Event not found');
    }

    if (existing.archived_at) {
      throw new ConflictException('Event is already archived');
    }

    const updated = await this.prisma.event.update({
      where: { id: eventId },
      data: { archived_at: new Date() },
      include: { branch: { select: { name: true } }, _count: { select: { registrations: true } } },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'event',
      action: 'ARCHIVE',
      entityId: eventId,
      oldValues: { archived_at: existing.archived_at },
      newValues: { archived_at: updated.archived_at },
    });

    this.logger.log(`Event archived: ${eventId}`);
    return this.mapEventToDto(updated, updated._count.registrations);
  }

  /**
   * Restores an archived event by clearing archived_at.
   *
   * @param eventId - Event UUID to restore
   * @param churchId - Church ID for tenant scoping
   * @param userId - ID of the user performing the action (for audit)
   * @returns Updated event response
   * @throws NotFoundException if the event is missing or not in this church
   * @throws ConflictException if the event is not currently archived
   */
  async restoreEvent(eventId: string, churchId: string, userId: string): Promise<EventResponseDto> {
    const existing = await this.prisma.event.findFirst({
      include: { branch: { select: { name: true } } },
      where: { id: eventId, church_id: churchId, ...this.requestContext.branchWhere(churchId) },
    });

    if (!existing) {
      throw new NotFoundException('Event not found');
    }

    if (!existing.archived_at) {
      throw new ConflictException('Event is not archived');
    }

    const updated = await this.prisma.event.update({
      where: { id: eventId },
      data: { archived_at: null },
      include: { branch: { select: { name: true } }, _count: { select: { registrations: true } } },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'event',
      action: 'RESTORE',
      entityId: eventId,
      oldValues: { archived_at: existing.archived_at },
      newValues: { archived_at: null },
    });

    this.logger.log(`Event restored: ${eventId}`);
    return this.mapEventToDto(updated, updated._count.registrations);
  }

  /**
   * Deletes an event. Blocked if registrations exist.
   *
   * @param eventId - Event UUID to delete
   * @param churchId - Church ID for tenant scoping
   * @param userId - ID of the user performing the deletion (for audit)
   * @throws NotFoundException if event doesn't exist
   * @throws BadRequestException if event has registrations
   */
  async deleteEvent(eventId: string, churchId: string, userId: string): Promise<void> {
    const existing = await this.prisma.event.findFirst({
      where: { id: eventId, church_id: churchId, ...this.requestContext.branchWhere(churchId) },
      include: { branch: { select: { name: true } }, _count: { select: { registrations: true } } },
    });

    if (!existing) {
      throw new NotFoundException('Event not found');
    }

    if (existing._count.registrations > 0) {
      throw new BadRequestException(
        `Cannot delete event with ${existing._count.registrations} registration(s). Cancel registrations first.`,
      );
    }

    if (
      (await this.prisma.attendanceSession.count({
        where: { church_id: churchId, event_id: eventId },
      })) > 0
    ) {
      throw new ConflictException(
        'Cannot delete a event with attendance history. Archive it instead.',
      );
    }
    await this.prisma.event.delete({ where: { id: eventId } });

    await this.audit.log({
      userId,
      churchId,
      entity: 'event',
      action: 'DELETE',
      entityId: eventId,
      oldValues: { title: existing.title },
    });

    this.logger.log(`Event deleted: ${eventId}`);
  }

  // ─── MANAGEMENT ──────────────────────────────────────────────

  /**
   * Lists all tickets across events for management purposes.
   *
   * @param churchId - Church ID for tenant scoping
   * @param filters - Optional filters (eventId, status, search, page, limit)
   * @returns Paginated list of tickets with event and member details
   */
  async listAllTickets(
    churchId: string,
    filters: {
      eventId?: string;
      status?: string;
      search?: string;
      page: number;
      limit: number;
      memberId?: string;
      branchId?: string;
    },
    viewer?: ViewerScope | null,
  ) {
    const { eventId, status, search, page, limit, memberId } = filters;
    const skip = (page - 1) * limit;

    const where: Prisma.TicketWhereInput = {
      event: {
        church_id: churchId,
      },
    };
    const scope = this.branchScope.resolve(viewer);
    const branchId = scope.churchOnly ? filters.branchId : scope.branchId;
    if (!scope.churchOnly || branchId) {
      where.event = {
        church_id: churchId,
        OR: [{ branch_id: branchId ?? null }, { branch_id: null }],
      };
      const members = await this.prisma.member.findMany({
        where: { church_id: churchId, branch_id: branchId ?? null },
        select: { id: true },
      });
      const visitors = await this.prisma.visitor.findMany({
        where: { church_id: churchId, branch_id: branchId ?? null },
        select: { id: true },
      });
      where.AND = [
        {
          OR: [
            { member_id: { in: members.map((member) => member.id) } },
            { visitor_id: { in: visitors.map((visitor) => visitor.id) } },
          ],
        },
      ];
    }

    if (memberId !== undefined) {
      where.member_id = memberId || '';
    }

    if (eventId) {
      where.event_id = eventId;
    }

    if (status) {
      where.status = status as Prisma.EnumTicketStatusFilter['equals'];
    }

    if (search) {
      where.OR = [
        { code: { contains: search, mode: 'insensitive' } },
        { tier_name: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [tickets, total] = await Promise.all([
      this.prisma.ticket.findMany({
        where,
        include: {
          event: {
            select: { id: true, title: true, start_date: true, location: true, type: true },
          },
        },
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.ticket.count({ where }),
    ]);

    // Resolve member names separately (Ticket has no Prisma member relation)
    const memberIds = [...new Set(tickets.map((t) => t.member_id).filter(Boolean))] as string[];
    const members =
      memberIds.length > 0
        ? await this.prisma.member.findMany({
            where: { id: { in: memberIds }, church_id: churchId },
            select: { id: true, first_name: true, last_name: true },
          })
        : [];
    const memberMap = new Map(members.map((m) => [m.id, `${m.first_name} ${m.last_name}`]));

    // Resolve visitor names
    const visitorIds = [...new Set(tickets.map((t) => t.visitor_id).filter(Boolean))] as string[];
    const visitors =
      visitorIds.length > 0
        ? await this.prisma.visitor.findMany({
            where: { id: { in: visitorIds }, church_id: churchId },
            select: { id: true, first_name: true, last_name: true },
          })
        : [];
    const visitorMap = new Map(
      visitors.map((v) => [v.id, `${v.first_name} ${v.last_name ?? ''}`.trim()]),
    );

    return {
      data: tickets.map((t) => ({
        ticketId: t.id,
        code: t.code,
        eventId: t.event_id,
        eventName: t.event.title,
        eventDate: t.event.start_date,
        eventLocation: t.event.location,
        eventType: t.event.type,
        memberId: t.member_id,
        memberName: t.member_id ? (memberMap.get(t.member_id) ?? null) : null,
        visitorId: t.visitor_id,
        visitorName: t.visitor_id ? (visitorMap.get(t.visitor_id) ?? null) : null,
        registrationId: t.registration_id,
        tierName: t.tier_name,
        pricePaid: t.price_paid,
        status: t.status,
        isUsed: t.is_used,
        usedAt: t.used_at,
        createdAt: t.created_at,
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  // ─── TICKET TIERS ──────────────────────────────────────────────

  /**
   * Creates a ticket tier for an event.
   *
   * @param eventId - Event UUID
   * @param name - Tier name (e.g. "VIP", "General")
   * @param price - Price in Naira
   * @param churchId - Church ID for tenant scoping
   * @param userId - ID of the user creating the tier (for audit)
   * @param capacity - Optional per-tier capacity limit
   * @param description - Optional tier description
   * @returns Created tier ID
   * @throws NotFoundException if event doesn't exist
   */
  async createTicketTier(
    eventId: string,
    name: string,
    price: number,
    churchId: string,
    userId: string,
    capacity?: number,
    description?: string,
  ): Promise<{ tierId: string }> {
    const event = await this.prisma.event.findFirst({
      where: {
        id: eventId,
        church_id: churchId,
        ...this.requestContext.branchOrSharedWhere(churchId),
      },
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    const maxOrder = await this.prisma.eventTicketTier.aggregate({
      where: { event_id: eventId },
      _max: { display_order: true },
    });

    const tier = await this.prisma.eventTicketTier.create({
      data: {
        event_id: eventId,
        name,
        price,
        capacity,
        description,
        display_order: (maxOrder._max.display_order ?? -1) + 1,
      },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'event_ticket_tier',
      action: 'CREATE',
      entityId: tier.id,
      newValues: { event_id: eventId, name, price },
    });

    this.logger.log(`Ticket tier created: ${tier.id} (${name}) for event ${eventId}`);
    return { tierId: tier.id };
  }

  /**
   * Lists all ticket tiers for an event.
   *
   * @param eventId - Event UUID
   * @param churchId - Church ID for tenant scoping
   * @returns Array of ticket tiers ordered by display_order
   * @throws NotFoundException if event doesn't exist
   */
  async listTicketTiers(eventId: string, churchId: string) {
    const event = await this.prisma.event.findFirst({
      where: {
        id: eventId,
        church_id: churchId,
        ...this.requestContext.branchOrSharedWhere(churchId),
      },
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    return this.prisma.eventTicketTier.findMany({
      where: { event_id: eventId, archived_at: null },
      orderBy: { display_order: 'asc' },
    });
  }

  /**
   * Updates a ticket tier.
   *
   * @param eventId - Event UUID
   * @param tierId - Tier UUID
   * @param dto - Update data
   * @param churchId - Church ID for tenant scoping
   * @param userId - ID of the user performing the update (for audit)
   * @throws NotFoundException if event or tier doesn't exist
   */
  async updateTicketTier(
    eventId: string,
    tierId: string,
    dto: {
      name?: string;
      price?: number;
      capacity?: number | null;
      description?: string | null;
      displayOrder?: number;
    },
    churchId: string,
    userId: string,
  ) {
    const event = await this.prisma.event.findFirst({
      where: {
        id: eventId,
        church_id: churchId,
        ...this.requestContext.branchOrSharedWhere(churchId),
      },
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    const tier = await this.prisma.eventTicketTier.findFirst({
      where: { id: tierId, event_id: eventId },
    });

    if (!tier) {
      throw new NotFoundException('Ticket tier not found');
    }

    if (tier.archived_at) {
      throw new NotFoundException('Ticket tier not found');
    }

    const data: Record<string, unknown> = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.price !== undefined) data.price = dto.price;
    if (dto.capacity !== undefined) data.capacity = dto.capacity;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.displayOrder !== undefined) data.display_order = dto.displayOrder;

    const updated = await this.prisma.eventTicketTier.update({
      where: { id: tierId },
      data,
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'event_ticket_tier',
      action: 'UPDATE',
      entityId: tierId,
      oldValues: { name: tier.name, price: tier.price },
      newValues: data,
    });

    return updated;
  }

  /**
   * Archives a ticket tier by setting archived_at. Archived tiers drop out of
   * active tier lists (which filter archived_at: null) but can be restored or
   * permanently deleted.
   *
   * @param eventId - Event UUID for scope
   * @param tierId - Tier UUID
   * @param churchId - Church ID for tenant scoping
   * @param userId - ID of the user performing the action (for audit)
   * @returns Updated tier
   * @throws NotFoundException if the event or tier is missing or not in this church
   * @throws ConflictException if the tier is already archived
   */
  async archiveTicketTier(eventId: string, tierId: string, churchId: string, userId: string) {
    const event = await this.prisma.event.findFirst({
      where: {
        id: eventId,
        church_id: churchId,
        ...this.requestContext.branchOrSharedWhere(churchId),
      },
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    const tier = await this.prisma.eventTicketTier.findFirst({
      where: { id: tierId, event_id: eventId },
    });

    if (!tier) {
      throw new NotFoundException('Ticket tier not found');
    }

    if (tier.archived_at) {
      throw new ConflictException('Ticket tier is already archived');
    }

    const updated = await this.prisma.eventTicketTier.update({
      where: { id: tierId },
      data: { archived_at: new Date() },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'event_ticket_tier',
      action: 'ARCHIVE',
      entityId: tierId,
      oldValues: { archived_at: tier.archived_at },
      newValues: { archived_at: updated.archived_at },
    });

    this.logger.log(`Ticket tier archived: ${tierId} for event ${eventId}`);
    return updated;
  }

  /**
   * Restores an archived ticket tier by clearing archived_at.
   *
   * @param eventId - Event UUID for scope
   * @param tierId - Tier UUID
   * @param churchId - Church ID for tenant scoping
   * @param userId - ID of the user performing the action (for audit)
   * @returns Updated tier
   * @throws NotFoundException if the event or tier is missing or not in this church
   * @throws ConflictException if the tier is not currently archived
   */
  async restoreTicketTier(eventId: string, tierId: string, churchId: string, userId: string) {
    const event = await this.prisma.event.findFirst({
      where: {
        id: eventId,
        church_id: churchId,
        ...this.requestContext.branchOrSharedWhere(churchId),
      },
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    const tier = await this.prisma.eventTicketTier.findFirst({
      where: { id: tierId, event_id: eventId },
    });

    if (!tier) {
      throw new NotFoundException('Ticket tier not found');
    }

    if (!tier.archived_at) {
      throw new ConflictException('Ticket tier is not archived');
    }

    const updated = await this.prisma.eventTicketTier.update({
      where: { id: tierId },
      data: { archived_at: null },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'event_ticket_tier',
      action: 'RESTORE',
      entityId: tierId,
      oldValues: { archived_at: tier.archived_at },
      newValues: { archived_at: null },
    });

    this.logger.log(`Ticket tier restored: ${tierId} for event ${eventId}`);
    return updated;
  }

  /**
   * Deletes a ticket tier. Blocked if registrations reference it.
   *
   * @param eventId - Event UUID
   * @param tierId - Tier UUID
   * @param churchId - Church ID for tenant scoping
   * @param userId - ID of the user performing the deletion (for audit)
   * @throws NotFoundException if event or tier doesn't exist
   * @throws BadRequestException if registrations reference this tier
   */
  async deleteTicketTier(eventId: string, tierId: string, churchId: string, userId: string) {
    const event = await this.prisma.event.findFirst({
      where: {
        id: eventId,
        church_id: churchId,
        ...this.requestContext.branchOrSharedWhere(churchId),
      },
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    const tier = await this.prisma.eventTicketTier.findFirst({
      where: { id: tierId, event_id: eventId },
    });

    if (!tier) {
      throw new NotFoundException('Ticket tier not found');
    }

    const registrationCount = await this.prisma.eventRegistration.count({
      where: { tier_id: tierId },
    });

    if (registrationCount > 0) {
      throw new BadRequestException(
        `Cannot delete tier "${tier.name}": ${registrationCount} registration(s) reference it.`,
      );
    }

    await this.prisma.eventTicketTier.delete({ where: { id: tierId } });

    await this.audit.log({
      userId,
      churchId,
      entity: 'event_ticket_tier',
      action: 'DELETE',
      entityId: tierId,
      oldValues: { name: tier.name, price: tier.price },
    });

    this.logger.log(`Ticket tier deleted: ${tierId} (${tier.name}) from event ${eventId}`);
  }

  // ─── REGISTRATION ──────────────────────────────────────────────

  /**
   * Registers a member for an event.
   *
   * Free events: immediate registration + ticket generation.
   * Paid events: creates a pending registration and returns payment
   * authorization details for frontend redirect.
   *
   * @param eventId - Event UUID
   * @param memberId - Member UUID
   * @param customData - Optional custom registration field values
   * @param churchId - Church ID for tenant scoping
   * @param userId - ID of the user performing registration (for audit)
   * @param tierId - Optional ticket tier ID for paid events
   * @param quantity - Number of tickets (default: 1)
   * @returns Registration response (free) or payment init response (paid)
   * @throws NotFoundException if event or member doesn't exist
   * @throws ConflictException if member is already registered
   * @throws BadRequestException if event is at capacity
   */
  async registerForEvent(
    eventId: string,
    memberId: string,
    customData: Record<string, unknown> | undefined,
    churchId: string,
    userId: string,
    tierId?: string,
    quantity: number = 1,
  ): Promise<RegistrationResponseDto> {
    const event = await this.prisma.event.findFirst({
      where: {
        id: eventId,
        church_id: churchId,
        ...this.requestContext.branchOrSharedWhere(churchId),
      },
      include: {
        _count: { select: { registrations: true } },
        ticket_tiers: true,
      },
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    if (!event.is_free) await assertPlanFeature(this.prisma, churchId, 'tickets');

    // Duplicate check
    const existingRegistration = await this.prisma.eventRegistration.findUnique({
      where: { event_id_member_id: { event_id: eventId, member_id: memberId } },
    });

    if (existingRegistration) {
      throw new ConflictException('Member is already registered for this event');
    }

    // Capacity check (event-level)
    if (event.capacity && event._count.registrations >= event.capacity) {
      throw new BadRequestException(`Event has reached its maximum capacity of ${event.capacity}`);
    }

    // Verify member exists in same church
    const member = await this.prisma.member.findFirst({
      where: { id: memberId, church_id: churchId },
    });

    if (!member) {
      throw new NotFoundException('Member not found');
    }

    // Resolve tier for paid events
    let tier: (typeof event.ticket_tiers)[number] | undefined;
    if (!event.is_free) {
      if (tierId) {
        tier = event.ticket_tiers.find((t) => t.id === tierId);
        if (!tier) {
          throw new NotFoundException('Ticket tier not found');
        }
      } else if (event.ticket_tiers.length > 0) {
        // Default to first tier (display_order 0)
        tier = event.ticket_tiers[0];
      }
    }

    // Free event: immediate registration + ticket
    if (event.is_free) {
      const registration = await this.prisma.eventRegistration.create({
        data: {
          church_id: churchId,
          event_id: eventId,
          member_id: memberId,
          custom_data: (customData ?? {}) as unknown as Prisma.InputJsonValue,
          payment_status: 'paid',
          quantity,
        },
      });

      const ticketCode = this.generateTicketCode();
      const ticket = await this.prisma.ticket.create({
        data: {
          event_id: eventId,
          code: ticketCode,
          member_id: memberId,
          registration_id: registration.id,
          status: 'paid',
          tier_name: tier?.name ?? 'General',
          price_paid: 0,
        },
      });

      await this.prisma.eventRegistration.update({
        where: { id: registration.id },
        data: { ticket_id: ticket.id },
      });

      await this.audit.log({
        userId,
        churchId,
        entity: 'event_registration',
        action: 'CREATE',
        entityId: registration.id,
        newValues: { event_id: eventId, member_id: memberId, type: 'free' },
      });

      this.logger.log(`Free registration: member ${memberId} → event ${eventId}`);

      const adminProfiles = await this.prisma.profile.findMany({
        where: { church_id: churchId, role: { hasSome: ['church_admin', 'branch_pastor'] } },
      });
      for (const admin of adminProfiles) {
        await this.notifications
          .createNotification(
            churchId,
            admin.id,
            'event',
            'Event Registration',
            `${member.first_name} ${member.last_name} registered for "${event.title}".`,
            { eventId, memberId, eventName: event.title },
          )
          .catch((err) => this.logger.warn(`Notification failed: ${(err as Error).message}`));
      }

      return this.mapRegistrationToDto({
        ...registration,
        member,
        ticket_code: ticketCode,
        tier_name: tier?.name,
      });
    }

    // Paid event: create pending registration + transaction
    const amount = (tier?.price ?? event.price ?? 0) * quantity;
    if (amount <= 0) {
      throw new BadRequestException('Event requires a valid ticket price');
    }

    // Tier capacity check
    if (tier?.capacity) {
      const tierRegistrations = await this.prisma.eventRegistration.count({
        where: { event_id: eventId, tier_id: tierId, payment_status: 'paid' },
      });
      if (tierRegistrations >= tier.capacity) {
        throw new BadRequestException(`Ticket tier "${tier.name}" has sold out`);
      }
    }

    const gatewayName = await this.paymentAccounts.defaultGateway(churchId);
    if (!gatewayName) throw new BadRequestException('Configure a church payment account first');
    const paymentAccount = await this.paymentAccounts.current(churchId, gatewayName);
    const reference = this.generatePaymentReference(event.title);
    const memberEmail = (member as Record<string, unknown>).email as string | undefined;

    const registration = await this.prisma.eventRegistration.create({
      data: {
        church_id: churchId,
        event_id: eventId,
        member_id: memberId,
        custom_data: (customData ?? {}) as unknown as Prisma.InputJsonValue,
        payment_status: 'pending',
        payment_reference: reference,
        tier_id: tierId,
        quantity,
      },
    });

    const transaction = await this.prisma.transaction.create({
      data: {
        church_id: churchId,
        member_id: memberId,
        amount,
        currency: 'NGN',
        type: 'digital',
        status: 'pending',
        payment_reference: reference,
        payment_gateway: gatewayName as 'paystack' | 'flutterwave',
        ...(paymentAccount ? { integration_account_id: paymentAccount.accountId } : {}),
        notes: `Event ticket: ${event.title}${tier ? ` (${tier.name})` : ''} x${quantity}`,
        metadata: {
          event_id: eventId,
          registration_id: registration.id,
          tier_id: tierId,
          type: 'event_ticket',
        } as Prisma.InputJsonValue,
      },
    });

    await this.prisma.eventRegistration.update({
      where: { id: registration.id },
      data: { transaction_id: transaction.id },
    });

    // Initialize payment with gateway
    const provider = paymentAccount.provider;
    if (!provider || !provider.isConfigured()) {
      throw new BadRequestException('Payment gateway not configured');
    }

    const paymentResult = await provider.initializeTransaction(
      memberEmail || 'attendee@churchos.app',
      amount,
      reference,
      {
        event_id: eventId,
        registration_id: registration.id,
        tier_id: tierId,
        type: 'event_ticket',
      },
    );

    await this.audit.log({
      userId,
      churchId,
      entity: 'event_registration',
      action: 'CREATE',
      entityId: registration.id,
      newValues: {
        event_id: eventId,
        member_id: memberId,
        type: 'paid',
        amount,
        reference,
      },
    });

    this.logger.log(`Paid registration initialized: ${reference} for event ${eventId}`);

    return {
      registrationId: registration.id,
      eventId,
      memberId,
      customData: customData as Record<string, unknown> | undefined,
      paymentStatus: 'pending',
      authorizationUrl: paymentResult.authorizationUrl,
      paymentReference: reference,
      tierName: tier?.name,
      quantity,
      checkedIn: false,
      createdAt: registration.created_at.toISOString(),
    };
  }

  /**
   * Confirms a ticket payment after webhook verification.
   *
   * Called by the webhook handler after verifying the payment signature.
   * Updates registration payment status, generates ticket code, and
   * links the ticket to the registration.
   *
   * @param reference - Payment reference from the gateway
   * @param churchId - Church ID for tenant scoping
   * @returns Updated registration with ticket code
   * @throws NotFoundException if registration with this reference doesn't exist
   * @throws BadRequestException if registration is not in pending state
   */
  async confirmTicketPayment(reference: string): Promise<RegistrationResponseDto> {
    const payment = await this.prisma.transaction.findFirst({
      where: { payment_reference: reference },
    });
    if (!payment) throw new NotFoundException('Payment not found');
    const provider = await this.paymentAccounts.historical(
      payment.church_id,
      payment.payment_gateway,
      payment.integration_account_id,
    );
    const verified = await provider.verifyTransaction(reference);
    if (
      verified.status !== 'success' ||
      verified.amount !== payment.amount ||
      verified.currency !== payment.currency ||
      (verified.reference && verified.reference !== reference)
    )
      throw new BadRequestException('Ticket payment does not match');

    const registration = await this.prisma.eventRegistration.findFirst({
      where: { payment_reference: reference },
      include: { event: true },
    });

    if (!registration) {
      throw new NotFoundException('Registration not found for this payment reference');
    }

    if (registration.payment_status === 'paid') {
      // Idempotent: already confirmed
      const existingTicket = registration.ticket_id
        ? await this.prisma.ticket.findUnique({ where: { id: registration.ticket_id } })
        : null;
      return this.mapRegistrationToDto({
        ...registration,
        ticket_code: existingTicket?.code,
        tier_name: existingTicket?.tier_name,
      });
    }

    if (registration.payment_status !== 'pending') {
      throw new BadRequestException(`Registration is in "${registration.payment_status}" state`);
    }

    const result = await this.prisma.$transaction(async (tx) => {
      // Atomically claim the pending registration. A concurrent webhook sees a
      // zero count and returns the ticket created by the request that won.
      const claim = await tx.eventRegistration.updateMany({
        where: { id: registration.id, payment_status: 'pending' },
        data: { payment_status: 'paid' },
      });

      if (claim.count === 0) {
        const settled = await tx.eventRegistration.findUnique({ where: { id: registration.id } });
        const existingTicket = await tx.ticket.findFirst({
          where: { registration_id: registration.id },
        });

        if (settled?.payment_status === 'paid' && existingTicket) {
          return { ticket: existingTicket, alreadySettled: true };
        }

        throw new BadRequestException('Registration payment could not be settled');
      }

      const tier = registration.tier_id
        ? await tx.eventTicketTier.findUnique({ where: { id: registration.tier_id } })
        : null;
      const transaction = registration.transaction_id
        ? await tx.transaction.findUnique({ where: { id: registration.transaction_id } })
        : null;
      const ticketCode = this.generateTicketCode();
      const ticket = await tx.ticket.create({
        data: {
          event_id: registration.event_id,
          code: ticketCode,
          member_id: registration.member_id,
          registration_id: registration.id,
          status: 'paid',
          tier_name: tier?.name ?? 'General',
          price_paid: transaction?.amount ?? 0,
          transaction_id: registration.transaction_id,
          payment_reference: reference,
        },
      });

      await tx.eventRegistration.update({
        where: { id: registration.id },
        data: { ticket_id: ticket.id },
      });

      if (registration.transaction_id) {
        await tx.transaction.update({
          where: { id: registration.transaction_id },
          data: { status: 'success' },
        });
      }

      return { ticket, alreadySettled: false, tierName: tier?.name };
    });

    if (result.alreadySettled) {
      return this.mapRegistrationToDto({
        ...registration,
        payment_status: 'paid',
        ticket_id: result.ticket.id,
        ticket_code: result.ticket.code,
        tier_name: result.ticket.tier_name,
      });
    }

    await this.audit.log({
      userId: registration.member_id,
      churchId: registration.event.church_id,
      entity: 'event_registration',
      action: 'UPDATE',
      entityId: registration.id,
      newValues: { payment_status: 'paid', ticket_code: result.ticket.code },
    });

    this.logger.log(`Ticket payment confirmed: ${reference} → ticket ${result.ticket.code}`);

    return this.mapRegistrationToDto({
      ...registration,
      payment_status: 'paid',
      ticket_id: result.ticket.id,
      ticket_code: result.ticket.code,
      tier_name: result.tierName,
    });
  }

  /**
   * Manually creates a ticket for an event (admin-initiated).
   *
   * Creates both the ticket and an associated registration with paid status.
   * Used for walk-in purchases, comp tickets, or manual ticket creation.
   * Supports both members and visitors.
   *
   * @param eventId - Event UUID
   * @param memberId - Member UUID (optional if visitorId provided)
   * @param visitorId - Visitor UUID (optional if memberId provided)
   * @param tierId - Optional ticket tier UUID
   * @param churchId - Church ID for tenant scoping
   * @param userId - User ID for audit logging
   * @returns Created ticket details
   */
  async createTicket(
    eventId: string,
    memberId: string | undefined,
    visitorId: string | undefined,
    tierId: string | undefined,
    churchId: string,
    userId: string,
    viewer?: {
      memberId?: string;
      branchId?: string;
      isAdminHq?: boolean;
      enforceSelf?: boolean;
    },
  ) {
    const event = await this.prisma.event.findFirst({
      where: {
        id: eventId,
        church_id: churchId,
        ...this.requestContext.branchOrSharedWhere(churchId),
      },
      include: { ticket_tiers: { orderBy: { display_order: 'asc' } } },
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    // Members may only claim a ticket for themselves. Staff can assign to anyone.
    if (viewer && !viewer.isAdminHq && event.branch_id && event.branch_id !== viewer.branchId) {
      throw new ForbiddenException('This event belongs to another branch');
    }
    if (viewer && !memberId && !visitorId)
      memberId = viewer.memberId ?? (await this.ensureMemberId(userId)) ?? undefined;
    if (viewer?.enforceSelf) {
      // Resolve the caller's own member profile, auto-creating and linking a
      // Member record on the fly when the profile has none (same convention as
      // sermons/pastoral ensureMemberId) so members can always self-claim.
      let selfMemberId = viewer.memberId;
      if (!selfMemberId) {
        selfMemberId = await this.ensureMemberId(userId);
      }
      if (!selfMemberId) {
        throw new ForbiddenException(
          'No member profile is linked. Contact your church admin to assign a ticket.',
        );
      }
      if (visitorId) {
        throw new ForbiddenException('Members cannot create a ticket for a visitor');
      }
      // Branch scope: members (and cell group leaders, who are treated
      // identically for tickets) may only claim tickets for events in their own
      // branch, unless the event is church-wide (no branch) or the viewer is HQ.
      if (!viewer.isAdminHq && event.branch_id && event.branch_id !== viewer.branchId) {
        throw new ForbiddenException('This event belongs to another branch');
      }
      // When the caller omits memberId, fill it with their resolved self id.
      memberId = memberId ?? selfMemberId;
      if (memberId !== selfMemberId) {
        throw new ForbiddenException('Members can only claim a ticket for themselves');
      }
    }

    // Validate at least one of memberId or visitorId
    if (!memberId && !visitorId) {
      throw new BadRequestException('At least one of memberId or visitorId must be provided');
    }

    // Validate member or visitor exists
    if (memberId) {
      const member = await this.prisma.member.findFirst({
        where: { id: memberId, church_id: churchId },
      });
      if (!member) {
        throw new NotFoundException('Member not found');
      }
      if (viewer && !viewer.isAdminHq && member.branch_id !== viewer.branchId)
        throw new ForbiddenException('Member belongs to another branch');

      const existingTicket = await this.prisma.ticket.findFirst({
        where: {
          event_id: eventId,
          member_id: memberId,
          status: { notIn: ['cancelled', 'refunded'] },
        },
      });
      if (existingTicket) {
        throw new BadRequestException('Member already has a ticket for this event');
      }
    }

    if (visitorId) {
      const visitor = await this.prisma.visitor.findFirst({
        where: { id: visitorId, church_id: churchId },
      });
      if (!visitor) {
        throw new NotFoundException('Visitor not found');
      }
      if (viewer && !viewer.isAdminHq && visitor.branch_id !== viewer.branchId)
        throw new ForbiddenException('Visitor belongs to another branch');

      const existingTicket = await this.prisma.ticket.findFirst({
        where: {
          event_id: eventId,
          visitor_id: visitorId,
          status: { notIn: ['cancelled', 'refunded'] },
        },
      });
      if (existingTicket) {
        throw new BadRequestException('Visitor already has a ticket for this event');
      }
    }

    let tier: (typeof event.ticket_tiers)[number] | undefined;
    if (tierId) {
      tier = event.ticket_tiers.find((t) => t.id === tierId);
      if (!tier) {
        throw new NotFoundException('Ticket tier not found');
      }
      if (tier.capacity != null) {
        const usedCount = await this.prisma.ticket.count({
          where: {
            event_id: eventId,
            tier_name: tier.name,
            status: { notIn: ['cancelled', 'refunded'] },
          },
        });
        if (usedCount >= tier.capacity) {
          throw new BadRequestException(`Tier "${tier.name}" is at full capacity`);
        }
      }
    } else if (event.ticket_tiers.length > 0) {
      tier = event.ticket_tiers[0];
    }

    const ticketCode = this.generateTicketCode();
    const tierName = tier?.name ?? 'General';
    const pricePaid = tier?.price ?? 0;

    const result = await this.prisma.$transaction(async (tx) => {
      // Create registration only for members (visitors don't need a registration record)
      let registration = null;
      if (memberId) {
        registration = await tx.eventRegistration.create({
          data: {
            church_id: churchId,
            event_id: eventId,
            member_id: memberId,
            custom_data: {} as unknown as Prisma.InputJsonValue,
            payment_status: 'paid',
            quantity: 1,
          },
        });
      }

      const ticket = await tx.ticket.create({
        data: {
          event_id: eventId,
          code: ticketCode,
          member_id: memberId,
          visitor_id: visitorId,
          registration_id: registration?.id,
          status: 'paid',
          tier_name: tierName,
          price_paid: pricePaid,
        },
      });

      if (registration) {
        await tx.eventRegistration.update({
          where: { id: registration.id },
          data: { ticket_id: ticket.id },
        });
      }

      return { registration, ticket };
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'event_registration',
      action: 'CREATE',
      entityId: result.ticket.id,
      newValues: {
        event_id: eventId,
        member_id: memberId,
        visitor_id: visitorId,
        type: 'manual_ticket',
        tier_name: tierName,
      },
    });

    const assigneeType = memberId ? 'member' : 'visitor';
    const assigneeId = memberId || visitorId;
    this.logger.log(
      `Manual ticket created: ${ticketCode} → ${assigneeType} ${assigneeId} for event ${eventId}`,
    );

    return {
      ticketId: result.ticket.id,
      code: ticketCode,
      eventId,
      memberId: memberId ?? null,
      visitorId: visitorId ?? null,
      tierName,
      pricePaid,
      status: 'paid' as const,
    };
  }

  /**
   * Returns the member ID linked to a user's profile, creating a Member record
   * on the fly and linking it to the profile when none exists.
   *
   * Follows the same convention as SermonsService/PastoralService so that
   * self-service member actions (e.g. claiming a ticket) always have a member
   * identity to work with.
   *
   * @param userId - Supabase Auth user ID (from JWT sub claim)
   * @returns The member ID linked to the user's profile
   * @throws NotFoundException if the user has no profile
   */
  private async ensureMemberId(userId: string): Promise<string> {
    const profile = await this.prisma.profile.findUnique({
      where: { user_id: userId },
      select: {
        id: true,
        member_id: true,
        first_name: true,
        last_name: true,
        church_id: true,
        branch_id: true,
      },
    });

    if (!profile) {
      throw new NotFoundException('User does not have a profile');
    }

    if (profile.member_id) {
      return profile.member_id;
    }

    const member = await this.prisma.member.create({
      data: {
        church_id: profile.church_id,
        branch_id: profile.branch_id,
        first_name: profile.first_name,
        last_name: profile.last_name,
        status: 'active',
      },
    });

    await this.prisma.profile.update({
      where: { id: profile.id },
      data: { member_id: member.id },
    });

    return member.id;
  }

  /**
   * Validates a ticket code for event check-in.
   *
   * @param code - Ticket code to validate
   * @param eventId - Event UUID
   * @param churchId - Church ID for tenant scoping
   * @returns Validation result with attendee details
   * @throws NotFoundException if ticket or event doesn't exist
   * @throws BadRequestException if ticket is already used or cancelled
   */
  async validateTicket(
    code: string,
    eventId: string,
    churchId: string,
  ): Promise<{
    valid: boolean;
    memberName?: string;
    eventName?: string;
    tierName?: string;
    checkedInAt?: string;
  }> {
    const event = await this.prisma.event.findFirst({
      where: {
        id: eventId,
        church_id: churchId,
        ...this.requestContext.branchOrSharedWhere(churchId),
      },
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    const ticket = await this.prisma.ticket.findFirst({
      where: { code, event_id: eventId },
      include: {
        event: { select: { title: true } },
      },
    });

    if (!ticket) {
      return { valid: false };
    }

    if (ticket.status === 'cancelled' || ticket.status === 'refunded') {
      return { valid: false };
    }

    if (ticket.is_used) {
      return {
        valid: false,
        memberName: ticket.member_id ?? undefined,
        eventName: ticket.event.title,
        tierName: ticket.tier_name ?? undefined,
        checkedInAt: ticket.used_at?.toISOString(),
      };
    }

    const now = new Date();
    let accepted: boolean;
    try {
      accepted = await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.ticket.updateMany({
          where: { id: ticket.id, event_id: eventId, is_used: false, status: 'paid' },
          data: { is_used: true, used_at: now },
        });
        if (claimed.count !== 1) return false;
        if (ticket.member_id || ticket.visitor_id) {
          const visitor = ticket.visitor_id
            ? await tx.visitor.findFirst({
                where: { id: ticket.visitor_id, church_id: churchId },
                select: { first_name: true, last_name: true },
              })
            : null;
          await tx.attendance.create({
            data: {
              church_id: churchId,
              event_id: eventId,
              member_id: ticket.member_id,
              visitor_id: ticket.visitor_id,
              visitor_name: visitor
                ? [visitor.first_name, visitor.last_name].filter(Boolean).join(' ')
                : null,
              attendance_date: new Date(now.toISOString().slice(0, 10)),
              checkin_at: now,
              source: 'qr',
              category: 'adult',
            },
          });
        }
        if (ticket.registration_id) {
          const registration = await tx.eventRegistration.findUnique({
            where: { id: ticket.registration_id },
          });
          if (registration?.checked_in)
            throw new ConflictException('Member already checked in for this event');
          await tx.eventRegistration.update({
            where: { id: ticket.registration_id },
            data: { checked_in: true, checked_in_at: now },
          });
        }
        return true;
      });
    } catch (error) {
      if (isAttendanceDuplicate(error) || error instanceof ConflictException)
        return { valid: false };
      throw error;
    }
    if (!accepted) return { valid: false };

    let memberName: string | undefined;
    if (ticket.member_id) {
      const member = await this.prisma.member.findUnique({
        where: { id: ticket.member_id },
        select: { first_name: true, last_name: true },
      });
      if (member) {
        memberName = `${member.first_name} ${member.last_name}`;
      }
    }

    this.logger.log(`Ticket validated: ${code} for event ${eventId}`);

    return {
      valid: true,
      memberName,
      eventName: ticket.event.title,
      tierName: ticket.tier_name ?? undefined,
      checkedInAt: now.toISOString(),
    };
  }

  /**
   * Lists registrations for an event with payment details.
   *
   * @param eventId - Event UUID
   * @param churchId - Church ID for tenant scoping
   * @returns Array of registration responses
   * @throws NotFoundException if event doesn't exist
   */
  async listRegistrations(
    eventId: string,
    churchId: string,
    viewer?: ViewerScope | null,
    requestedBranchId?: string,
  ): Promise<RegistrationResponseDto[]> {
    const event = await this.prisma.event.findFirst({
      where: {
        id: eventId,
        church_id: churchId,
        ...this.requestContext.branchOrSharedWhere(churchId),
      },
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }
    const scope = this.branchScope.resolve(viewer);
    if (!scope.churchOnly && event.branch_id && event.branch_id !== scope.branchId)
      throw new ForbiddenException('This event belongs to another branch');
    const branchId = scope.churchOnly ? requestedBranchId : scope.branchId;
    const members =
      !scope.churchOnly || branchId
        ? await this.prisma.member.findMany({
            where: { church_id: churchId, branch_id: branchId ?? null },
            select: { id: true },
          })
        : null;

    const registrations = await this.prisma.eventRegistration.findMany({
      where: {
        event_id: eventId,
        church_id: churchId,
        ...(members ? { member_id: { in: members.map((member) => member.id) } } : {}),
      },
      include: { member: { select: { first_name: true, last_name: true } } },
      orderBy: { created_at: 'desc' },
    });

    return registrations.map((r) => this.mapRegistrationToDto(r));
  }

  /**
   * Cancels a registration. For paid events, marks ticket as cancelled.
   *
   * @param eventId - Event UUID
   * @param memberId - Member UUID
   * @param churchId - Church ID for tenant scoping
   * @param userId - ID of the user performing the cancellation (for audit)
   * @throws NotFoundException if event or registration doesn't exist
   */
  async cancelRegistration(
    eventId: string,
    memberId: string,
    churchId: string,
    userId: string,
  ): Promise<void> {
    const event = await this.prisma.event.findFirst({
      where: {
        id: eventId,
        church_id: churchId,
        ...this.requestContext.branchOrSharedWhere(churchId),
      },
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    const registration = await this.prisma.eventRegistration.findUnique({
      where: { event_id_member_id: { event_id: eventId, member_id: memberId } },
    });

    if (!registration) {
      throw new NotFoundException('Registration not found');
    }

    // Cancel ticket if linked
    if (registration.ticket_id) {
      await this.prisma.ticket.update({
        where: { id: registration.ticket_id },
        data: { status: 'cancelled' },
      });
    }

    await this.prisma.eventRegistration.delete({
      where: { event_id_member_id: { event_id: eventId, member_id: memberId } },
    });

    await this.audit.log({
      userId,
      churchId,
      entity: 'event_registration',
      action: 'DELETE',
      entityId: registration.id,
      oldValues: {
        event_id: eventId,
        member_id: memberId,
        payment_status: registration.payment_status,
      },
    });

    this.logger.log(`Registration cancelled: member ${memberId} ← event ${eventId}`);
  }

  // ─── EVENT CHECK-IN ────────────────────────────────────────────

  async checkInAttendee(
    eventId: string,
    memberId: string,
    churchId: string,
    userId: string,
    selectedDate?: string,
  ): Promise<AttendanceResponseDto> {
    const event = await this.prisma.event.findFirst({
      where: {
        id: eventId,
        church_id: churchId,
        ...this.requestContext.branchOrSharedWhere(churchId),
      },
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }
    const { checkedInAt, attendanceDate } = attendanceDay(selectedDate);
    assertEventOccursOn(event.title, event, attendanceDate.toISOString().slice(0, 10));
    const sessionId = await attendanceSessionId(
      this.prisma,
      'event',
      eventId,
      churchId,
      checkedInAt,
      event.branch_id,
      this.requestContext.getStore()?.viewer,
    );

    const member = await this.prisma.member.findFirst({
      where: { id: memberId, church_id: churchId },
    });

    if (!member) {
      throw new NotFoundException('Member not found');
    }

    const existing = await this.prisma.attendance.findUnique({
      where: {
        event_id_member_id: { event_id: eventId, member_id: memberId },
      },
    });

    if (existing) {
      throw new ConflictException('Member already checked in for this event');
    }

    const registration = await this.prisma.eventRegistration.findUnique({
      where: { event_id_member_id: { event_id: eventId, member_id: memberId } },
    });
    if (registration?.checked_in)
      throw new ConflictException('Member already checked in for this event');

    const attendance = await this.prisma.attendance
      .create({
        data: {
          checkin_at: checkedInAt,
          attendance_date: attendanceDate,
          ...(sessionId ? { session_id: sessionId } : {}),
          church_id: churchId,
          event_id: eventId,
          member_id: memberId,
          category: 'adult',
          source: 'manual',
        },
        include: {
          service: { select: { name: true } },
          event: { select: { title: true } },
          member: { select: { first_name: true, last_name: true } },
        },
      })
      .catch(attendanceConflict);

    if (registration && !registration.checked_in) {
      await this.prisma.eventRegistration.update({
        where: { id: registration.id },
        data: { checked_in: true, checked_in_at: new Date() },
      });
    }

    await this.audit.log({
      userId,
      churchId,
      entity: 'attendance',
      action: 'CREATE',
      entityId: attendance.id,
      newValues: { event_id: eventId, member_id: memberId },
    });

    this.logger.log(`Event check-in: member ${memberId} → event ${eventId}`);

    return this.mapAttendanceToDto(attendance);
  }

  async bulkCheckInAttendees(
    eventId: string,
    memberIds: string[],
    churchId: string,
    userId: string,
    selectedDate?: string,
  ): Promise<{ checkedIn: number; skipped: number }> {
    const event = await this.prisma.event.findFirst({
      where: {
        id: eventId,
        church_id: churchId,
        ...this.requestContext.branchOrSharedWhere(churchId),
      },
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }
    const { checkedInAt, attendanceDate } = attendanceDay(selectedDate);
    assertEventOccursOn(event.title, event, attendanceDate.toISOString().slice(0, 10));
    const sessionId = await attendanceSessionId(
      this.prisma,
      'event',
      eventId,
      churchId,
      checkedInAt,
      event.branch_id,
      this.requestContext.getStore()?.viewer,
    );

    let checkedIn = 0;
    let skipped = 0;

    for (const memberId of memberIds) {
      const member = await this.prisma.member.findFirst({
        where: { id: memberId, church_id: churchId },
        select: { id: true },
      });

      if (!member) {
        skipped++;
        continue;
      }

      const existing = await this.prisma.attendance.findUnique({
        where: {
          event_id_member_id: { event_id: eventId, member_id: memberId },
        },
      });

      if (existing) {
        skipped++;
        continue;
      }

      const registration = await this.prisma.eventRegistration.findUnique({
        where: { event_id_member_id: { event_id: eventId, member_id: memberId } },
      });
      if (registration?.checked_in) {
        skipped++;
        continue;
      }

      try {
        await this.prisma.attendance.create({
          data: {
            checkin_at: checkedInAt,
            attendance_date: attendanceDate,
            ...(sessionId ? { session_id: sessionId } : {}),
            church_id: churchId,
            event_id: eventId,
            member_id: memberId,
            category: 'adult',
            source: 'manual',
          },
        });
      } catch (error) {
        if (isAttendanceDuplicate(error)) {
          skipped++;
          continue;
        }
        throw error;
      }

      if (registration && !registration.checked_in) {
        await this.prisma.eventRegistration.update({
          where: { id: registration.id },
          data: { checked_in: true, checked_in_at: checkedInAt },
        });
      }

      checkedIn++;
    }

    if (checkedIn > 0) {
      await this.audit.log({
        userId,
        churchId,
        entity: 'attendance',
        action: 'CREATE',
        entityId: 'bulk-event-checkin',
        newValues: {
          event_id: eventId,
          checkedIn,
          skipped,
          attendanceDate: attendanceDate.toISOString().slice(0, 10),
        },
      });
    }

    this.logger.log(`Bulk event check-in: ${checkedIn} checked in, ${skipped} skipped`);

    return { checkedIn, skipped };
  }

  async walkInCheckIn(
    eventId: string,
    dto: WalkInCheckInDto,
    churchId: string,
    userId: string,
  ): Promise<AttendanceResponseDto> {
    const event = await this.prisma.event.findFirst({
      where: {
        id: eventId,
        church_id: churchId,
        ...this.requestContext.branchOrSharedWhere(churchId),
      },
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }
    const { checkedInAt, attendanceDate } = attendanceDay(dto.attendanceDate);
    assertEventOccursOn(event.title, event, attendanceDate.toISOString().slice(0, 10));
    const sessionId = await attendanceSessionId(
      this.prisma,
      'event',
      eventId,
      churchId,
      checkedInAt,
      event.branch_id,
      this.requestContext.getStore()?.viewer,
    );

    const phoneDigits = dto.phone.replace(/\D/g, '');
    if (phoneDigits.length < 7 || phoneDigits.length > 15)
      throw new BadRequestException('Enter a valid phone number');
    const attendance = await this.prisma
      .$transaction(async (tx) => {
        // The lock covers member lookup/creation, so retries cannot create a
        // second member to bypass the event/person unique constraint.
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${churchId + ':walk-in:' + phoneDigits}, 0))::text`;
        const matches = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM members WHERE church_id=${churchId}
          AND regexp_replace(phone, '[^0-9]', '', 'g')=${phoneDigits}
        ORDER BY id`;
        if (
          matches.length &&
          (await tx.attendance.findFirst({
            where: { event_id: eventId, member_id: { in: matches.map((member) => member.id) } },
            select: { id: true },
          }))
        )
          throw new ConflictException('Member already checked in for this event');
        const member =
          matches[0] ??
          (await tx.member.create({
            data: {
              church_id: churchId,
              branch_id: event.branch_id,
              first_name: dto.firstName.trim(),
              last_name: dto.lastName.trim(),
              phone: dto.phone.trim(),
              email: dto.email || null,
              gender: dto.gender || null,
              status: 'active',
            },
          }));
        const registration = await tx.eventRegistration.findUnique({
          where: { event_id_member_id: { event_id: eventId, member_id: member.id } },
        });
        if (registration?.checked_in)
          throw new ConflictException('Member already checked in for this event');
        const record = await tx.attendance.create({
          data: {
            checkin_at: checkedInAt,
            attendance_date: attendanceDate,
            ...(sessionId ? { session_id: sessionId } : {}),
            church_id: churchId,
            event_id: eventId,
            member_id: member.id,
            category: 'adult',
            source: 'manual',
          },
          include: {
            service: { select: { name: true } },
            event: { select: { title: true } },
            member: { select: { first_name: true, last_name: true } },
          },
        });
        await tx.eventRegistration.upsert({
          where: { event_id_member_id: { event_id: eventId, member_id: member.id } },
          create: {
            church_id: churchId,
            event_id: eventId,
            member_id: member.id,
            payment_status: 'paid',
            checked_in: true,
            checked_in_at: checkedInAt,
          },
          update: { checked_in: true, checked_in_at: checkedInAt },
        });
        return record;
      })
      .catch(attendanceConflict);

    await this.audit.log({
      userId,
      churchId,
      entity: 'attendance',
      action: 'CREATE',
      entityId: attendance.id,
      newValues: {
        event_id: eventId,
        member_id: attendance.member_id,
        walkIn: true,
      },
    });

    this.logger.log(`Walk-in check-in: ${dto.firstName} ${dto.lastName} → event ${eventId}`);

    return this.mapAttendanceToDto(attendance);
  }

  async getEventAttendance(eventId: string, churchId: string): Promise<AttendanceResponseDto[]> {
    const event = await this.prisma.event.findFirst({
      where: {
        id: eventId,
        church_id: churchId,
        ...this.requestContext.branchOrSharedWhere(churchId),
      },
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    const records = await this.prisma.attendance.findMany({
      where: { event_id: eventId, church_id: churchId },
      orderBy: { checkin_at: 'desc' },
      include: {
        service: { select: { name: true } },
        event: { select: { title: true } },
        member: { select: { first_name: true, last_name: true } },
      },
    });

    return records.map((r) => this.mapAttendanceToDto(r));
  }

  async getEventAttendanceStats(
    eventId: string,
    churchId: string,
  ): Promise<{ registered: number; attended: number; noShows: number; walkIns: number }> {
    const event = await this.prisma.event.findFirst({
      where: {
        id: eventId,
        church_id: churchId,
        ...this.requestContext.branchOrSharedWhere(churchId),
      },
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    const registered = await this.prisma.eventRegistration.count({
      where: { event_id: eventId, church_id: churchId },
    });
    const checkedInRegistrations = await this.prisma.eventRegistration.count({
      where: { event_id: eventId, church_id: churchId, checked_in: true },
    });
    const attendanceCount = await this.prisma.attendance.count({
      where: { event_id: eventId, church_id: churchId },
    });

    const walkIns = attendanceCount - checkedInRegistrations;
    const noShows = registered - checkedInRegistrations;

    return {
      registered,
      attended: attendanceCount,
      noShows: noShows > 0 ? noShows : 0,
      walkIns: walkIns > 0 ? walkIns : 0,
    };
  }

  // ─── HELPERS ───────────────────────────────────────────────────

  /**
   * Generates a unique ticket code in format: EVT-YYYYMMDD-XXXX.
   *
   * @returns 16-character ticket code
   */
  private generateTicketCode(): string {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const random = crypto.randomBytes(3).toString('hex').toUpperCase();
    return `EVT-${date}-${random}`;
  }

  /**
   * Generates a payment reference for event tickets.
   *
   * @param eventTitle - Event title for the prefix
   * @returns Payment reference string
   */
  private generatePaymentReference(eventTitle: string): string {
    const prefix = eventTitle
      .replace(/[^a-zA-Z0-9]/g, '')
      .substring(0, 4)
      .toUpperCase();
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = crypto.randomBytes(2).toString('hex').toUpperCase();
    return `EVT/${prefix}/${timestamp}${random}`;
  }

  // ─── MAPPERS ───────────────────────────────────────────────────

  /**
   * Maps a Prisma Event to EventResponseDto.
   *
   * @param event - Raw event record from Prisma
   * @param registrationCount - Number of registrations for this event
   * @returns Formatted event response DTO
   */
  private mapEventToDto(
    event: Record<string, unknown> & {
      id: string;
      start_date: Date;
      created_at: Date;
      updated_at: Date;
    },
    registrationCount: number,
  ): EventResponseDto {
    return {
      eventId: event.id,
      churchId: event.church_id as string,
      branchId: (event.branch_id as string) || undefined,
      branchName: (event.branch as { name: string } | null)?.name,
      title: event.title as string,
      description: (event.description as string) || undefined,
      type: event.type as string,
      startDate: event.start_date.toISOString(),
      endDate: event.end_date ? (event.end_date as Date).toISOString() : undefined,
      recurrence: (event.recurrence as string) || 'one_time',
      location: (event.location as string) || undefined,
      capacity: (event.capacity as number) || undefined,
      isFree: event.is_free as boolean,
      price: (event.price as number) || undefined,
      registrationCount,
      archivedAt: (event.archived_at as Date | null)?.toISOString(),
      createdAt: event.created_at.toISOString(),
      updatedAt: event.updated_at.toISOString(),
    };
  }

  /**
   * Maps registration data to RegistrationResponseDto.
   *
   * Supports both Prisma EventRegistration records and extended objects
   * with ticket_code and tier_name from joined queries.
   *
   * @param data - Registration data from Prisma
   * @returns Formatted registration response DTO
   */
  private mapRegistrationToDto(
    data: Record<string, unknown> & { id: string; created_at: Date },
  ): RegistrationResponseDto {
    const member = data.member as { first_name: string; last_name: string } | null | undefined;
    return {
      registrationId: data.id,
      eventId: data.event_id as string,
      memberId: data.member_id as string,
      memberName: member ? `${member.first_name} ${member.last_name}`.trim() : undefined,
      customData: (data.custom_data as Record<string, unknown>) || undefined,
      paymentStatus: (data.payment_status as string) || 'pending',
      ticketCode: (data.ticket_code as string) || undefined,
      tierName: (data.tier_name as string) || undefined,
      quantity: (data.quantity as number) ?? 1,
      checkedIn: (data.checked_in as boolean) ?? false,
      authorizationUrl: (data.authorizationUrl as string) || undefined,
      paymentReference: (data.payment_reference as string) || undefined,
      createdAt: data.created_at.toISOString(),
    };
  }

  private mapAttendanceToDto(record: {
    id: string;
    church_id: string;
    service_id: string | null;
    event_id: string | null;
    member_id: string | null;
    visitor_id: string | null;
    visitor_name: string | null;
    category: string;
    checkin_at: Date;
    source: string;
    created_at: Date;
    service?: { name: string } | null;
    event?: { title: string } | null;
    member?: { first_name: string; last_name: string } | null;
  }): AttendanceResponseDto {
    return {
      attendanceId: record.id,
      churchId: record.church_id,
      serviceId: record.service_id || undefined,
      eventId: record.event_id || undefined,
      memberId: record.member_id || undefined,
      visitorId: record.visitor_id || undefined,
      visitorName: record.visitor_name || undefined,
      category: record.category || 'adult',
      checkInAt: record.checkin_at.toISOString(),
      source: record.source,
      createdAt: record.created_at.toISOString(),
      memberName: record.member
        ? `${record.member.first_name} ${record.member.last_name}`
        : undefined,
      serviceName: record.service?.name || undefined,
      eventName: record.event?.title || undefined,
    };
  }
}
