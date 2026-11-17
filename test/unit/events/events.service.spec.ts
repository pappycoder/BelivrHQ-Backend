import { plainToInstance } from 'class-transformer';
import { UpdateEventDto } from '../../../src/events/dto/update-event.dto';
import { RequestContextService } from '../../../src/common/services/request-context.service';
/**
 * @file events.service.spec.ts
 * @description Unit tests for EventsService.
 *
 * Tests event CRUD, member registration, capacity checks, duplicate
 * prevention, and deletion guards.
 *
 * @module test/unit/events/events.service.spec
 * @since 1.0.0
 */

import { EventsService } from '../../../src/events/events.service';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { AuditLoggingService } from '../../../src/common/services/audit-logging.service';
import { BranchScopeService } from '../../../src/common/services/branch-scope.service';
import {
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { createPrismaMock } from '../../helpers/prisma-mock.helper';

describe('EventsService', () => {
  let service: EventsService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let audit: { log: jest.Mock };
  let gatewayRegistry: Map<string, unknown>;

  const mockChurchId = '11111111-1111-1111-1111-111111111111';
  const mockUserId = '22222222-2222-2222-2222-222222222222';
  const mockEventId = '55555555-5555-5555-5555-555555555555';
  const mockMemberId = '44444444-4444-4444-4444-444444444444';

  const mockEvent = {
    id: mockEventId,
    church_id: mockChurchId,
    branch_id: null,
    title: 'Sunday Worship Service',
    description: 'Weekly worship',
    type: 'service',
    start_date: new Date('2026-08-01T09:00:00.000Z'),
    end_date: new Date('2026-08-01T12:00:00.000Z'),
    location: 'Main Auditorium',
    capacity: 200,
    is_free: true,
    price: null,
    registration_fields: [],
    created_at: new Date('2026-07-20T10:00:00.000Z'),
    updated_at: new Date('2026-07-20T10:00:00.000Z'),
  };

  const mockRegistration = {
    id: '66666666-6666-6666-6666-666666666666',
    event_id: mockEventId,
    member_id: mockMemberId,
    custom_data: {},
    payment_status: 'pending',
    payment_reference: null,
    transaction_id: null,
    ticket_id: null,
    tier_id: null,
    quantity: 1,
    checked_in: false,
    checked_in_at: null,
    created_at: new Date('2026-07-20T10:00:00.000Z'),
  };

  beforeEach(() => {
    prisma = createPrismaMock();
    prisma.platformSubscription.findUnique.mockResolvedValue({
      plan: 'network',
      paid_until: new Date(Date.now() + 86400000),
    });
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    gatewayRegistry = new Map();
    service = new EventsService(
      prisma as unknown as PrismaService,
      new RequestContextService(),
      audit as unknown as AuditLoggingService,
      gatewayRegistry as never,
      {
        createNotification: jest.fn().mockResolvedValue({}),
        broadcastToChurch: jest.fn().mockResolvedValue({ sent: 0 }),
      } as never,
      new BranchScopeService(new RequestContextService()),
      {
        defaultGateway: jest.fn().mockResolvedValue('paystack'),
        current: jest.fn(async (_churchId: string, name: string) => ({
          provider: gatewayRegistry.get(name),
          accountId: 'church-payment-account',
        })),
        historical: jest.fn(async (_churchId: string, name: string) => gatewayRegistry.get(name)),
      } as never,
    );
  });

  it('records an event roster and registration check-in on the chosen date', async () => {
    prisma.event.findFirst.mockResolvedValue(mockEvent);
    prisma.member.findFirst.mockResolvedValue({ id: mockMemberId });
    prisma.attendance.findUnique.mockResolvedValue(null);
    prisma.eventRegistration.findUnique.mockResolvedValue(mockRegistration);
    const result = await service.bulkCheckInAttendees(
      mockEventId,
      [mockMemberId],
      mockChurchId,
      mockUserId,
      '2026-08-01',
    );
    expect(result).toEqual({ checkedIn: 1, skipped: 0 });
    expect(prisma.attendance.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          attendance_date: new Date('2026-08-01T00:00:00Z'),
          checkin_at: new Date('2026-08-01T00:00:00Z'),
        }),
      }),
    );
    expect(prisma.eventRegistration.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { checked_in: true, checked_in_at: new Date('2026-08-01T00:00:00Z') },
      }),
    );
  });

  it('rejects an event check-in date the event does not occur on', async () => {
    prisma.event.findFirst.mockResolvedValue(mockEvent);
    await expect(
      service.bulkCheckInAttendees(
        mockEventId,
        [mockMemberId],
        mockChurchId,
        mockUserId,
        '2026-08-02',
      ),
    ).rejects.toThrow('does not occur on 2026-08-02');
    expect(prisma.attendance.create).not.toHaveBeenCalled();
  });

  it('checks in weekly events on later occurrences of the start weekday', async () => {
    prisma.event.findFirst.mockResolvedValue({
      ...mockEvent,
      recurrence: 'weekly',
      end_date: new Date('2026-10-31T12:00:00.000Z'),
    });
    prisma.member.findFirst.mockResolvedValue({ id: mockMemberId });
    prisma.attendance.findUnique.mockResolvedValue(null);
    prisma.eventRegistration.findUnique.mockResolvedValue(mockRegistration);

    await expect(
      service.bulkCheckInAttendees(
        mockEventId,
        [mockMemberId],
        mockChurchId,
        mockUserId,
        '2026-10-24',
      ),
    ).resolves.toEqual({ checkedIn: 1, skipped: 0 });
    expect(prisma.attendance.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          attendance_date: new Date('2026-10-24T00:00:00Z'),
        }),
      }),
    );
  });

  describe('event creation policy', () => {
    const input = { title: 'Community conference', startDate: '2026-08-01T09:00:00.000Z' };
    it('defaults new events to conference while retaining legacy records', async () => {
      prisma.event.create.mockResolvedValue({ ...mockEvent, type: 'conference' });
      await service.createEvent(input, mockChurchId, mockUserId);
      expect(prisma.event.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ type: 'conference' }),
        }),
      );
    });
    it('rejects service creation and reassignment without writing', async () => {
      await expect(
        service.createEvent({ ...input, type: 'service' }, mockChurchId, mockUserId),
      ).rejects.toThrow(BadRequestException);
      prisma.event.findFirst.mockResolvedValue(mockEvent);
      await expect(
        service.updateEvent(mockEventId, { type: 'service' }, mockChurchId, mockUserId),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.event.create).not.toHaveBeenCalled();
      expect(prisma.event.update).not.toHaveBeenCalled();
    });
    it.each([{ isFree: false }, { isFree: true, price: 100 }])(
      'blocks Community paid creation and conversion: %j',
      async (pricing) => {
        prisma.platformSubscription.findUnique.mockResolvedValue({
          plan: 'community',
          paid_until: new Date(Date.now() + 86400000),
        });
        await expect(
          service.createEvent({ ...input, ...pricing }, mockChurchId, mockUserId),
        ).rejects.toThrow(ForbiddenException);
        prisma.event.findFirst.mockResolvedValue(mockEvent);
        await expect(
          service.updateEvent(mockEventId, pricing, mockChurchId, mockUserId),
        ).rejects.toThrow(ForbiddenException);
        expect(prisma.event.create).not.toHaveBeenCalled();
        expect(prisma.event.update).not.toHaveBeenCalled();
      },
    );
    it('allows Community free creation', async () => {
      prisma.platformSubscription.findUnique.mockResolvedValue({
        plan: 'community',
        paid_until: new Date(Date.now() + 86400000),
      });
      prisma.event.create.mockResolvedValue({ ...mockEvent, type: 'conference' });
      await expect(
        service.createEvent({ ...input, isFree: true }, mockChurchId, mockUserId),
      ).resolves.toBeDefined();
    });
    it.each(['network', 'enterprise'])('allows paid events on %s', async (plan) => {
      prisma.platformSubscription.findUnique.mockResolvedValue({
        plan,
        paid_until: new Date(Date.now() + 86400000),
      });
      prisma.event.create.mockResolvedValue({
        ...mockEvent,
        type: 'conference',
        is_free: false,
        price: 100,
      });
      await expect(
        service.createEvent({ ...input, isFree: false, price: 100 }, mockChurchId, mockUserId),
      ).resolves.toBeDefined();
    });
  });

  describe('createEvent', () => {
    it('should create an event and return EventResponseDto', async () => {
      prisma.event.create.mockResolvedValue(mockEvent);

      const result = await service.createEvent(
        {
          title: 'Sunday Worship Service',
          description: 'Weekly worship',
          startDate: '2026-08-01T09:00:00.000Z',
          endDate: '2026-08-01T12:00:00.000Z',
          location: 'Main Auditorium',
          capacity: 200,
        },
        mockChurchId,
        mockUserId,
      );

      expect(result.eventId).toBe(mockEventId);
      expect(result.title).toBe('Sunday Worship Service');
      expect(result.registrationCount).toBe(0);
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'event', action: 'CREATE' }),
      );
    });

    it('persists a weekly recurrence instead of defaulting to one-time', async () => {
      prisma.event.create.mockResolvedValue({ ...mockEvent, recurrence: 'weekly' });

      const result = await service.createEvent(
        {
          title: 'Weekly prayer',
          startDate: '2026-08-01T09:00:00.000Z',
          recurrence: 'weekly',
        },
        mockChurchId,
        mockUserId,
      );

      expect(prisma.event.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ recurrence: 'weekly' }),
        }),
      );
      expect(result.recurrence).toBe('weekly');
    });

    it('rejects a one-time event whose end lands on a later day', async () => {
      await expect(
        service.createEvent(
          {
            title: 'Camp meeting',
            startDate: '2026-08-01T09:00:00.000Z',
            endDate: '2026-08-04T17:00:00.000Z',
          },
          mockChurchId,
          mockUserId,
        ),
      ).rejects.toThrow('single day');
      expect(prisma.event.create).not.toHaveBeenCalled();
    });

    it('requires both bounds for a date-range event and persists multi_day', async () => {
      await expect(
        service.createEvent(
          { title: 'Revival', startDate: '2026-08-01T09:00:00.000Z', recurrence: 'multi_day' },
          mockChurchId,
          mockUserId,
        ),
      ).rejects.toThrow('start and end date');

      prisma.event.create.mockResolvedValue({ ...mockEvent, recurrence: 'multi_day' });
      const result = await service.createEvent(
        {
          title: 'Revival',
          startDate: '2026-08-01T09:00:00.000Z',
          endDate: '2026-08-07T21:00:00.000Z',
          recurrence: 'multi_day',
        },
        mockChurchId,
        mockUserId,
      );
      expect(prisma.event.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ recurrence: 'multi_day' }),
        }),
      );
      expect(result.recurrence).toBe('multi_day');
    });
  });

  describe('listEvents', () => {
    it('should return paginated events', async () => {
      prisma.event.findMany.mockResolvedValue([{ ...mockEvent, _count: { registrations: 2 } }]);
      prisma.event.count.mockResolvedValue(1);

      const result = await service.listEvents({}, mockChurchId);

      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.data[0].registrationCount).toBe(2);
    });

    it('should filter by type', async () => {
      prisma.event.findMany.mockResolvedValue([]);
      prisma.event.count.mockResolvedValue(0);

      await service.listEvents({ type: 'conference' }, mockChurchId);

      expect(prisma.event.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ type: 'conference' }),
        }),
      );
    });

    it('should filter upcoming events, keeping still-live recurring events', async () => {
      prisma.event.findMany.mockResolvedValue([]);
      prisma.event.count.mockResolvedValue(0);

      await service.listEvents({ dateFilter: 'upcoming' }, mockChurchId);

      expect(prisma.event.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: [
              {
                OR: [
                  { start_date: { gte: expect.any(Date) } },
                  {
                    recurrence: { in: ['weekly', 'multi_day'] },
                    start_date: { lt: expect.any(Date) },
                    OR: [{ end_date: null }, { end_date: { gte: expect.any(Date) } }],
                  },
                ],
              },
            ],
          }),
        }),
      );
    });
  });

  describe('getEvent', () => {
    it('should return event by ID', async () => {
      prisma.event.findFirst.mockResolvedValue({
        ...mockEvent,
        _count: { registrations: 5 },
        ticket_tiers: [],
      });

      const result = await service.getEvent(mockEventId, mockChurchId);

      expect(result.eventId).toBe(mockEventId);
      expect(result.registrationCount).toBe(5);
    });

    it('should throw NotFoundException if event not found', async () => {
      prisma.event.findFirst.mockResolvedValue(null);

      await expect(service.getEvent('nonexistent', mockChurchId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('updateEvent', () => {
    it('should update event fields', async () => {
      prisma.event.findFirst.mockResolvedValue(mockEvent);
      prisma.event.update.mockResolvedValue({
        ...mockEvent,
        title: 'Updated Title',
        _count: { registrations: 0 },
      });

      const result = await service.updateEvent(
        mockEventId,
        { title: 'Updated Title' },
        mockChurchId,
        mockUserId,
      );

      expect(result.title).toBe('Updated Title');
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'event', action: 'UPDATE' }),
      );
    });

    it('should throw NotFoundException if event not found', async () => {
      prisma.event.findFirst.mockResolvedValue(null);

      await expect(
        service.updateEvent('nonexistent', { title: 'X' }, mockChurchId, mockUserId),
      ).rejects.toThrow(NotFoundException);
    });

    it('re-validates the merged schedule when only the end date changes', async () => {
      prisma.event.findFirst.mockResolvedValue({ ...mockEvent, recurrence: 'one_time' });

      await expect(
        service.updateEvent(
          mockEventId,
          { endDate: '2026-08-05T12:00:00.000Z' },
          mockChurchId,
          mockUserId,
        ),
      ).rejects.toThrow('single day');
      expect(prisma.event.update).not.toHaveBeenCalled();
    });

    it('re-validates the merged schedule when only the start date moves', async () => {
      prisma.event.findFirst.mockResolvedValue({ ...mockEvent, recurrence: 'weekly' });

      await expect(
        service.updateEvent(
          mockEventId,
          { startDate: '2026-09-01T09:00:00.000Z' },
          mockChurchId,
          mockUserId,
        ),
      ).rejects.toThrow('on or after');
      expect(prisma.event.update).not.toHaveBeenCalled();
    });

    it('rejects moving a one-time start date away from its stored same-day end', async () => {
      prisma.event.findFirst.mockResolvedValue({ ...mockEvent, recurrence: 'one_time' });

      await expect(
        service.updateEvent(
          mockEventId,
          { startDate: '2026-09-01T09:00:00.000Z' },
          mockChurchId,
          mockUserId,
        ),
      ).rejects.toThrow('single day');
      expect(prisma.event.update).not.toHaveBeenCalled();
    });

    it('switching to multi_day against the stored window is accepted and persisted', async () => {
      prisma.event.findFirst.mockResolvedValue({ ...mockEvent, recurrence: 'one_time' });
      prisma.event.update.mockResolvedValue({
        ...mockEvent,
        recurrence: 'multi_day',
        _count: { registrations: 0 },
      });

      const result = await service.updateEvent(
        mockEventId,
        { recurrence: 'multi_day' },
        mockChurchId,
        mockUserId,
      );

      expect(prisma.event.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ recurrence: 'multi_day' }),
        }),
      );
      expect(result.recurrence).toBe('multi_day');
    });
  });

  describe('deleteEvent', () => {
    it('protects event attendance sessions from permanent deletion', async () => {
      prisma.event.findFirst.mockResolvedValue({ ...mockEvent, _count: { registrations: 0 } });
      prisma.attendanceSession.count.mockResolvedValue(1);
      await expect(service.deleteEvent(mockEventId, mockChurchId, mockUserId)).rejects.toThrow(
        'Archive it instead',
      );
      expect(prisma.event.delete).not.toHaveBeenCalled();
    });

    it('should delete event with no registrations', async () => {
      prisma.event.findFirst.mockResolvedValue({ ...mockEvent, _count: { registrations: 0 } });
      prisma.event.delete.mockResolvedValue(mockEvent);

      await service.deleteEvent(mockEventId, mockChurchId, mockUserId);

      expect(prisma.event.delete).toHaveBeenCalledWith({ where: { id: mockEventId } });
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'event', action: 'DELETE' }),
      );
    });

    it('should block deletion if registrations exist', async () => {
      prisma.event.findFirst.mockResolvedValue({ ...mockEvent, _count: { registrations: 3 } });

      await expect(service.deleteEvent(mockEventId, mockChurchId, mockUserId)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw NotFoundException if event not found', async () => {
      prisma.event.findFirst.mockResolvedValue(null);

      await expect(service.deleteEvent('nonexistent', mockChurchId, mockUserId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('Ticket tier lifecycle and paid registration contracts', () => {
    const tier = {
      id: 'tier-a',
      name: 'General',
      price: 2500,
      capacity: 10,
      description: 'Entry',
      display_order: 0,
      archived_at: null,
    };
    beforeEach(() => {
      prisma.event.findFirst.mockResolvedValue({
        ...mockEvent,
        is_free: false,
        price: 1000,
        ticket_tiers: [tier],
        _count: { registrations: 0 },
      });
      prisma.eventTicketTier.findFirst.mockResolvedValue(tier);
      prisma.eventTicketTier.aggregate.mockResolvedValue({ _max: { display_order: null } });
      prisma.eventTicketTier.create.mockResolvedValue(tier);
      prisma.eventTicketTier.update.mockResolvedValue(tier);
      prisma.eventRegistration.findUnique.mockResolvedValue(null);
      prisma.eventRegistration.count.mockResolvedValue(0);
      prisma.eventRegistration.create.mockResolvedValue(mockRegistration);
      prisma.member.findFirst.mockResolvedValue({
        id: mockMemberId,
        email: 'attendee@example.org',
      });
      prisma.transaction.create.mockResolvedValue({ id: 'transaction-a' });
    });
    function operation(name: string): Promise<unknown> {
      if (name === 'create')
        return service.createTicketTier(mockEventId, 'General', 2500, mockChurchId, mockUserId);
      if (name === 'list') return service.listTicketTiers(mockEventId, mockChurchId);
      if (name === 'update')
        return service.updateTicketTier(mockEventId, tier.id, {}, mockChurchId, mockUserId);
      if (name === 'archive')
        return service.archiveTicketTier(mockEventId, tier.id, mockChurchId, mockUserId);
      if (name === 'restore')
        return service.restoreTicketTier(mockEventId, tier.id, mockChurchId, mockUserId);
      return service.deleteTicketTier(mockEventId, tier.id, mockChurchId, mockUserId);
    }
    it.each(['create', 'list', 'update', 'archive', 'restore', 'delete'])(
      'requires an accessible event before tier %s',
      async (name) => {
        prisma.event.findFirst.mockResolvedValue(null);
        await expect(operation(name)).rejects.toThrow('Event not found');
        expect(prisma.eventTicketTier.create).not.toHaveBeenCalled();
        expect(prisma.eventTicketTier.update).not.toHaveBeenCalled();
        expect(prisma.eventTicketTier.delete).not.toHaveBeenCalled();
      },
    );
    it.each(['update', 'archive', 'restore', 'delete'])(
      'requires the tier to belong to the selected event for %s',
      async (name) => {
        prisma.eventTicketTier.findFirst.mockResolvedValue(null);
        await expect(operation(name)).rejects.toThrow('Ticket tier not found');
        expect(prisma.eventTicketTier.findFirst).toHaveBeenCalledWith({
          where: { id: tier.id, event_id: mockEventId },
        });
      },
    );
    it.each([null, 4])('appends tier order after the current maximum %s', async (max) => {
      prisma.eventTicketTier.aggregate.mockResolvedValue({ _max: { display_order: max } });
      await expect(
        service.createTicketTier(
          mockEventId,
          'VIP',
          5000,
          mockChurchId,
          mockUserId,
          50,
          'Front row',
        ),
      ).resolves.toEqual({ tierId: tier.id });
      expect(prisma.eventTicketTier.create).toHaveBeenCalledWith({
        data: {
          event_id: mockEventId,
          name: 'VIP',
          price: 5000,
          capacity: 50,
          description: 'Front row',
          display_order: max === null ? 0 : 5,
        },
      });
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          churchId: mockChurchId,
          userId: mockUserId,
          action: 'CREATE',
          entityId: tier.id,
        }),
      );
    });
    it.each([{}, { name: 'VIP', price: 5000, capacity: null, description: null, displayOrder: 2 }])(
      'only updates supplied tier fields: %j',
      async (dto) => {
        await service.updateTicketTier(mockEventId, tier.id, dto, mockChurchId, mockUserId);
        expect(prisma.eventTicketTier.update).toHaveBeenCalledWith({
          where: { id: tier.id },
          data:
            'name' in dto
              ? { name: 'VIP', price: 5000, capacity: null, description: null, display_order: 2 }
              : {},
        });
      },
    );
    it('refuses updates to archived tiers', async () => {
      prisma.eventTicketTier.findFirst.mockResolvedValue({ ...tier, archived_at: new Date() });
      await expect(operation('update')).rejects.toThrow('Ticket tier not found');
      expect(prisma.eventTicketTier.update).not.toHaveBeenCalled();
    });
    it('does not permanently delete tiers referenced by registrations', async () => {
      prisma.eventRegistration.count.mockResolvedValue(2);
      await expect(operation('delete')).rejects.toThrow('2 registration(s) reference it');
      expect(prisma.eventTicketTier.delete).not.toHaveBeenCalled();
      prisma.eventRegistration.count.mockResolvedValue(0);
      await operation('delete');
      expect(prisma.eventTicketTier.delete).toHaveBeenCalledWith({ where: { id: tier.id } });
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'DELETE', entityId: tier.id }),
      );
    });
    it.each(['explicit', 'default', 'event-price'])(
      'initializes paid registration from the %s price and preserves merchant identity',
      async (selection) => {
        const provider = {
          isConfigured: jest.fn().mockReturnValue(true),
          initializeTransaction: jest
            .fn()
            .mockResolvedValue({ authorizationUrl: 'https://pay.example.org/checkout' }),
        };
        gatewayRegistry.set('paystack', provider);
        if (selection === 'event-price')
          prisma.event.findFirst.mockResolvedValue({
            ...mockEvent,
            is_free: false,
            price: 1000,
            ticket_tiers: [],
            _count: { registrations: 0 },
          });
        const selectedTier = selection === 'explicit' ? tier.id : undefined;
        const result = await service.registerForEvent(
          mockEventId,
          mockMemberId,
          { seating: 'front' },
          mockChurchId,
          mockUserId,
          selectedTier,
          2,
        );
        const amount = selection === 'event-price' ? 2000 : 5000;
        expect(provider.initializeTransaction).toHaveBeenCalledWith(
          'attendee@example.org',
          amount,
          expect.stringMatching(/^EVT\//),
          expect.objectContaining({
            event_id: mockEventId,
            registration_id: mockRegistration.id,
            type: 'event_ticket',
          }),
        );
        expect(prisma.transaction.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            amount,
            currency: 'NGN',
            status: 'pending',
            integration_account_id: 'church-payment-account',
          }),
        });
        expect(prisma.eventRegistration.update).toHaveBeenCalledWith({
          where: { id: mockRegistration.id },
          data: { transaction_id: 'transaction-a' },
        });
        expect(result).toMatchObject({
          paymentStatus: 'pending',
          authorizationUrl: 'https://pay.example.org/checkout',
          quantity: 2,
          checkedIn: false,
        });
        if (selection !== 'event-price') {
          expect(prisma.eventRegistration.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ tier_id: tier.id }),
          });
          expect(prisma.eventRegistration.count).toHaveBeenCalledWith({
            where: { event_id: mockEventId, tier_id: tier.id, payment_status: 'paid' },
          });
        }
      },
    );
    it('refuses an unknown tier before initializing a payment', async () => {
      await expect(
        service.registerForEvent(
          mockEventId,
          mockMemberId,
          undefined,
          mockChurchId,
          mockUserId,
          'foreign-tier',
        ),
      ).rejects.toThrow('Ticket tier not found');
      expect(prisma.transaction.create).not.toHaveBeenCalled();
    });
    it('refuses a sold-out tier before creating pending financial records', async () => {
      prisma.eventRegistration.count.mockResolvedValue(10);
      await expect(
        service.registerForEvent(
          mockEventId,
          mockMemberId,
          undefined,
          mockChurchId,
          mockUserId,
          tier.id,
        ),
      ).rejects.toThrow('has sold out');
      expect(prisma.transaction.create).not.toHaveBeenCalled();
    });
    it.each([null, 0, -1])('refuses an invalid paid-event price %s', async (price) => {
      prisma.event.findFirst.mockResolvedValue({
        ...mockEvent,
        is_free: false,
        price,
        ticket_tiers: [],
        _count: { registrations: 0 },
      });
      await expect(
        service.registerForEvent(mockEventId, mockMemberId, undefined, mockChurchId, mockUserId),
      ).rejects.toThrow('valid ticket price');
      expect(prisma.transaction.create).not.toHaveBeenCalled();
    });
    it.each([undefined, { isConfigured: () => false }])(
      'does not claim successful initialization when the payment provider is unavailable',
      async (provider) => {
        gatewayRegistry.set('paystack', provider);
        await expect(
          service.registerForEvent(
            mockEventId,
            mockMemberId,
            undefined,
            mockChurchId,
            mockUserId,
            tier.id,
          ),
        ).rejects.toThrow('Payment gateway not configured');
        expect(audit.log).not.toHaveBeenCalled();
      },
    );
  });

  describe('Ticket admission and duplicate check-in protection', () => {
    const ticket = {
      id: 'ticket-a',
      code: 'EVT-TEST',
      event_id: mockEventId,
      event: { title: 'Conference' },
      member_id: mockMemberId,
      visitor_id: null,
      registration_id: mockRegistration.id,
      status: 'paid',
      is_used: false,
      used_at: null,
      tier_name: 'General',
    };
    beforeEach(() => {
      prisma.event.findFirst.mockResolvedValue(mockEvent);
      prisma.ticket.findFirst.mockResolvedValue(ticket);
      prisma.ticket.updateMany.mockResolvedValue({ count: 1 });
      prisma.eventRegistration.findUnique.mockResolvedValue({ checked_in: false });
      prisma.member.findUnique.mockResolvedValue({ first_name: 'Ada', last_name: 'Obi' });
      (prisma.$transaction as unknown as jest.Mock).mockImplementation(
        (callback: (tx: typeof prisma) => unknown) => callback(prisma),
      );
    });
    it('requires an event in the current tenant before looking up tickets', async () => {
      prisma.event.findFirst.mockResolvedValue(null);
      await expect(service.validateTicket(ticket.code, mockEventId, mockChurchId)).rejects.toThrow(
        'Event not found',
      );
      expect(prisma.ticket.findFirst).not.toHaveBeenCalled();
    });
    it.each([
      null,
      { ...ticket, status: 'cancelled' },
      { ...ticket, status: 'pending' },
      { ...ticket, status: 'refunded' },
    ])('does not admit missing or unpaid tickets: %j', async (found) => {
      prisma.ticket.findFirst.mockResolvedValue(found);
      await expect(service.validateTicket(ticket.code, mockEventId, mockChurchId)).resolves.toEqual(
        { valid: false },
      );
      expect(prisma.ticket.updateMany).not.toHaveBeenCalled();
      expect(prisma.attendance.create).not.toHaveBeenCalled();
    });
    it.each([new Date('2026-01-01'), null])(
      'returns prior admission details without admitting a used ticket again',
      async (usedAt) => {
        prisma.ticket.findFirst.mockResolvedValue({ ...ticket, is_used: true, used_at: usedAt });
        await expect(
          service.validateTicket(ticket.code, mockEventId, mockChurchId),
        ).resolves.toMatchObject({
          valid: false,
          eventName: 'Conference',
          checkedInAt: usedAt?.toISOString(),
        });
        expect(prisma.attendance.create).not.toHaveBeenCalled();
      },
    );
    it('claims the ticket conditionally and records the attendee and registration together', async () => {
      const result = await service.validateTicket(ticket.code, mockEventId, mockChurchId);
      expect(result).toMatchObject({
        valid: true,
        memberName: 'Ada Obi',
        eventName: 'Conference',
        tierName: 'General',
      });
      expect(prisma.ticket.updateMany).toHaveBeenCalledWith({
        where: { id: ticket.id, event_id: mockEventId, is_used: false, status: 'paid' },
        data: { is_used: true, used_at: expect.any(Date) },
      });
      expect(prisma.attendance.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          church_id: mockChurchId,
          event_id: mockEventId,
          member_id: mockMemberId,
          source: 'qr',
        }),
      });
      expect(prisma.eventRegistration.update).toHaveBeenCalledWith({
        where: { id: mockRegistration.id },
        data: { checked_in: true, checked_in_at: expect.any(Date) },
      });
    });
    it('rejects a lost concurrent ticket claim before recording attendance', async () => {
      prisma.ticket.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.validateTicket(ticket.code, mockEventId, mockChurchId)).resolves.toEqual(
        { valid: false },
      );
      expect(prisma.attendance.create).not.toHaveBeenCalled();
    });
    it('does not admit a registration that is already checked in', async () => {
      prisma.eventRegistration.findUnique.mockResolvedValue({ checked_in: true });
      await expect(service.validateTicket(ticket.code, mockEventId, mockChurchId)).resolves.toEqual(
        { valid: false },
      );
      expect(prisma.eventRegistration.update).not.toHaveBeenCalled();
    });
    it('turns a duplicate attendance constraint into a refused admission', async () => {
      prisma.attendance.create.mockRejectedValue({ code: 'P2002' });
      await expect(service.validateTicket(ticket.code, mockEventId, mockChurchId)).resolves.toEqual(
        { valid: false },
      );
    });
    it('propagates other database failures rather than reporting a valid ticket', async () => {
      prisma.attendance.create.mockRejectedValue(new Error('database unavailable'));
      await expect(service.validateTicket(ticket.code, mockEventId, mockChurchId)).rejects.toThrow(
        'database unavailable',
      );
    });
    it.each([null, 'Obi'])(
      'records visitor names without pretending they are member identities: %s',
      async (lastName) => {
        prisma.ticket.findFirst.mockResolvedValue({
          ...ticket,
          member_id: null,
          visitor_id: 'visitor-a',
          registration_id: null,
          tier_name: null,
        });
        prisma.visitor.findFirst.mockResolvedValue({ first_name: 'Ada', last_name: lastName });
        await expect(
          service.validateTicket(ticket.code, mockEventId, mockChurchId),
        ).resolves.toMatchObject({ valid: true, memberName: undefined, tierName: undefined });
        expect(prisma.attendance.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            visitor_id: 'visitor-a',
            visitor_name: lastName ? 'Ada Obi' : 'Ada',
          }),
        });
        expect(prisma.eventRegistration.update).not.toHaveBeenCalled();
      },
    );
    it('can validate an unlinked general-admission ticket without fabricating attendance', async () => {
      prisma.ticket.findFirst.mockResolvedValue({
        ...ticket,
        member_id: null,
        visitor_id: null,
        registration_id: null,
      });
      await expect(
        service.validateTicket(ticket.code, mockEventId, mockChurchId),
      ).resolves.toMatchObject({ valid: true, memberName: undefined });
      expect(prisma.attendance.create).not.toHaveBeenCalled();
    });
    it('does not fabricate a name when the linked member is no longer available', async () => {
      prisma.member.findUnique.mockResolvedValue(null);
      await expect(
        service.validateTicket(ticket.code, mockEventId, mockChurchId),
      ).resolves.toMatchObject({ valid: true, memberName: undefined });
    });
  });

  describe('registerForEvent', () => {
    it('should register a member for a free event with ticket', async () => {
      prisma.event.findFirst.mockResolvedValue({
        ...mockEvent,
        _count: { registrations: 0 },
        ticket_tiers: [],
      });
      prisma.eventRegistration.findUnique.mockResolvedValue(null);
      prisma.member.findFirst.mockResolvedValue({
        id: mockMemberId,
        first_name: 'John',
        last_name: 'Doe',
      });
      prisma.eventRegistration.create.mockResolvedValue({
        ...mockRegistration,
        payment_status: 'paid',
      });
      prisma.ticket.create.mockResolvedValue({
        id: '77777777-7777-7777-7777-777777777777',
        code: 'EVT-20260721-A1B2C3',
        status: 'paid',
        tier_name: 'General',
        price_paid: 0,
      });
      prisma.eventRegistration.update.mockResolvedValue(mockRegistration);
      prisma.profile.findMany.mockResolvedValue([]);

      const result = await service.registerForEvent(
        mockEventId,
        mockMemberId,
        undefined,
        mockChurchId,
        mockUserId,
      );

      expect(result.registrationId).toBe(mockRegistration.id);
      expect(result.memberId).toBe(mockMemberId);
      expect(result.memberName).toBe('John Doe');
      expect(result.paymentStatus).toBe('paid');
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'event_registration', action: 'CREATE' }),
      );
    });

    it('should throw NotFoundException if event not found', async () => {
      prisma.event.findFirst.mockResolvedValue(null);

      await expect(
        service.registerForEvent(mockEventId, mockMemberId, undefined, mockChurchId, mockUserId),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ConflictException if already registered', async () => {
      prisma.event.findFirst.mockResolvedValue({
        ...mockEvent,
        _count: { registrations: 0 },
        ticket_tiers: [],
      });
      prisma.eventRegistration.findUnique.mockResolvedValue(mockRegistration);

      await expect(
        service.registerForEvent(mockEventId, mockMemberId, undefined, mockChurchId, mockUserId),
      ).rejects.toThrow(ConflictException);
    });

    it('should throw BadRequestException if event at capacity', async () => {
      prisma.event.findFirst.mockResolvedValue({
        ...mockEvent,
        _count: { registrations: 200 },
        ticket_tiers: [],
      });
      prisma.eventRegistration.findUnique.mockResolvedValue(null);

      await expect(
        service.registerForEvent(mockEventId, mockMemberId, undefined, mockChurchId, mockUserId),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw NotFoundException if member not found', async () => {
      prisma.event.findFirst.mockResolvedValue({
        ...mockEvent,
        _count: { registrations: 0 },
        ticket_tiers: [],
      });
      prisma.eventRegistration.findUnique.mockResolvedValue(null);
      prisma.member.findFirst.mockResolvedValue(null);

      await expect(
        service.registerForEvent(mockEventId, mockMemberId, undefined, mockChurchId, mockUserId),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('listRegistrations', () => {
    it('should return registrations for an event', async () => {
      prisma.event.findFirst.mockResolvedValue(mockEvent);
      prisma.eventRegistration.findMany.mockResolvedValue([
        { ...mockRegistration, member: { first_name: 'Grace', last_name: 'Member' } },
      ]);

      const result = await service.listRegistrations(mockEventId, mockChurchId);

      expect(result).toHaveLength(1);
      expect(result[0].registrationId).toBe(mockRegistration.id);
      expect(result[0].memberName).toBe('Grace Member');
      expect(prisma.eventRegistration.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ church_id: mockChurchId, event_id: mockEventId }),
          include: { member: { select: { first_name: true, last_name: true } } },
        }),
      );
    });

    it('should throw NotFoundException if event not found', async () => {
      prisma.event.findFirst.mockResolvedValue(null);

      await expect(service.listRegistrations('nonexistent', mockChurchId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('cancelRegistration', () => {
    it('should cancel a registration', async () => {
      prisma.event.findFirst.mockResolvedValue(mockEvent);
      prisma.eventRegistration.findUnique.mockResolvedValue({
        ...mockRegistration,
        ticket_id: null,
      });
      prisma.eventRegistration.delete.mockResolvedValue(mockRegistration);

      await service.cancelRegistration(mockEventId, mockMemberId, mockChurchId, mockUserId);

      expect(prisma.eventRegistration.delete).toHaveBeenCalled();
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'event_registration', action: 'DELETE' }),
      );
    });

    it('should throw NotFoundException if registration not found', async () => {
      prisma.event.findFirst.mockResolvedValue(mockEvent);
      prisma.eventRegistration.findUnique.mockResolvedValue(null);

      await expect(
        service.cancelRegistration(mockEventId, mockMemberId, mockChurchId, mockUserId),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('confirmTicketPayment', () => {
    const paymentReference = 'EVT-REF-001';
    const paidRegistration = {
      ...mockRegistration,
      payment_reference: paymentReference,
      transaction_id: 'transaction-1',
      event: mockEvent,
    };
    const paidTicket = {
      id: 'ticket-1',
      code: 'EVT-20260721-A1B2C3',
      registration_id: mockRegistration.id,
      tier_name: 'General',
      status: 'paid',
    };

    beforeEach(() => {
      prisma.transaction.findFirst.mockResolvedValue({
        church_id: mockChurchId,
        payment_gateway: 'paystack',
        amount: 5000,
        currency: 'NGN',
      });
      gatewayRegistry.set('paystack', {
        verifyTransaction: jest
          .fn()
          .mockResolvedValue({ status: 'success', amount: 5000, currency: 'NGN' }),
      });
      (prisma as unknown as { $transaction: jest.Mock }).$transaction.mockImplementation(
        async (callback: (client: typeof prisma) => unknown) => callback(prisma),
      );
    });

    it('should atomically settle a pending registration and issue one ticket', async () => {
      (prisma as unknown as { $queryRaw: jest.Mock }).$queryRaw = jest.fn().mockResolvedValue([]);
      (prisma.transaction as unknown as { findFirstOrThrow: jest.Mock }).findFirstOrThrow = jest
        .fn()
        .mockResolvedValue({ status: 'pending' });
      prisma.eventRegistration.findFirst.mockResolvedValue(paidRegistration);
      prisma.eventRegistration.updateMany.mockResolvedValue({ count: 1 });
      prisma.eventTicketTier.findUnique.mockResolvedValue(null);
      prisma.transaction.findUnique.mockResolvedValue({ amount: 5000 });
      prisma.ticket.create.mockResolvedValue(paidTicket);
      prisma.eventRegistration.update.mockResolvedValue({
        ...paidRegistration,
        ticket_id: paidTicket.id,
      });
      prisma.transaction.update.mockResolvedValue({});

      const result = await service.confirmTicketPayment(paymentReference);

      expect(prisma.eventRegistration.updateMany).toHaveBeenCalledWith({
        where: {
          id: mockRegistration.id,
          church_id: mockChurchId,
          payment_status: { in: ['pending', 'failed'] },
        },
        data: { payment_status: 'paid' },
      });
      expect(prisma.ticket.create).toHaveBeenCalledTimes(1);
      expect(result.paymentStatus).toBe('paid');
      expect(result.ticketCode).toBe(paidTicket.code);
    });

    it('should return the existing ticket when a concurrent delivery already settled it', async () => {
      (prisma as unknown as { $queryRaw: jest.Mock }).$queryRaw = jest.fn().mockResolvedValue([]);
      (prisma.transaction as unknown as { findFirstOrThrow: jest.Mock }).findFirstOrThrow = jest
        .fn()
        .mockResolvedValue({ status: 'pending' });
      prisma.eventRegistration.findFirst.mockResolvedValue(paidRegistration);
      prisma.eventRegistration.updateMany.mockResolvedValue({ count: 0 });
      prisma.eventRegistration.findUnique.mockResolvedValue({
        ...paidRegistration,
        payment_status: 'paid',
      });
      prisma.ticket.findFirst.mockResolvedValue(paidTicket);

      const result = await service.confirmTicketPayment(paymentReference);

      expect(prisma.ticket.create).not.toHaveBeenCalled();
      expect(prisma.transaction.update).not.toHaveBeenCalled();
      expect(result.paymentStatus).toBe('paid');
      expect(result.ticketCode).toBe(paidTicket.code);
    });
  });

  describe('listEvents archived filter', () => {
    it('should exclude archived events by default', async () => {
      prisma.event.findMany.mockResolvedValue([{ ...mockEvent, _count: { registrations: 0 } }]);
      prisma.event.count.mockResolvedValue(1);

      const result = await service.listEvents({}, mockChurchId);

      expect(prisma.event.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ archived_at: null }) }),
      );
      expect(result.data[0].archivedAt).toBeUndefined();
    });

    it('should list only archived events when archived=true', async () => {
      const archivedAt = new Date('2026-08-28T10:00:00.000Z');
      prisma.event.findMany.mockResolvedValue([
        { ...mockEvent, archived_at: archivedAt, _count: { registrations: 0 } },
      ]);
      prisma.event.count.mockResolvedValue(1);

      const result = await service.listEvents({ archived: true }, mockChurchId);

      expect(prisma.event.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ archived_at: { not: null } }),
        }),
      );
      expect(result.data[0].archivedAt).toBe(archivedAt.toISOString());
    });
  });

  describe('archiveEvent', () => {
    it('should set archived_at, emit archivedAt, and audit ARCHIVE', async () => {
      const archivedAt = new Date('2026-08-28T12:00:00.000Z');
      prisma.event.findFirst.mockResolvedValue(mockEvent);
      prisma.event.update.mockResolvedValue({
        ...mockEvent,
        archived_at: archivedAt,
        _count: { registrations: 0 },
      });

      const result = await service.archiveEvent(mockEventId, mockChurchId, mockUserId);

      expect(prisma.event.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: mockEventId },
          data: { archived_at: expect.any(Date) },
        }),
      );
      expect(result.archivedAt).toBe(archivedAt.toISOString());
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'ARCHIVE', entity: 'event' }),
      );
    });

    it('should throw ConflictException when already archived', async () => {
      prisma.event.findFirst.mockResolvedValue({ ...mockEvent, archived_at: new Date() });

      await expect(service.archiveEvent(mockEventId, mockChurchId, mockUserId)).rejects.toThrow(
        ConflictException,
      );
    });

    it('should throw NotFoundException when event is missing', async () => {
      prisma.event.findFirst.mockResolvedValue(null);

      await expect(service.archiveEvent('nonexistent', mockChurchId, mockUserId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('restoreEvent', () => {
    it('should clear archived_at and audit RESTORE', async () => {
      prisma.event.findFirst.mockResolvedValue({
        ...mockEvent,
        archived_at: new Date('2026-08-27T12:00:00.000Z'),
      });
      prisma.event.update.mockResolvedValue({
        ...mockEvent,
        archived_at: null,
        _count: { registrations: 0 },
      });

      const result = await service.restoreEvent(mockEventId, mockChurchId, mockUserId);

      expect(prisma.event.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: mockEventId }, data: { archived_at: null } }),
      );
      expect(result.archivedAt).toBeUndefined();
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'RESTORE', entity: 'event' }),
      );
    });

    it('should throw ConflictException when not archived', async () => {
      prisma.event.findFirst.mockResolvedValue(mockEvent);

      await expect(service.restoreEvent(mockEventId, mockChurchId, mockUserId)).rejects.toThrow(
        ConflictException,
      );
    });

    it('should throw NotFoundException when event is missing', async () => {
      prisma.event.findFirst.mockResolvedValue(null);

      await expect(service.restoreEvent('nonexistent', mockChurchId, mockUserId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('event purge & mutation guards', () => {
    it('should still hard-delete (purge) an archived event', async () => {
      prisma.event.findFirst.mockResolvedValue({
        ...mockEvent,
        archived_at: new Date(),
        _count: { registrations: 0 },
      });
      prisma.event.delete.mockResolvedValue(mockEvent);

      await service.deleteEvent(mockEventId, mockChurchId, mockUserId);

      expect(prisma.event.delete).toHaveBeenCalled();
    });

    it('should throw NotFoundException when updating an archived event', async () => {
      prisma.event.findFirst.mockResolvedValue({ ...mockEvent, archived_at: new Date() });

      await expect(
        service.updateEvent(mockEventId, { title: 'X' }, mockChurchId, mockUserId),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('ticket tier list & archive/restore', () => {
    const mockTier = {
      id: 'tier-1',
      event_id: mockEventId,
      name: 'General',
      price: 5000,
      capacity: 100,
      display_order: 1,
      description: null,
      created_at: new Date('2026-07-20T10:00:00.000Z'),
      updated_at: new Date('2026-07-20T10:00:00.000Z'),
    };

    it('should exclude archived tiers when listing tiers', async () => {
      prisma.event.findFirst.mockResolvedValue(mockEvent);
      prisma.eventTicketTier.findMany.mockResolvedValue([mockTier]);

      await service.listTicketTiers(mockEventId, mockChurchId);

      expect(prisma.eventTicketTier.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { event_id: mockEventId, archived_at: null } }),
      );
    });

    it('should archive a ticket tier and audit ARCHIVE', async () => {
      const archivedAt = new Date('2026-08-28T12:00:00.000Z');
      prisma.event.findFirst.mockResolvedValue(mockEvent);
      prisma.eventTicketTier.findFirst.mockResolvedValue(mockTier);
      prisma.eventTicketTier.update.mockResolvedValue({ ...mockTier, archived_at: archivedAt });

      const result = await service.archiveTicketTier(
        mockEventId,
        'tier-1',
        mockChurchId,
        mockUserId,
      );

      expect(prisma.eventTicketTier.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'tier-1' },
          data: { archived_at: expect.any(Date) },
        }),
      );
      expect(result.archived_at).toBe(archivedAt);
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'ARCHIVE', entity: 'event_ticket_tier' }),
      );
    });

    it('should throw ConflictException when archiving an already-archived tier', async () => {
      prisma.event.findFirst.mockResolvedValue(mockEvent);
      prisma.eventTicketTier.findFirst.mockResolvedValue({
        ...mockTier,
        archived_at: new Date(),
      });

      await expect(
        service.archiveTicketTier(mockEventId, 'tier-1', mockChurchId, mockUserId),
      ).rejects.toThrow(ConflictException);
    });

    it('should restore a ticket tier and audit RESTORE', async () => {
      prisma.event.findFirst.mockResolvedValue(mockEvent);
      prisma.eventTicketTier.findFirst.mockResolvedValue({
        ...mockTier,
        archived_at: new Date('2026-08-27T12:00:00.000Z'),
      });
      prisma.eventTicketTier.update.mockResolvedValue({ ...mockTier, archived_at: null });

      const result = await service.restoreTicketTier(
        mockEventId,
        'tier-1',
        mockChurchId,
        mockUserId,
      );

      expect(prisma.eventTicketTier.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'tier-1' }, data: { archived_at: null } }),
      );
      expect(result.archived_at).toBeNull();
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'RESTORE', entity: 'event_ticket_tier' }),
      );
    });

    it('should throw ConflictException when restoring a non-archived tier', async () => {
      prisma.event.findFirst.mockResolvedValue(mockEvent);
      prisma.eventTicketTier.findFirst.mockResolvedValue(mockTier);

      await expect(
        service.restoreTicketTier(mockEventId, 'tier-1', mockChurchId, mockUserId),
      ).rejects.toThrow(ConflictException);
    });

    it('should throw NotFoundException when updating an archived tier', async () => {
      prisma.event.findFirst.mockResolvedValue(mockEvent);
      prisma.eventTicketTier.findFirst.mockResolvedValue({
        ...mockTier,
        archived_at: new Date(),
      });

      await expect(
        service.updateTicketTier(mockEventId, 'tier-1', { name: 'X' }, mockChurchId, mockUserId),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('createTicket (member self-claim)', () => {
    const viewer = {
      memberId: undefined,
      branchId: 'branch-1',
      isAdminHq: false,
      enforceSelf: true,
    };

    it('should resolve the caller memberId via ensureMemberId when the profile has none', async () => {
      prisma.event.findFirst.mockResolvedValue({
        ...mockEvent,
        _count: { registrations: 0 },
        ticket_tiers: [],
      });
      prisma.eventRegistration.findUnique.mockResolvedValue(null);
      prisma.profile.findUnique.mockResolvedValue({
        id: 'profile-1',
        member_id: null,
        first_name: 'John',
        last_name: 'Doe',
        church_id: mockChurchId,
        branch_id: 'branch-1',
      });
      prisma.member.create.mockResolvedValue({ id: mockMemberId });
      prisma.profile.update.mockResolvedValue({});
      prisma.member.findFirst.mockResolvedValue({
        id: mockMemberId,
        first_name: 'John',
        last_name: 'Doe',
        church_id: mockChurchId,
        branch_id: 'branch-1',
      });
      (prisma.$transaction as unknown as jest.Mock).mockImplementation(
        (cb: (tx: unknown) => unknown) => cb(prisma),
      );
      prisma.ticket.create.mockResolvedValue({
        id: '77777777-7777-7777-7777-777777777777',
        code: 'EVT-20260801-ABCDE',
        status: 'paid',
        tier_name: 'General',
        price_paid: 0,
      });
      prisma.eventRegistration.create.mockResolvedValue(mockRegistration);
      prisma.eventRegistration.update.mockResolvedValue(mockRegistration);

      const result = await service.createTicket(
        mockEventId,
        undefined,
        undefined,
        undefined,
        mockChurchId,
        mockUserId,
        viewer,
      );

      expect(prisma.member.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            first_name: 'John',
            last_name: 'Doe',
            status: 'active',
          }),
        }),
      );
      expect(prisma.profile.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ member_id: mockMemberId }) }),
      );
      expect(result.memberId).toBe(mockMemberId);
    });

    it('should reject when the caller tries to claim for a different memberId', async () => {
      prisma.event.findFirst.mockResolvedValue({
        ...mockEvent,
        _count: { registrations: 0 },
        ticket_tiers: [],
      });
      prisma.profile.findUnique.mockResolvedValue({
        id: 'profile-1',
        member_id: mockMemberId,
        first_name: 'John',
        last_name: 'Doe',
        church_id: mockChurchId,
        branch_id: 'branch-1',
      });

      await expect(
        service.createTicket(
          mockEventId,
          '99999999-9999-9999-9999-999999999999',
          undefined,
          undefined,
          mockChurchId,
          mockUserId,
          viewer,
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.ticket.create).not.toHaveBeenCalled();
    });

    it('should reject visitors in the member self-claim path', async () => {
      prisma.event.findFirst.mockResolvedValue({
        ...mockEvent,
        _count: { registrations: 0 },
        ticket_tiers: [],
      });
      prisma.profile.findUnique.mockResolvedValue({
        id: 'profile-1',
        member_id: mockMemberId,
        first_name: 'John',
        last_name: 'Doe',
        church_id: mockChurchId,
        branch_id: 'branch-1',
      });

      await expect(
        service.createTicket(
          mockEventId,
          mockMemberId,
          'visitor-1',
          undefined,
          mockChurchId,
          mockUserId,
          viewer,
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.ticket.create).not.toHaveBeenCalled();
    });
  });

  describe('createTicket (cell leader self-claim — identical to member)', () => {
    const baseViewer = {
      memberId: mockMemberId,
      branchId: 'branch-1',
      isAdminHq: false,
      enforceSelf: true,
    };

    it("should allow claiming for an event in the leader's own branch", async () => {
      prisma.event.findFirst.mockResolvedValue({
        ...mockEvent,
        branch_id: 'branch-1',
        _count: { registrations: 0 },
        ticket_tiers: [],
      });
      prisma.member.findFirst.mockResolvedValue(null);

      await expect(
        service.createTicket(
          mockEventId,
          mockMemberId,
          undefined,
          undefined,
          mockChurchId,
          mockUserId,
          baseViewer,
        ),
      ).rejects.toThrow(NotFoundException);
      // Proceeded past the branch check (member lookup ran) — not Forbidden.
    });

    it('should allow claiming a church-wide (null-branch) event, like a member', async () => {
      prisma.event.findFirst.mockResolvedValue({
        ...mockEvent,
        branch_id: 'branch-1',
        _count: { registrations: 0 },
        ticket_tiers: [],
      });
      prisma.member.findFirst.mockResolvedValue(null);

      await expect(
        service.createTicket(
          mockEventId,
          mockMemberId,
          undefined,
          undefined,
          mockChurchId,
          mockUserId,
          baseViewer,
        ),
      ).rejects.toThrow(NotFoundException);
      // Proceeded past the branch check — not Forbidden.
    });

    it('should reject an event from another branch, like a member', async () => {
      prisma.event.findFirst.mockResolvedValue({
        ...mockEvent,
        branch_id: 'branch-2',
        _count: { registrations: 0 },
        ticket_tiers: [],
      });

      await expect(
        service.createTicket(
          mockEventId,
          mockMemberId,
          undefined,
          undefined,
          mockChurchId,
          mockUserId,
          baseViewer,
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.member.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('listAllTickets', () => {
    beforeEach(() => {
      prisma.ticket.findMany.mockResolvedValue([]);
      prisma.ticket.count.mockResolvedValue(0);
      prisma.member.findMany.mockResolvedValue([]);
      prisma.visitor.findMany.mockResolvedValue([]);
    });

    it('should scope church-wide by default (no member filter)', async () => {
      await service.listAllTickets(mockChurchId, { page: 1, limit: 50 });
      const arg = (prisma.ticket.findMany as jest.Mock).mock.calls[0][0];
      expect(arg.where.event).toEqual({ church_id: mockChurchId });
      expect(arg.where.member_id).toBeUndefined();
    });

    it('should self-scope by memberId for members and cell group leaders', async () => {
      await service.listAllTickets(mockChurchId, { page: 1, limit: 50, memberId: mockMemberId });
      const arg = (prisma.ticket.findMany as jest.Mock).mock.calls[0][0];
      expect(arg.where.member_id).toBe(mockMemberId);
    });

    it('should scope to no rows (never all tickets) when a non-staff caller has no linked member', async () => {
      await service.listAllTickets(mockChurchId, { page: 1, limit: 50, memberId: '' });
      const arg = (prisma.ticket.findMany as jest.Mock).mock.calls[0][0];
      expect(arg.where.member_id).toBe('');
      expect(arg.where.event).toEqual({ church_id: mockChurchId });
    });

    it('should honor eventId, status, and search filters alongside self-scoping', async () => {
      await service.listAllTickets(mockChurchId, {
        page: 1,
        limit: 50,
        memberId: mockMemberId,
        eventId: mockEventId,
        status: 'paid',
        search: 'EVT',
      });
      const arg = (prisma.ticket.findMany as jest.Mock).mock.calls[0][0];
      expect(arg.where.member_id).toBe(mockMemberId);
      expect(arg.where.event_id).toBe(mockEventId);
      expect(arg.where.status).toBe('paid');
      expect(arg.where.OR).toEqual([
        { code: { contains: 'EVT', mode: 'insensitive' } },
        { tier_name: { contains: 'EVT', mode: 'insensitive' } },
      ]);
    });
  });
  describe('event listing and manual ticket boundaries', () => {
    it.each(['title', 'createdAt', 'startDate'])(
      'honors date bounds and documented sort aliases (%s)',
      async (sortBy) => {
        prisma.event.findMany.mockResolvedValue([]);
        prisma.event.count.mockResolvedValue(0);
        await service.listEvents(
          {
            page: 2,
            limit: 5,
            branchId: 'requested',
            archived: true,
            search: 'Faith',
            dateFilter: 'past',
            startDate: '2026-01-01',
            endDate: '2026-02-01',
            sortBy,
          },
          mockChurchId,
          { church_id: mockChurchId, role: 'church_admin', is_admin_hq: true },
        );
        const args = prisma.event.findMany.mock.calls[0][0];
        expect(args).toMatchObject({
          skip: 5,
          take: 5,
          where: {
            church_id: mockChurchId,
            branch_id: 'requested',
            archived_at: { not: null },
            start_date: { gte: new Date('2026-01-01'), lte: new Date('2026-02-01') },
          },
          orderBy:
            sortBy === 'title'
              ? { title: 'asc' }
              : sortBy === 'createdAt'
                ? { created_at: 'desc' }
                : { start_date: 'asc' },
        });
        expect(args.where.OR).toHaveLength(2);
        expect(args.where.AND[0]).toHaveProperty('NOT');
      },
    );
    it('pins event listings to the staff branch and accepts explicit ascending creation order', async () => {
      prisma.event.findMany.mockResolvedValue([]);
      prisma.event.count.mockResolvedValue(0);
      await service.listEvents(
        { branchId: 'foreign', sortBy: 'created_at', sortOrder: 'asc' },
        mockChurchId,
        { church_id: mockChurchId, role: 'branch_pastor', branch_id: 'own' },
      );
      expect(prisma.event.findMany.mock.calls[0][0]).toMatchObject({
        where: { branch_id: 'own' },
        orderBy: { created_at: 'asc' },
      });
    });
    it.each([null, '2026-08-01T12:00:00.000Z'])(
      'supports setting and clearing event optional fields (%s)',
      async (endDate) => {
        prisma.event.findFirst.mockResolvedValue({ ...mockEvent, recurrence: 'one_time' });
        prisma.event.update.mockResolvedValue({ ...mockEvent, _count: { registrations: 0 } });
        await service.updateEvent(
          mockEventId,
          plainToInstance(UpdateEventDto, {
            title: 'Faith',
            description: null,
            type: 'conference',
            startDate: '2026-08-01T09:00:00.000Z',
            endDate,
            location: null,
            capacity: 0,
            isFree: true,
            price: 0,
            registrationFields: [],
          }),
          mockChurchId,
          mockUserId,
        );
        expect(prisma.event.update.mock.calls[0][0].data).toMatchObject({
          title: 'Faith',
          description: null,
          type: 'conference',
          start_date: mockEvent.start_date,
          end_date: endDate ? new Date(endDate) : null,
          location: null,
          capacity: 0,
          is_free: true,
          price: 0,
          registration_fields: [],
        });
        expect(audit.log).toHaveBeenCalledWith(
          expect.objectContaining({ action: 'UPDATE', entityId: mockEventId }),
        );
      },
    );
    describe('manual assignment', () => {
      const visitor = 'visitor';
      const tier = { id: 'tier', name: 'VIP', price: 5000, capacity: 2 };
      beforeEach(() => {
        prisma.event.findFirst.mockResolvedValue({ ...mockEvent, ticket_tiers: [tier] });
        prisma.member.findFirst.mockResolvedValue({ id: mockMemberId, branch_id: 'own' });
        prisma.visitor.findFirst.mockResolvedValue({ id: visitor, branch_id: 'own' });
        prisma.ticket.findFirst.mockResolvedValue(null);
        prisma.ticket.count.mockResolvedValue(0);
        (prisma.$transaction as unknown as jest.Mock).mockImplementation((fn) => fn(prisma));
        prisma.eventRegistration.create.mockResolvedValue({ id: 'registration' });
        prisma.ticket.create.mockImplementation(async ({ data }) => ({ id: 'ticket', ...data }));
      });
      const assign = (
        memberId?: string,
        visitorId?: string,
        tierId?: string,
        viewer?: {
          branchId?: string;
          memberId?: string;
          isAdminHq?: boolean;
          enforceSelf?: boolean;
        },
      ) =>
        service.createTicket(
          mockEventId,
          memberId,
          visitorId,
          tierId,
          mockChurchId,
          mockUserId,
          viewer,
        );
      it.each(['member', 'visitor'])(
        'creates an audited %s ticket using the explicit tier',
        async (kind) => {
          const result = await assign(
            kind === 'member' ? mockMemberId : undefined,
            kind === 'visitor' ? visitor : undefined,
            'tier',
            { branchId: 'own' },
          );
          expect(result).toMatchObject({
            ticketId: 'ticket',
            tierName: 'VIP',
            pricePaid: 5000,
            memberId: kind === 'member' ? mockMemberId : null,
            visitorId: kind === 'visitor' ? visitor : null,
          });
          expect(prisma.eventRegistration.create).toHaveBeenCalledTimes(kind === 'member' ? 1 : 0);
          expect(prisma.ticket.count.mock.calls[0][0].where.status).toEqual({
            notIn: ['cancelled', 'refunded'],
          });
        },
      );
      it('uses the first tier when no explicit tier is chosen', async () => {
        expect(await assign(mockMemberId)).toMatchObject({ tierName: 'VIP', pricePaid: 5000 });
      });
      it('uses General for an event with no tiers', async () => {
        prisma.event.findFirst.mockResolvedValue({ ...mockEvent, ticket_tiers: [] });
        expect(await assign(undefined, visitor)).toMatchObject({
          tierName: 'General',
          pricePaid: 0,
        });
      });
      it('fills an omitted member from the verified self-service identity', async () => {
        expect(
          await assign(undefined, undefined, undefined, {
            memberId: mockMemberId,
            branchId: 'own',
            enforceSelf: true,
          }),
        ).toMatchObject({ memberId: mockMemberId });
      });
      it.each([
        'missing-event',
        'no-assignee',
        'missing-member',
        'missing-visitor',
        'duplicate-member',
        'duplicate-visitor',
        'unknown-tier',
        'full-tier',
        'foreign-member',
        'foreign-visitor',
      ])('refuses unsafe assignment before transaction (%s)', async (scenario) => {
        let memberId: string | undefined = mockMemberId,
          visitorId: string | undefined,
          tierId: string | undefined;
        if (scenario === 'missing-event') prisma.event.findFirst.mockResolvedValue(null);
        if (scenario === 'no-assignee') memberId = undefined;
        if (scenario === 'missing-member') prisma.member.findFirst.mockResolvedValue(null);
        if (scenario.includes('visitor')) {
          memberId = undefined;
          visitorId = visitor;
        }
        if (scenario === 'missing-visitor') prisma.visitor.findFirst.mockResolvedValue(null);
        if (scenario.startsWith('duplicate'))
          prisma.ticket.findFirst.mockResolvedValue({ id: 'existing' });
        if (scenario === 'unknown-tier') tierId = 'unknown';
        if (scenario === 'full-tier') {
          tierId = 'tier';
          prisma.ticket.count.mockResolvedValue(2);
        }
        if (scenario === 'foreign-member')
          prisma.member.findFirst.mockResolvedValue({ branch_id: 'foreign' });
        if (scenario === 'foreign-visitor')
          prisma.visitor.findFirst.mockResolvedValue({ branch_id: 'foreign' });
        await expect(
          assign(
            memberId,
            visitorId,
            tierId,
            scenario.startsWith('foreign') ? { branchId: 'own' } : undefined,
          ),
        ).rejects.toThrow();
        expect(prisma.ticket.create).not.toHaveBeenCalled();
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });
    });
  });

  describe('payment confirmation refusal and idempotency', () => {
    const reference = 'confirmation';
    const payment = {
      id: 'transaction',
      church_id: mockChurchId,
      payment_gateway: 'paystack',
      amount: 5000,
      currency: 'NGN',
      status: 'pending',
      lifecycle: {},
    };
    let verify: jest.Mock;
    beforeEach(() => {
      verify = jest
        .fn()
        .mockResolvedValue({ reference, status: 'success', amount: 5000, currency: 'NGN' });
      gatewayRegistry.set('paystack', { verifyTransaction: verify });
      prisma.transaction.findFirst.mockResolvedValue(payment);
      prisma.eventRegistration.findFirst.mockResolvedValue({
        ...mockRegistration,
        event: mockEvent,
        payment_status: 'pending',
        ticket_id: null,
        tier_id: null,
        transaction_id: null,
      });
      (prisma.$transaction as unknown as jest.Mock).mockImplementation((fn) => fn(prisma));
      prisma.transaction.findFirstOrThrow.mockResolvedValue(payment);
      prisma.eventRegistration.updateMany.mockResolvedValue({ count: 1 });
      prisma.ticket.create.mockResolvedValue({ id: 'ticket', code: 'CODE' });
    });
    it.each(['missing', 'reversed', 'review', 'revoked'])(
      'refuses %s payment before contacting its provider',
      async (scenario) => {
        prisma.transaction.findFirst.mockResolvedValue(
          scenario === 'missing'
            ? null
            : {
                ...payment,
                status: scenario === 'reversed' ? 'reversed' : 'success',
                lifecycle: { access: scenario },
              },
        );
        await expect(service.confirmTicketPayment(reference)).rejects.toThrow();
        expect(verify).not.toHaveBeenCalled();
        expect(prisma.ticket.create).not.toHaveBeenCalled();
      },
    );
    it.each([{ status: 'pending' }, { amount: 1 }, { currency: 'USD' }, { reference: 'foreign' }])(
      'refuses provider payment detail mismatch %j',
      async (override) => {
        verify.mockResolvedValue({
          reference,
          status: 'success',
          amount: 5000,
          currency: 'NGN',
          ...override,
        });
        await expect(service.confirmTicketPayment(reference)).rejects.toThrow('does not match');
        expect(prisma.$transaction).not.toHaveBeenCalled();
      },
    );
    it.each([null, 'cancelled', 'refunded'])(
      'refuses missing or non-settleable registrations (%s)',
      async (state) => {
        prisma.eventRegistration.findFirst.mockResolvedValue(
          state ? { ...mockRegistration, event: mockEvent, payment_status: state } : null,
        );
        await expect(service.confirmTicketPayment(reference)).rejects.toThrow();
        expect(prisma.ticket.create).not.toHaveBeenCalled();
      },
    );
    it.each([null, 'existing-ticket'])(
      'returns an already-paid registration without issuing another ticket (%s)',
      async (ticketId) => {
        prisma.eventRegistration.findFirst.mockResolvedValue({
          ...mockRegistration,
          event: mockEvent,
          payment_status: 'paid',
          ticket_id: ticketId,
        });
        prisma.ticket.findUnique.mockResolvedValue({ code: 'EXISTING', tier_name: 'VIP' });
        const result = await service.confirmTicketPayment(reference);
        expect(result.ticketCode).toBe(ticketId ? 'EXISTING' : undefined);
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(prisma.ticket.create).not.toHaveBeenCalled();
      },
    );
    it.each(['review', 'revoked'])(
      'rechecks the locked payment hold before issuing a ticket (%s)',
      async (access) => {
        prisma.transaction.findFirstOrThrow.mockResolvedValue({
          ...payment,
          lifecycle: { access },
        });
        await expect(service.confirmTicketPayment(reference)).rejects.toThrow('held or refunded');
        expect(prisma.eventRegistration.updateMany).not.toHaveBeenCalled();
      },
    );
    it('uses General and zero price for historical registrations without tier or linked transaction', async () => {
      expect((await service.confirmTicketPayment(reference)).paymentStatus).toBe('paid');
      expect(prisma.ticket.create.mock.calls[0][0].data).toMatchObject({
        tier_name: 'General',
        price_paid: 0,
      });
      expect(prisma.transaction.update).not.toHaveBeenCalled();
    });
    it('refuses a lost registration claim without a confirmed ticket', async () => {
      prisma.eventRegistration.updateMany.mockResolvedValue({ count: 0 });
      prisma.eventRegistration.findUnique.mockResolvedValue(null);
      prisma.ticket.findFirst.mockResolvedValue(null);
      await expect(service.confirmTicketPayment(reference)).rejects.toThrow('could not be settled');
      expect(prisma.ticket.create).not.toHaveBeenCalled();
    });
  });
  describe('named ticket history and branch visibility', () => {
    it.each([true, false])(
      'resolves member and visitor names without widening branch selection (HQ=%s)',
      async (hq) => {
        const rows = [
          {
            id: 'member-ticket',
            event_id: mockEventId,
            member_id: mockMemberId,
            visitor_id: null,
            event: mockEvent,
          },
          {
            id: 'visitor-ticket',
            event_id: mockEventId,
            member_id: null,
            visitor_id: 'visitor',
            event: mockEvent,
          },
          {
            id: 'orphan',
            event_id: mockEventId,
            member_id: 'removed',
            visitor_id: 'removed',
            event: mockEvent,
          },
        ];
        prisma.ticket.findMany.mockResolvedValue(rows);
        prisma.ticket.count.mockResolvedValue(3);
        prisma.member.findMany.mockResolvedValue([
          { id: mockMemberId, first_name: 'Ada', last_name: 'Guest' },
        ]);
        prisma.visitor.findMany.mockResolvedValue([
          { id: 'visitor', first_name: 'Grace', last_name: null },
        ]);
        const result = await service.listAllTickets(
          mockChurchId,
          { page: 2, limit: 3, branchId: 'requested' },
          { church_id: mockChurchId, role: 'church_admin', is_admin_hq: hq, branch_id: 'own' },
        );
        const branchId = hq ? 'requested' : 'own';
        expect(prisma.ticket.findMany.mock.calls[0][0]).toMatchObject({
          skip: 3,
          take: 3,
          where: {
            event: { church_id: mockChurchId, OR: [{ branch_id: branchId }, { branch_id: null }] },
          },
        });
        expect(prisma.member.findMany.mock.calls[0][0].where).toEqual({
          church_id: mockChurchId,
          branch_id: branchId,
        });
        expect(prisma.visitor.findMany.mock.calls[0][0].where).toEqual({
          church_id: mockChurchId,
          branch_id: branchId,
        });
        expect(result.data.map((ticket) => [ticket.memberName, ticket.visitorName])).toEqual([
          ['Ada Guest', null],
          [null, 'Grace'],
          [null, null],
        ]);
      },
    );
  });
});
