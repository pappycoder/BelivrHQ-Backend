import { randomUUID } from 'crypto';
import { ConflictException } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { RequestContextService } from '../../src/common/services/request-context.service';
import { BranchScopeService } from '../../src/common/services/branch-scope.service';
import { AttendanceService } from '../../src/attendance/attendance.service';
import { EventsService } from '../../src/events/events.service';
import { SermonsService } from '../../src/sermons/sermons.service';

describe('Attendance identities and sermon URL persistence with PostgreSQL', () => {
  const prisma = new PrismaService(),
    context = new RequestContextService();
  const scopes = new BranchScopeService(context),
    audit = { log: jest.fn() } as never;
  const attendance = new AttendanceService(prisma, context, audit, scopes);
  const events = new EventsService(
    prisma,
    context,
    audit,
    new Map(),
    {} as never,
    scopes,
    {} as never,
  );
  const sermons = new SermonsService(prisma, audit, scopes);
  const church = randomUUID(),
    branch = randomUUID(),
    user = randomUUID();
  let event: string, service: string, member: string, visitor: string;
  beforeAll(async () => {
    await prisma.$connect();
    await prisma.church.create({ data: { id: church, name: 'Duplicate audit fixtures' } });
    await prisma.platformSubscription.create({
      data: {
        church_id: church,
        plan: 'network',
        cycle: 'monthly',
        paid_until: new Date('2099-01-01'),
      },
    });
    await prisma.branch.create({ data: { id: branch, church_id: church, name: 'Test branch' } });
  });
  beforeEach(async () => {
    event = randomUUID();
    service = randomUUID();
    member = randomUUID();
    visitor = randomUUID();
    await prisma.event.create({
      data: {
        id: event,
        church_id: church,
        branch_id: branch,
        title: 'Audit event',
        start_date: new Date(),
        is_free: true,
      },
    });
    await prisma.service.create({
      data: { id: service, church_id: church, branch_id: branch, name: `Service ${service}` },
    });
    await prisma.member.create({
      data: {
        id: member,
        church_id: church,
        branch_id: branch,
        first_name: 'Member',
        last_name: 'Test',
      },
    });
    await prisma.visitor.create({
      data: {
        id: visitor,
        church_id: church,
        branch_id: branch,
        first_name: 'Visitor',
        last_name: 'Test',
      },
    });
  });
  afterAll(async () => {
    await prisma.attendance.deleteMany({ where: { church_id: church } });
    await prisma.eventRegistration.updateMany({
      where: { church_id: church },
      data: { ticket_id: null },
    });
    await prisma.ticket.deleteMany({ where: { event: { church_id: church } } });
    await prisma.eventRegistration.deleteMany({ where: { church_id: church } });
    await prisma.sermon.deleteMany({ where: { church_id: church } });
    await prisma.mediaAsset.deleteMany({ where: { church_id: church } });
    await prisma.attendanceSession.deleteMany({ where: { church_id: church } });
    await prisma.event.deleteMany({ where: { church_id: church } });
    await prisma.service.deleteMany({ where: { church_id: church } });
    await prisma.visitor.deleteMany({ where: { church_id: church } });
    await prisma.member.deleteMany({ where: { church_id: church } });
    await prisma.branch.deleteMany({ where: { church_id: church } });
    await prisma.auditLog.deleteMany({ where: { church_id: church } });
    await prisma.church.delete({ where: { id: church } });
    await prisma.$disconnect();
  });

  it('accepts only one simultaneous event member check-in, including retries on another date', async () => {
    await prisma.event.update({
      where: { id: event },
      data: {
        start_date: new Date('2026-10-25T09:00:00Z'),
        end_date: new Date('2026-10-26T18:00:00Z'),
        recurrence: 'multi_day',
      },
    });
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        events.bulkCheckInAttendees(event, [member], church, user, '2026-10-25'),
      ),
    );
    expect(results.reduce((sum, result) => sum + result.checkedIn, 0)).toBe(1);
    expect(results.reduce((sum, result) => sum + result.skipped, 0)).toBe(5);
    expect(await events.bulkCheckInAttendees(event, [member], church, user, '2026-10-26')).toEqual({
      checkedIn: 0,
      skipped: 1,
    });
  });
  it('allows the member on a different service date, but only once on each date', async () => {
    const record = {
      _serviceOrEvent: undefined,
      serviceId: service,
      records: [{ memberId: member }],
      attendanceDate: '2026-10-25',
    };
    const results = await Promise.all(
      Array.from({ length: 5 }, () => attendance.recordBulkAttendance(record, church, user)),
    );
    expect(results.reduce((sum, result) => sum + result.recorded, 0)).toBe(1);
    expect(results.reduce((sum, result) => sum + result.skipped, 0)).toBe(4);
    expect(
      (
        await attendance.recordBulkAttendance(
          { ...record, attendanceDate: '2026-10-26' },
          church,
          user,
        )
      ).recorded,
    ).toBe(1);
  });
  it.each(['service', 'event'] as const)(
    'rejects simultaneous linked visitor check-ins for a %s',
    async (kind) => {
      const input = {
        ...(kind === 'service' ? { serviceId: service } : { eventId: event }),
        visitorId: visitor,
        visitorName: 'Visitor Test',
      };
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () => attendance.recordVisitorAttendance(input, church, user)),
      );
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      for (const result of results)
        if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(ConflictException);
      if (kind === 'service')
        expect(
          (
            await attendance.recordBulkAttendance(
              {
                _serviceOrEvent: undefined,
                serviceId: service,
                attendanceDate: '2099-01-01',
                records: [{ visitorId: visitor }],
              },
              church,
              user,
            )
          ).recorded,
        ).toBe(1);
    },
  );
  it('deduplicates legacy name-only entries despite case and spacing changes', async () => {
    await attendance.recordVisitorAttendance(
      { eventId: event, visitorName: 'Guest   Person' },
      church,
      user,
    );
    await expect(
      attendance.recordVisitorAttendance(
        { eventId: event, visitorName: ' guest person ' },
        church,
        user,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    const results = await Promise.allSettled(
      ['Other   Guest', 'other guest'].map((visitorName) =>
        attendance.recordVisitorAttendance({ eventId: event, visitorName }, church, user),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    for (const result of results)
      if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(ConflictException);
  });
  it('serializes walk-in lookup/creation even when a phone number is formatted differently', async () => {
    const walkIn = { firstName: 'New', lastName: 'Person', phone: '08012345678' };
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, index) =>
        events.walkInCheckIn(
          event,
          { ...walkIn, phone: index % 2 ? '080 1234 5678' : walkIn.phone },
          church,
          user,
        ),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    for (const result of results)
      if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(ConflictException);
    expect(
      await prisma.member.count({
        where: { church_id: church, first_name: 'New', last_name: 'Person' },
      }),
    ).toBe(1);
    expect(await prisma.attendance.count({ where: { event_id: event } })).toBe(1);
  });
  it('consumes a ticket once and shares the same attendance identity with the roster', async () => {
    const ticket = await prisma.ticket.create({
      data: { event_id: event, member_id: member, code: randomUUID(), status: 'paid' },
    });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => events.validateTicket(ticket.code, event, church)),
    );
    expect(results.filter((result) => result.valid)).toHaveLength(1);
    expect((await events.bulkCheckInAttendees(event, [member], church, user)).skipped).toBe(1);
    expect(await prisma.attendance.count({ where: { event_id: event, member_id: member } })).toBe(
      1,
    );
  });
  it('does not consume a different ticket after roster check-in', async () => {
    await events.bulkCheckInAttendees(event, [member], church, user);
    const ticket = await prisma.ticket.create({
      data: { event_id: event, member_id: member, code: randomUUID(), status: 'paid' },
    });
    expect((await events.validateTicket(ticket.code, event, church)).valid).toBe(false);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).is_used).toBe(
      false,
    );
  });
  it('persists and fetches file and external URLs, replaces one, and clears both without deleting library files', async () => {
    const assetId = randomUUID();
    const uploaded = 'https://church-os-web.vercel.app/api/backend/media/files/' + assetId;
    await prisma.mediaAsset.create({
      data: {
        id: assetId,
        church_id: church,
        branch_id: branch,
        filename: 'Recording.mp3',
        url: uploaded,
        mime_type: 'audio/mpeg',
        size_bytes: 100,
        folder: 'sermons',
        permissions: 'members',
      },
    });
    const external = 'https://www.youtube.com/watch?v=recording-a';
    const record = await sermons.createSermon(
      {
        title: 'URL round trip',
        branchId: branch,
        sermonDate: '2026-10-25',
        audioUrl: uploaded,
        videoUrl: external,
      },
      church,
      user,
    );
    expect(await sermons.getSermon(record.sermonId, church)).toMatchObject({
      audioUrl: uploaded,
      videoUrl: external,
    });
    await sermons.updateSermon(
      record.sermonId,
      { audioUrl: 'https://podcasts.example/message.mp3' },
      church,
      user,
    );
    expect(await sermons.getSermon(record.sermonId, church)).toMatchObject({
      audioUrl: 'https://podcasts.example/message.mp3',
      videoUrl: external,
    });
    await sermons.updateSermon(record.sermonId, { audioUrl: null, videoUrl: null }, church, user);
    const cleared = await sermons.getSermon(record.sermonId, church);
    expect(cleared.audioUrl).toBeUndefined();
    expect(cleared.videoUrl).toBeUndefined();
    expect(await prisma.mediaAsset.count({ where: { id: assetId, church_id: church } })).toBe(1);
    expect(await prisma.sermon.findUnique({ where: { id: record.sermonId } })).toMatchObject({
      audio_url: null,
      video_url: null,
    });
  });
});
