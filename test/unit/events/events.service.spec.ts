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
});
