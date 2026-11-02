import { RequestContextService } from '../../../src/common/services/request-context.service';
/**
 * @file attendance.service.spec.ts
 * @description Unit tests for AttendanceService category + visitor-link behavior.
 *
 * Covers service categories, visitor check-in linkage, and the
 * category/gender summary breakdowns added with the visitors module.
 *
 * @module test/unit/attendance/attendance.service.spec
 * @since 1.0.0
 */

import { RecordBulkAttendanceDto } from '../../../src/attendance/dto/record-bulk-attendance.dto';
import { AttendanceService } from '../../../src/attendance/attendance.service';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { AuditLoggingService } from '../../../src/common/services/audit-logging.service';
import { BranchScopeService } from '../../../src/common/services/branch-scope.service';
import {
  ConflictException,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';

describe('AttendanceService — categories & visitors', () => {
  let service: AttendanceService;
  let prisma: Record<string, unknown> & { $transaction: jest.Mock };
  let audit: { log: jest.Mock };

  const churchId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const userId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const serviceId = 'cccccccc-cccc-cccc-cccc-cccccccccc01';
  const memberId = 'dddddddd-dddd-dddd-dddd-dddddddddd01';
  const visitorId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee01';

  const adultServiceRow = {
    id: serviceId,
    church_id: churchId,
    branch_id: null,
    name: 'Sunday Service',
    category: 'adult',
    day_of_week: 0,
    start_time: null,
    end_time: null,
    is_active: true,
    archived_at: null,
    created_at: new Date('2026-01-01'),
    updated_at: new Date('2026-01-01'),
  };

  const childrenServiceRow = {
    ...adultServiceRow,
    id: serviceId,
    category: 'children',
    name: 'Children Church',
  };

  const attendanceRow = {
    id: 'f1f1f1f1-f1f1-f1f1-f1f1-f1f1f1f1f1f1',
    church_id: churchId,
    service_id: serviceId,
    member_id: null,
    visitor_id: null,
    visitor_name: 'Walk-in Guest',
    category: 'adult',
    checkin_at: new Date('2026-08-24T09:15:00Z'),
    source: 'manual',
    created_at: new Date('2026-08-24T09:15:00Z'),
    service: { name: 'Sunday Service' },
    member: null,
    visitor: null,
  };

  function createPrismaMock() {
    const models: Record<string, Record<string, jest.Mock>> = {};
    const $transactionMock = jest.fn();

    const handler: ProxyHandler<Record<string, unknown>> = {
      get(_target, prop: string) {
        if (prop === '$transaction') return $transactionMock;
        if (!models[prop]) {
          models[prop] = {
            findMany: jest.fn(),
            findUnique: jest.fn(),
            findFirst: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
            delete: jest.fn(),
            count: jest.fn(),
            groupBy: jest.fn(),
            aggregate: jest.fn(),
          };
        }
        return models[prop];
      },
    };

    return new Proxy(
      { $transaction: $transactionMock } as Record<string, unknown>,
      handler,
    ) as Record<string, unknown> & { $transaction: jest.Mock };
  }

  function model(name: string): Record<string, jest.Mock> {
    return prisma[name] as Record<string, jest.Mock>;
  }

  beforeEach(() => {
    prisma = createPrismaMock();
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    service = new AttendanceService(
      prisma as unknown as PrismaService,
      new RequestContextService(),
      audit as unknown as AuditLoggingService,
      new BranchScopeService(new RequestContextService()),
    );
  });

  describe('createService', () => {
    it('saves the selected church-owned active branch for HQ', async () => {
      model('branch').findFirst.mockResolvedValue({ id: 'branch-b' });
      model('service').create.mockImplementation(({ data }) =>
        Promise.resolve({ ...adultServiceRow, ...data }),
      );
      const result = await service.createService(
        { name: 'Sunday', branchId: 'branch-b' },
        churchId,
        userId,
        { church_id: churchId, role: 'church_admin', is_admin_hq: true },
      );
      expect(model('branch').findFirst).toHaveBeenCalledWith({
        where: { id: 'branch-b', church_id: churchId, archived_at: null },
        select: { id: true },
      });
      expect(result.branchId).toBe('branch-b');
    });

    it('defaults branch-scoped creation to the assigned branch', async () => {
      model('branch').findFirst.mockResolvedValue({ id: 'branch-a' });
      model('service').create.mockImplementation(({ data }) =>
        Promise.resolve({ ...adultServiceRow, ...data }),
      );
      await service.createService({ name: 'Sunday' }, churchId, userId, {
        church_id: churchId,
        role: 'branch_pastor',
        branch_id: 'branch-a',
      });
      expect(model('service').create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ branch_id: 'branch-a' }) }),
      );
    });

    it('rejects attempts to create services in another branch', async () => {
      await expect(
        service.createService({ name: 'Sunday', branchId: 'branch-b' }, churchId, userId, {
          church_id: churchId,
          role: 'branch_pastor',
          branch_id: 'branch-a',
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(model('service').create).not.toHaveBeenCalled();
    });

    it('rejects branch-scoped creation without a branch assignment', async () => {
      await expect(
        service.createService({ name: 'Sunday' }, churchId, userId, {
          church_id: churchId,
          role: 'secretary',
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(model('service').create).not.toHaveBeenCalled();
    });

    it.each(['foreign', 'archived', 'missing'])(
      'rejects an unavailable %s branch before writing',
      async (branchId) => {
        model('branch').findFirst.mockResolvedValue(null);
        await expect(
          service.createService({ name: 'Sunday', branchId }, churchId, userId, {
            church_id: churchId,
            role: 'church_admin',
            is_admin_hq: true,
          }),
        ).rejects.toThrow(BadRequestException);
        expect(model('service').create).not.toHaveBeenCalled();
      },
    );

    it('creates a recurring mixed service with clock times and returns HH:mm', async () => {
      model('service').create.mockImplementation(({ data }) =>
        Promise.resolve({ ...adultServiceRow, ...data }),
      );
      const result = await service.createService(
        {
          name: 'Sunday Service',
          category: 'mixed',
          dayOfWeek: 0,
          startTime: '09:00',
          endTime: '11:00',
        },
        churchId,
        userId,
      );
      expect(model('service').create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            start_time: new Date('1970-01-01T09:00:00.000Z'),
            end_time: new Date('1970-01-01T11:00:00.000Z'),
          }),
        }),
      );
      expect(result).toMatchObject({ startTime: '09:00', endTime: '11:00', category: 'mixed' });
    });

    it('rejects invalid service times before writing', async () => {
      await expect(
        service.createService({ name: 'Sunday Service', startTime: '24:00' }, churchId, userId),
      ).rejects.toThrow(BadRequestException);
      expect(model('service').create).not.toHaveBeenCalled();
    });

    it('should default the category to adult', async () => {
      model('service').create.mockResolvedValue(adultServiceRow);
      await service.createService({ name: 'Sunday Service' }, churchId, userId);
      expect(model('service').create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ category: 'adult' }) }),
      );
    });

    it('should persist an explicit children category', async () => {
      model('service').create.mockResolvedValue(childrenServiceRow);
      await service.createService(
        { name: 'Children Church', category: 'children' },
        churchId,
        userId,
      );
      expect(model('service').create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ category: 'children' }) }),
      );
    });
  });

  describe('roster attendance dates', () => {
    it('stores and deduplicates service roster entries by the selected day', async () => {
      model('service').findUnique.mockResolvedValue(adultServiceRow);
      model('member').findFirst.mockResolvedValue({ id: memberId });
      const saved = new Set<string>();
      model('attendance').findUnique.mockImplementation(({ where }) => {
        const key = where.service_id_member_id_attendance_date.attendance_date.toISOString();
        return Promise.resolve(saved.has(key) ? { id: 'existing' } : null);
      });
      model('attendance').create.mockImplementation(({ data }) => {
        saved.add(data.attendance_date.toISOString());
        return Promise.resolve({ id: 'recorded' });
      });
      const input = Object.assign(new RecordBulkAttendanceDto(), {
        serviceId,
        records: [{ memberId }],
        attendanceDate: '2026-10-18',
      });
      expect(await service.recordBulkAttendance(input, churchId, userId)).toMatchObject({
        recorded: 1,
        skipped: 0,
      });
      expect(await service.recordBulkAttendance(input, churchId, userId)).toMatchObject({
        recorded: 0,
        skipped: 1,
      });
      expect(
        await service.recordBulkAttendance(
          { ...input, attendanceDate: '2026-10-25' },
          churchId,
          userId,
        ),
      ).toMatchObject({ recorded: 1, skipped: 0 });
      expect(model('attendance').create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            checkin_at: new Date('2026-10-18T00:00:00Z'),
            attendance_date: new Date('2026-10-18T00:00:00Z'),
          }),
        }),
      );
      expect(saved.size).toBe(2);
    });

    it('links roster details to the attendance session for the selected day', async () => {
      model('service').findUnique.mockResolvedValue({ ...adultServiceRow, branch_id: 'branch-a' });
      model('member').findFirst.mockResolvedValue({ id: memberId });
      model('attendanceSession').findFirst.mockResolvedValue({ id: 'past-session' });
      await service.recordBulkAttendance(
        Object.assign(new RecordBulkAttendanceDto(), {
          serviceId,
          attendanceDate: '2026-10-18',
          records: [{ memberId }],
        }),
        churchId,
        userId,
      );
      expect(model('attendanceSession').findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ attendance_date: new Date('2026-10-18T00:00:00Z') }),
        }),
      );
      expect(model('attendance').create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ session_id: 'past-session' }) }),
      );
    });
  });

  describe('recordAttendance', () => {
    it('should default category from the service (children service)', async () => {
      model('service').findUnique.mockResolvedValue(childrenServiceRow);
      model('member').findUnique.mockResolvedValue({ id: memberId, church_id: churchId });
      model('attendance').findUnique.mockResolvedValue(null);
      model('attendance').create.mockResolvedValue({ ...attendanceRow, category: 'children' });

      await service.recordAttendance(
        { serviceId, memberId, attendanceDate: '2026-10-18' },
        churchId,
        userId,
      );

      expect(model('attendance').create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ category: 'children', member_id: memberId }),
        }),
      );
    });

    it('should let an explicit category override the service default', async () => {
      model('service').findUnique.mockResolvedValue(adultServiceRow);
      model('member').findUnique.mockResolvedValue({ id: memberId, church_id: churchId });
      model('attendance').findUnique.mockResolvedValue(null);
      model('attendance').create.mockResolvedValue(attendanceRow);

      await service.recordAttendance(
        { serviceId, memberId, category: 'children', attendanceDate: '2026-10-18' },
        churchId,
        userId,
      );

      expect(model('attendance').create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ category: 'children' }),
        }),
      );
    });

    it('should validate a linked visitor belongs to the church and store its id/name', async () => {
      model('service').findUnique.mockResolvedValue(adultServiceRow);
      model('visitor').findUnique.mockResolvedValue({
        id: visitorId,
        church_id: churchId,
        first_name: 'Ada',
        last_name: 'Nwosu',
      });
      model('attendance').create.mockResolvedValue({
        ...attendanceRow,
        visitor_id: visitorId,
        visitor_name: 'Ada Nwosu',
      });

      await service.recordAttendance(
        { serviceId, visitorId, category: 'adult', attendanceDate: '2026-10-18' },
        churchId,
        userId,
      );

      expect(model('visitor').findUnique).toHaveBeenCalled();
      expect(model('attendance').create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            visitor_id: visitorId,
            visitor_name: 'Ada Nwosu',
          }),
        }),
      );
    });

    it('should reject a visitor from another church', async () => {
      model('service').findUnique.mockResolvedValue(adultServiceRow);
      model('visitor').findUnique.mockResolvedValue(null);

      await expect(
        service.recordAttendance(
          { serviceId, visitorId, attendanceDate: '2026-10-18' },
          churchId,
          userId,
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('recordVisitorAttendance', () => {
    it('should persist visitorId, name, and service-defaulted category', async () => {
      model('service').findUnique.mockResolvedValue(childrenServiceRow);
      model('visitor').findFirst.mockResolvedValue({ id: visitorId });
      model('attendance').create.mockResolvedValue({
        ...attendanceRow,
        category: 'children',
        visitor_id: visitorId,
        visitor_name: 'Ada Nwosu',
        visitor: { first_name: 'Ada', last_name: 'Nwosu' },
      });

      const result = await service.recordVisitorAttendance(
        { serviceId, visitorName: 'Ada Nwosu', visitorId, attendanceDate: '2026-10-18' },
        churchId,
        userId,
      );

      expect(model('attendance').create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            visitor_id: visitorId,
            visitor_name: 'Ada Nwosu',
            category: 'children',
          }),
        }),
      );
      expect(result.visitorName).toBe('Ada Nwosu');
      expect(result.category).toBe('children');
    });
  });

  describe('service schedules', () => {
    it('persists recurrence and date window on create', async () => {
      model('service').create.mockImplementation(({ data }) =>
        Promise.resolve({ ...adultServiceRow, ...data }),
      );
      const result = await service.createService(
        {
          name: 'Launch weekend',
          recurrence: 'multi_day',
          startsOn: '2026-11-01',
          endsOn: '2026-11-03',
        },
        churchId,
        userId,
      );
      expect(model('service').create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            recurrence: 'multi_day',
            starts_on: new Date('2026-11-01T00:00:00Z'),
            ends_on: new Date('2026-11-03T00:00:00Z'),
          }),
        }),
      );
      expect(result).toMatchObject({
        recurrence: 'multi_day',
        startsOn: '2026-11-01',
        endsOn: '2026-11-03',
      });
    });

    it('rejects a one-time service without a start date before writing', async () => {
      await expect(
        service.createService({ name: 'One off', recurrence: 'one_time' }, churchId, userId),
      ).rejects.toThrow('start date');
      expect(model('service').create).not.toHaveBeenCalled();
    });

    it('merges the existing schedule when a partial update touches recurrence only', async () => {
      model('service').findUnique.mockResolvedValue({
        ...adultServiceRow,
        recurrence: 'multi_day',
        starts_on: new Date('2026-11-01T00:00:00Z'),
        ends_on: new Date('2026-11-03T00:00:00Z'),
      });
      model('service').update.mockImplementation(({ data }) =>
        Promise.resolve({ ...adultServiceRow, ...data }),
      );
      const result = await service.updateService(
        serviceId,
        { recurrence: 'one_time' },
        churchId,
        userId,
      );
      expect(model('service').update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            recurrence: 'one_time',
            starts_on: new Date('2026-11-01T00:00:00Z'),
            ends_on: null,
          }),
        }),
      );
      expect(result).toMatchObject({ recurrence: 'one_time', startsOn: '2026-11-01' });
    });

    it('rejects check-in on a day the service does not meet', async () => {
      model('service').findUnique.mockResolvedValue(adultServiceRow);
      await expect(
        service.recordAttendance(
          { serviceId, memberId, attendanceDate: '2026-10-19' },
          churchId,
          userId,
        ),
      ).rejects.toThrow('does not meet on 2026-10-19');
      expect(model('attendance').create).not.toHaveBeenCalled();
    });

    it('accepts a past date the service does meet on', async () => {
      model('service').findUnique.mockResolvedValue(adultServiceRow);
      model('member').findUnique.mockResolvedValue({ id: memberId, church_id: churchId });
      model('attendance').findUnique.mockResolvedValue(null);
      model('attendance').create.mockResolvedValue({ ...attendanceRow, member_id: memberId });
      await service.recordAttendance(
        { serviceId, memberId, attendanceDate: '2026-09-06' },
        churchId,
        userId,
      );
      expect(model('attendance').create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            attendance_date: new Date('2026-09-06T00:00:00Z'),
          }),
        }),
      );
    });
  });

  describe('getAttendanceSummary', () => {
    it('should return byCategory counts and derived byGender breakdown', async () => {
      model('attendance')
        .count.mockResolvedValueOnce(10) // total
        .mockResolvedValueOnce(7) // members
        .mockResolvedValueOnce(3); // visitors
      model('attendance')
        .groupBy.mockResolvedValueOnce([
          { source: 'manual', _count: { id: 8 } },
          { source: 'qr', _count: { id: 2 } },
        ])
        .mockResolvedValueOnce([
          { category: 'adult', _count: { id: 7 } },
          { category: 'children', _count: { id: 3 } },
        ]);
      model('attendance').findMany.mockResolvedValue([
        { member: { gender: 'male' }, visitor: null },
        { member: { gender: 'Female' }, visitor: null }, // case-insensitive
        { member: null, visitor: { gender: 'male' } },
        { member: null, visitor: null }, // legacy unlinked → unknown
      ]);

      const result = await service.getAttendanceSummary(churchId);

      expect(result.byCategory).toEqual({ adult: 7, children: 3 });
      expect(result.byGender).toEqual({ male: 2, female: 1, unknown: 1 });
      expect(result.bySource).toEqual({ manual: 8, qr: 2 });
    });
  });

  describe('updateService', () => {
    it('updates the branch to an active church-owned branch for HQ', async () => {
      model('service').findUnique.mockResolvedValue({ ...adultServiceRow, branch_id: 'branch-a' });
      model('branch').findFirst.mockResolvedValue({ id: 'branch-b' });
      model('service').update.mockResolvedValue({ ...adultServiceRow, branch_id: 'branch-b' });
      const result = await new RequestContextService().run(
        {
          userId,
          churchId,
          role: 'church_admin',
          viewer: { church_id: churchId, role: 'church_admin', is_admin_hq: true },
        },
        () => service.updateService(serviceId, { branchId: 'branch-b' }, churchId, userId),
      );
      expect(model('branch').findFirst).toHaveBeenCalledWith({
        where: { id: 'branch-b', church_id: churchId, archived_at: null },
        select: { id: true },
      });
      expect(model('service').update).toHaveBeenCalledWith({
        where: { id: serviceId },
        data: { branch: { connect: { id: 'branch-b' } } },
      });
      expect(result.branchId).toBe('branch-b');
    });

    it.each(['foreign', 'archived', 'missing'])(
      'rejects moving a service to an unavailable %s branch',
      async (branchId) => {
        model('service').findUnique.mockResolvedValue(adultServiceRow);
        model('branch').findFirst.mockResolvedValue(null);
        await expect(
          service.updateService(serviceId, { branchId }, churchId, userId),
        ).rejects.toThrow(BadRequestException);
        expect(model('service').update).not.toHaveBeenCalled();
      },
    );

    it('rejects branch-scoped attempts to move a service to another branch', async () => {
      model('service').findUnique.mockResolvedValue({ ...adultServiceRow, branch_id: 'branch-a' });
      await expect(
        new RequestContextService().run(
          {
            userId,
            churchId,
            role: 'branch_pastor',
            viewer: { church_id: churchId, role: 'branch_pastor', branch_id: 'branch-a' },
          },
          () => service.updateService(serviceId, { branchId: 'branch-b' }, churchId, userId),
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(model('service').update).not.toHaveBeenCalled();
    });

    it('updates and clears clock times without requiring a calendar date', async () => {
      model('service').findUnique.mockResolvedValue(adultServiceRow);
      model('service').update.mockImplementation(({ data }) =>
        Promise.resolve({ ...adultServiceRow, ...data }),
      );
      const result = await service.updateService(
        serviceId,
        { startTime: '23:30', endTime: '01:00' },
        churchId,
        userId,
      );
      expect(result).toMatchObject({ startTime: '23:30', endTime: '01:00' });
      await service.updateService(serviceId, { startTime: null, endTime: null }, churchId, userId);
      expect(model('service').update).toHaveBeenLastCalledWith(
        expect.objectContaining({ data: { start_time: null, end_time: null } }),
      );
    });

    it('should clear day_of_week when an explicit null is sent', async () => {
      model('service').findUnique.mockResolvedValue(adultServiceRow);
      model('service').update.mockResolvedValue({ ...adultServiceRow, day_of_week: null });

      await service.updateService(serviceId, { dayOfWeek: null }, churchId, userId);

      expect(model('service').update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ day_of_week: null }),
        }),
      );
    });

    it('should throw NotFoundException when updating an archived service', async () => {
      model('service').findUnique.mockResolvedValue({
        ...adultServiceRow,
        archived_at: new Date('2026-08-01T00:00:00.000Z'),
      });

      await expect(
        service.updateService(serviceId, { name: 'X' }, churchId, userId),
      ).rejects.toThrow(NotFoundException);
      expect(model('service').update).not.toHaveBeenCalled();
    });
  });

  describe('getAttendanceTrends', () => {
    it('should use the explicit date range instead of the rolling days window', async () => {
      model('attendance').findMany.mockResolvedValue([]);

      await service.getAttendanceTrends(churchId, 30, undefined, '2026-08-01', '2026-08-24');

      const call = model('attendance').findMany.mock.calls[0][0];
      expect(call.where.church_id).toBe(churchId);
      expect(call.where.checkin_at.gte).toEqual(new Date('2026-08-01'));
      expect(call.where.checkin_at.lte).toEqual(new Date('2026-08-24'));
    });

    it('should fall back to the rolling days window without a range', async () => {
      model('attendance').findMany.mockResolvedValue([]);

      const before = Date.now();
      await service.getAttendanceTrends(churchId, 30);

      const call = model('attendance').findMany.mock.calls[0][0];
      const gte = call.where.checkin_at.gte as Date;
      expect(gte.getTime()).toBeGreaterThanOrEqual(before - 30 * 86_400_000);
      expect(gte.getTime()).toBeLessThanOrEqual(Date.now());
    });
  });

  describe('listServices', () => {
    it('should include the all-time attendance count per service', async () => {
      model('service').findMany.mockResolvedValue([
        { ...adultServiceRow, _count: { attendance: 128 } },
      ]);
      model('service').count.mockResolvedValue(1);

      const result = await service.listServices(churchId, {});

      expect(model('service').findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          include: { _count: { select: { attendance: true } } },
        }),
      );
      expect(result.data[0].attendanceCount).toBe(128);
    });

    it('should default to excluding archived services (archived_at null)', async () => {
      model('service').findMany.mockResolvedValue([]);
      model('service').count.mockResolvedValue(0);

      await service.listServices(churchId, {});

      expect(model('service').findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ archived_at: null }),
        }),
      );
    });

    it('should list only archived services when archived=true and map archivedAt', async () => {
      model('service').findMany.mockResolvedValue([
        { ...adultServiceRow, archived_at: new Date('2026-08-01T00:00:00.000Z') },
      ]);
      model('service').count.mockResolvedValue(1);

      const result = await service.listServices(churchId, { archived: true });

      expect(model('service').findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ archived_at: { not: null } }),
        }),
      );
      expect(result.data[0].archivedAt).toBe('2026-08-01T00:00:00.000Z');
    });
  });

  describe('deleteService', () => {
    it('should delete a service with no attendance or giving references', async () => {
      model('service').findUnique.mockResolvedValue(adultServiceRow);
      model('attendance').count.mockResolvedValue(0);
      model('transaction').count.mockResolvedValue(0);
      model('service').delete.mockResolvedValue(adultServiceRow);

      const result = await service.deleteService(serviceId, churchId, userId);

      expect(result).toEqual({ success: true });
      expect(model('service').delete).toHaveBeenCalledWith({ where: { id: serviceId } });
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'service', action: 'DELETE' }),
      );
    });

    it('should block deletion while attendance records reference the service', async () => {
      model('service').findUnique.mockResolvedValue(adultServiceRow);
      model('attendance').count.mockResolvedValue(12);
      model('transaction').count.mockResolvedValue(0);

      await expect(service.deleteService(serviceId, churchId, userId)).rejects.toThrow(
        ConflictException,
      );
      expect(model('service').delete).not.toHaveBeenCalled();
    });

    it('should block deletion while giving transactions reference the service', async () => {
      model('service').findUnique.mockResolvedValue(adultServiceRow);
      model('attendance').count.mockResolvedValue(0);
      model('transaction').count.mockResolvedValue(4);

      await expect(service.deleteService(serviceId, churchId, userId)).rejects.toThrow(
        ConflictException,
      );
      expect(model('service').delete).not.toHaveBeenCalled();
    });

    it('should throw NotFound for a foreign-church service', async () => {
      model('service').findUnique.mockResolvedValue(null);

      await expect(service.deleteService(serviceId, churchId, userId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should still delete (purge path) an archived service', async () => {
      model('service').findUnique.mockResolvedValue({
        ...adultServiceRow,
        archived_at: new Date('2026-08-01T00:00:00.000Z'),
      });
      model('attendance').count.mockResolvedValue(0);
      model('transaction').count.mockResolvedValue(0);
      model('service').delete.mockResolvedValue(adultServiceRow);

      const result = await service.deleteService(serviceId, churchId, userId);

      expect(result).toEqual({ success: true });
      expect(model('service').delete).toHaveBeenCalledWith({ where: { id: serviceId } });
    });
  });

  describe('archiveService', () => {
    it('should archive a service and audit ARCHIVE', async () => {
      model('service').findUnique.mockResolvedValue(adultServiceRow);
      const archived = { ...adultServiceRow, archived_at: new Date('2026-08-01T00:00:00.000Z') };
      model('service').update.mockResolvedValue(archived);

      const result = await service.archiveService(serviceId, churchId, userId);

      expect(model('service').update).toHaveBeenCalledWith({
        where: { id: serviceId },
        data: { archived_at: expect.any(Date) },
      });
      expect(result.archivedAt).toBe('2026-08-01T00:00:00.000Z');
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'service', action: 'ARCHIVE' }),
      );
    });

    it('should throw ConflictException when already archived', async () => {
      model('service').findUnique.mockResolvedValue({
        ...adultServiceRow,
        archived_at: new Date('2026-08-01T00:00:00.000Z'),
      });

      await expect(service.archiveService(serviceId, churchId, userId)).rejects.toThrow(
        ConflictException,
      );
    });

    it('should throw NotFoundException when missing or foreign-church', async () => {
      model('service').findUnique.mockResolvedValue(null);

      await expect(service.archiveService('nonexistent', churchId, userId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('restoreService', () => {
    it('should restore an archived service and audit RESTORE', async () => {
      model('service').findUnique.mockResolvedValue({
        ...adultServiceRow,
        archived_at: new Date('2026-08-01T00:00:00.000Z'),
      });
      model('service').update.mockResolvedValue(adultServiceRow);

      const result = await service.restoreService(serviceId, churchId, userId);

      expect(model('service').update).toHaveBeenCalledWith({
        where: { id: serviceId },
        data: { archived_at: null },
      });
      expect(result.archivedAt).toBeUndefined();
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'service', action: 'RESTORE' }),
      );
    });

    it('should throw ConflictException when not archived', async () => {
      model('service').findUnique.mockResolvedValue(adultServiceRow);

      await expect(service.restoreService(serviceId, churchId, userId)).rejects.toThrow(
        ConflictException,
      );
    });

    it('should throw NotFoundException when missing', async () => {
      model('service').findUnique.mockResolvedValue(null);

      await expect(service.restoreService('nonexistent', churchId, userId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('deleteAttendance', () => {
    it('should delete a record scoped to the church and audit-log it', async () => {
      model('attendance').findUnique.mockResolvedValue(attendanceRow);
      model('attendance').delete.mockResolvedValue(attendanceRow);

      const result = await service.deleteAttendance(attendanceRow.id, churchId, userId);

      expect(result).toEqual({ success: true });
      expect(model('attendance').delete).toHaveBeenCalledWith({
        where: { id: attendanceRow.id },
      });
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'attendance', action: 'DELETE' }),
      );
    });

    it('should throw NotFound when the record is missing or belongs to another church', async () => {
      model('attendance').findUnique.mockResolvedValue(null);

      await expect(service.deleteAttendance(attendanceRow.id, churchId, userId)).rejects.toThrow(
        NotFoundException,
      );
      expect(model('attendance').delete).not.toHaveBeenCalled();
    });
  });

  describe('listAttendance', () => {
    it('should paginate, include display relations, and map the response', async () => {
      model('attendance').findMany.mockResolvedValue([
        {
          ...attendanceRow,
          member: { first_name: 'Chioma', last_name: 'Eze' },
          visitor: { first_name: 'Ada', last_name: 'Nwosu' },
        },
      ]);
      model('attendance').count.mockResolvedValue(1);

      const result = await service.listAttendance(churchId, { page: 2, limit: 20 });

      expect(model('attendance').findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { church_id: churchId },
          orderBy: { checkin_at: 'desc' },
          skip: 20,
          take: 20,
        }),
      );
      expect(result.total).toBe(1);
      expect(result.data[0].memberName).toBe('Chioma Eze');
      expect(result.data[0].serviceName).toBe('Sunday Service');
    });

    it('should apply service/category/date-range filters to the where clause', async () => {
      model('attendance').findMany.mockResolvedValue([]);
      model('attendance').count.mockResolvedValue(0);

      await service.listAttendance(churchId, {
        serviceId,
        category: 'children',
        startDate: '2026-08-01',
        endDate: '2026-08-24',
        sortBy: 'createdAt',
        sortOrder: 'asc',
      });

      expect(model('attendance').findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            church_id: churchId,
            service_id: serviceId,
            category: 'children',
            checkin_at: {
              gte: new Date('2026-08-01'),
              lte: new Date('2026-08-24'),
            },
          },
          orderBy: { created_at: 'asc' },
        }),
      );
    });
  });
});
