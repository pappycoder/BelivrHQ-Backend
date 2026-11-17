import { RequestContextService } from '../../../src/common/services/request-context.service';
/**
 * @file appointments.service.spec.ts
 * @description Unit tests for AppointmentsService (booking registry, With/Who model).
 */

import { AppointmentsService, PASTOR_ROLES } from '../../../src/appointments/appointments.service';

function createPrismaMock() {
  const models: Record<string, Record<string, jest.Mock>> = {};
  const handl = { log: jest.fn().mockResolvedValue(undefined) };
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_target, prop: string) {
      if (prop === '$transaction') return jest.fn();
      if (prop === '$queryRaw') return jest.fn().mockResolvedValue([]);
      if (!models[prop]) {
        models[prop] = {
          findMany: jest.fn(),
          findUnique: jest.fn(),
          findFirst: jest.fn(),
          create: jest.fn(),
          createMany: jest.fn(),
          update: jest.fn(),
          updateMany: jest.fn(),
          delete: jest.fn(),
          deleteMany: jest.fn(),
          count: jest.fn(),
          aggregate: jest.fn(),
          groupBy: jest.fn(),
          upsert: jest.fn(),
        };
      }
      return models[prop];
    },
  };
  const prisma = new Proxy({} as Record<string, unknown>, handler) as Record<string, unknown> & {
    $transaction: jest.Mock;
  };
  prisma.$transaction = jest.fn();
  return { prisma, models, handl };
}

let mocks: ReturnType<typeof createPrismaMock>;
let prisma: ReturnType<typeof createPrismaMock>['prisma'];
let audit: { log: jest.Mock };
let service: AppointmentsService;

const CHURCH = '00000000-0000-0000-0000-000000000001';
const SEC = '22222222-2222-2222-2222-222222222222';
const PASTOR = '11111111-1111-1111-1111-111111111111';
const WHO = '66666666-6666-6666-6666-666666666666';
const VISITOR = '8c8c8c8c-8c8c-8c8c-8c8c-8c8c8c8c8c8c';
const BRANCH_A = '33333333-3333-3333-3333-333333333333';
const BRANCH_B = '44444444-4444-4444-4444-444444444444';

function scopeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    is_admin_hq: false,
    role: ['secretary'],
    branch_id: BRANCH_A,
    branch: { is_headquarters: false },
    ...overrides,
  };
}

function pastorRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PASTOR,
    first_name: 'Pastor John',
    last_name: 'Adebayo',
    role: ['branch_pastor'],
    status: 'active',
    is_admin_hq: false,
    branch_id: BRANCH_A,
    avatar_url: null,
    branch: { id: BRANCH_A, name: 'Main Campus' },
    ...overrides,
  };
}

function personRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: WHO,
    first_name: 'Bola',
    last_name: 'Okonkwo',
    role: ['secretary'],
    status: 'active',
    branch_id: BRANCH_A,
    avatar_url: null,
    branch: { id: BRANCH_A, name: 'Main Campus' },
    ...overrides,
  };
}

function apptRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '99999999-9999-9999-9999-999999999999',
    church_id: CHURCH,
    branch_id: BRANCH_A,
    pastor_id: PASTOR,
    person_id: WHO,
    visitor_id: null,
    title: 'Budget planning',
    scheduled_at: new Date('2026-09-05T10:00:00.000Z'),
    location: null,
    notes: null,
    status: 'pending',
    created_at: new Date('2026-08-30T08:00:00.000Z'),
    archived_at: null,
    ...overrides,
  };
}

function personProfileRow(): Record<string, unknown> {
  return { id: WHO, first_name: 'Bola', last_name: 'Okonkwo', role: ['secretary'] };
}

beforeEach(() => {
  mocks = createPrismaMock();
  prisma = mocks.prisma;
  (prisma.visitor as unknown as Record<string, jest.Mock>).findMany.mockImplementation(async () => {
    const row = await (prisma.visitor as unknown as Record<string, jest.Mock>).findFirst();
    return row ? [row] : [];
  });
  audit = mocks.handl as { log: jest.Mock };
  service = new AppointmentsService(prisma as never, new RequestContextService(), audit as never);
});

function model(name: string): Record<string, jest.Mock> {
  return prisma[name] as unknown as Record<string, jest.Mock>;
}

describe('AppointmentsService', () => {
  it('exports pastor roles', () => {
    expect([...PASTOR_ROLES]).toEqual(['branch_pastor', 'church_admin', 'senior_pastor']);
  });

  describe('create', () => {
    it('creates an appointment as a branch secretary (With pastor + Who person, same branch)', async () => {
      model('profile').findFirst.mockResolvedValueOnce(scopeRow()); // resolveScope
      model('profile').findFirst.mockResolvedValueOnce(pastorRow()); // With
      model('profile').findFirst.mockResolvedValueOnce(personRow()); // Who
      model('appointment').create.mockResolvedValueOnce(apptRow({ person_id: WHO }));
      model('profile').findMany.mockResolvedValueOnce([personProfileRow(), pastorRow()]);
      model('visitor').findFirst.mockResolvedValueOnce(null); // buildDetail visitor lookup

      const result = await service.create(
        {
          title: 'Budget planning',
          scheduledAt: '2026-09-05T10:00:00.000Z',
          withId: PASTOR,
          whoId: WHO,
        },
        CHURCH,
        SEC,
        'user-1',
      );

      expect(result.personId).toBe(WHO);
      expect(result.pastorId).toBe(PASTOR);
      expect(model('appointment').create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            title: 'Budget planning',
            pastor_id: PASTOR,
            person_id: WHO,
            visitor_id: null,
          }),
        }),
      );
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'appointment', action: 'CREATE' }),
      );
    });

    it('creates an appointment with an existing visitor as the Who party', async () => {
      model('profile').findFirst.mockResolvedValueOnce(scopeRow()); // resolveScope
      model('profile').findFirst.mockResolvedValueOnce(pastorRow()); // With
      model('visitor').findFirst.mockResolvedValueOnce({
        id: VISITOR,
        first_name: 'Tunde',
        last_name: 'Bello',
      }); // Who visitor
      model('appointment').create.mockResolvedValueOnce(
        apptRow({ person_id: SEC, visitor_id: VISITOR }),
      );
      model('profile').findMany.mockResolvedValueOnce([
        { id: SEC, first_name: 'Bola', last_name: 'Okonkwo', role: ['secretary'] },
        pastorRow(),
      ]);
      model('visitor').findFirst.mockResolvedValueOnce({
        id: VISITOR,
        first_name: 'Tunde',
        last_name: 'Bello',
      }); // buildDetail visitor lookup

      const result = await service.create(
        {
          title: 'Outreach',
          scheduledAt: '2026-09-05T10:00:00.000Z',
          withId: PASTOR,
          whoKind: 'visitor',
          visitorId: VISITOR,
        },
        CHURCH,
        SEC,
        'user-1',
      );

      expect(result.whoKind).toBe('visitor');
      expect(result.visitorName).toBe('Tunde Bello');
      expect(model('appointment').create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            pastor_id: PASTOR,
            person_id: SEC,
            visitor_id: VISITOR,
          }),
        }),
      );
    });

    it('rejects a cross-branch With pastor for a branch booker', async () => {
      model('profile').findFirst.mockResolvedValueOnce(scopeRow());
      model('profile').findFirst.mockResolvedValueOnce(
        pastorRow({ branch_id: BRANCH_B, branch: { id: BRANCH_B, name: 'Branch B' } }),
      );

      await expect(
        service.create(
          {
            title: 'Budget planning',
            scheduledAt: '2026-09-05T10:00:00.000Z',
            withId: PASTOR,
            whoId: WHO,
          },
          CHURCH,
          SEC,
          'user-1',
        ),
      ).rejects.toThrow('same branch');
    });

    it('allows an HQ booker to pick a church-wide pastor', async () => {
      model('profile').findFirst.mockResolvedValueOnce(
        scopeRow({ is_admin_hq: true, branch_id: BRANCH_B, branch: { is_headquarters: true } }),
      );
      model('profile').findFirst.mockResolvedValueOnce(
        pastorRow({ branch_id: BRANCH_A, branch: { id: BRANCH_A, name: 'Main Campus' } }),
      );
      model('profile').findFirst.mockResolvedValueOnce(personRow());
      model('appointment').create.mockResolvedValueOnce(apptRow({ person_id: WHO }));
      model('profile').findMany.mockResolvedValueOnce([personProfileRow(), pastorRow()]);
      model('visitor').findFirst.mockResolvedValueOnce(null);

      const result = await service.create(
        {
          title: 'Budget planning',
          scheduledAt: '2026-09-05T10:00:00.000Z',
          withId: PASTOR,
          whoId: WHO,
        },
        CHURCH,
        SEC,
        'user-1',
      );
      expect(result.pastorId).toBe(PASTOR);
    });

    it('allows a caller with a custom role through the permission-protected booking API', async () => {
      model('profile').findFirst.mockResolvedValueOnce(scopeRow({ role: ['custom_booker'] }));
      model('profile').findFirst.mockResolvedValueOnce(pastorRow());
      model('profile').findFirst.mockResolvedValueOnce(personRow());
      model('appointment').create.mockResolvedValueOnce(apptRow({ person_id: WHO }));
      model('profile').findMany.mockResolvedValueOnce([personProfileRow(), pastorRow()]);
      model('visitor').findFirst.mockResolvedValueOnce(null);
      const result = await service.create(
        { title: 'x', scheduledAt: '2026-09-05T10:00:00.000Z', withId: PASTOR, whoId: WHO },
        CHURCH,
        SEC,
        'u',
      );
      expect(result.id).toBe(apptRow().id);
    });

    it('allows a super_admin to book', async () => {
      model('profile').findFirst.mockResolvedValueOnce(
        scopeRow({ role: ['super_admin'], is_admin_hq: true }),
      );
      model('profile').findFirst.mockResolvedValueOnce(pastorRow());
      model('profile').findFirst.mockResolvedValueOnce(personRow());
      model('appointment').create.mockResolvedValueOnce(apptRow({ person_id: WHO }));
      model('profile').findMany.mockResolvedValueOnce([personProfileRow(), pastorRow()]);
      model('visitor').findFirst.mockResolvedValueOnce(null);

      const result = await service.create(
        { title: 'x', scheduledAt: '2026-09-05T10:00:00.000Z', withId: PASTOR, whoId: WHO },
        CHURCH,
        SEC,
        'u',
      );
      expect(result.id).toBe(apptRow().id);
    });

    it('rejects the With pastor equaling the Who person', async () => {
      model('profile').findFirst.mockResolvedValueOnce(scopeRow());
      model('profile').findFirst.mockResolvedValueOnce(pastorRow());
      model('profile').findFirst.mockResolvedValueOnce(pastorRow()); // Who same as With
      await expect(
        service.create(
          { title: 'x', scheduledAt: '2026-09-05T10:00:00.000Z', withId: PASTOR, whoId: PASTOR },
          CHURCH,
          SEC,
          'u',
        ),
      ).rejects.toThrow('must be different people');
    });

    it('rejects whoKind visitor without a visitorId', async () => {
      model('profile').findFirst.mockResolvedValueOnce(scopeRow());
      await expect(
        service.create(
          {
            title: 'x',
            scheduledAt: '2026-09-05T10:00:00.000Z',
            withId: PASTOR,
            whoKind: 'visitor',
          },
          CHURCH,
          SEC,
          'u',
        ),
      ).rejects.toThrow('A visitor ID is required');
    });
  });

  describe('list', () => {
    it('filters to the current scope (person or pastor) with active rows + summary', async () => {
      model('appointment').findMany.mockResolvedValueOnce([
        apptRow({ person_id: SEC, visitor_id: null }),
      ]);
      model('appointment').count.mockResolvedValueOnce(1);
      model('profile').findMany.mockResolvedValueOnce([personRow({ id: SEC })]);
      model('visitor').findFirst.mockResolvedValueOnce(null);
      model('appointment').groupBy.mockResolvedValueOnce([
        { status: 'pending', _count: { _all: 1 } },
      ]);

      const result = await service.list(CHURCH, SEC, { page: 1, limit: 30 });

      expect(result.total).toBe(1);
      expect(model('appointment').findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            church_id: CHURCH,
            AND: [{ OR: [{ person_id: SEC }, { pastor_id: SEC }] }],
            archived_at: null,
          }),
        }),
      );
      expect(result.summary.pending).toBe(1);
    });

    it('applies status, search, and date filters and the archived view', async () => {
      model('appointment').findMany.mockResolvedValueOnce([]);
      model('appointment').count.mockResolvedValueOnce(0);
      model('profile').findMany.mockResolvedValueOnce([]);
      model('appointment').groupBy.mockResolvedValueOnce([]);

      await service.list(CHURCH, SEC, {
        status: 'confirmed',
        search: 'budget',
        startDate: '2026-09-01',
        endDate: '2026-09-30',
        archived: true,
      });

      const where = model('appointment').findMany.mock.calls[0][0].where;
      expect(where.status).toBe('confirmed');
      expect(where.archived_at).toEqual({ not: null });
      expect(where.scheduled_at).toEqual(
        expect.objectContaining({
          gte: new Date('2026-09-01T00:00:00.000Z'),
          lte: new Date('2026-09-30T23:59:59.999Z'),
        }),
      );
    });
  });

  describe('getOne', () => {
    it('returns the appointment for a party', async () => {
      model('appointment').findFirst.mockResolvedValueOnce(apptRow());
      model('profile').findMany.mockResolvedValueOnce([personRow()]);
      model('visitor').findFirst.mockResolvedValueOnce(null);
      const result = await service.getOne(apptRow().id as string, CHURCH, SEC);
      expect(result.id).toBe(apptRow().id);
    });

    it('404s when not a party', async () => {
      model('appointment').findFirst.mockResolvedValueOnce(null);
      await expect(service.getOne('x', CHURCH, SEC)).rejects.toThrow('not found');
    });
  });

  describe('update', () => {
    it('updates status/title fields preserving parties', async () => {
      model('appointment').findFirst.mockResolvedValueOnce(apptRow());
      model('profile').findFirst.mockResolvedValueOnce(scopeRow()); // resolveScope
      model('appointment').update.mockResolvedValueOnce(apptRow({ status: 'confirmed' }));
      model('profile').findMany.mockResolvedValueOnce([personRow()]);
      model('visitor').findFirst.mockResolvedValueOnce(null);

      const result = await service.update(
        apptRow().id as string,
        { status: 'confirmed' },
        CHURCH,
        SEC,
        'user-1',
      );
      expect(result.status).toBe('confirmed');
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'UPDATE', entity: 'appointment' }),
      );
    });

    it('re-changes the With pastor within scope when withId given', async () => {
      const newPastor = '55555555-5555-5555-5555-555555555555';
      model('appointment').findFirst.mockResolvedValueOnce(apptRow());
      model('profile').findFirst.mockResolvedValueOnce(scopeRow()); // resolveScope
      model('profile').findFirst.mockResolvedValueOnce(
        pastorRow({ id: newPastor, branch_id: BRANCH_A }),
      ); // With
      model('appointment').update.mockResolvedValueOnce(apptRow({ pastor_id: newPastor }));
      model('profile').findMany.mockResolvedValueOnce([personRow()]);
      model('visitor').findFirst.mockResolvedValueOnce(null);

      await service.update(apptRow().id as string, { withId: newPastor }, CHURCH, SEC, 'u');
      const data = model('appointment').update.mock.calls[0][0].data;
      expect(data.pastor_id).toBe(newPastor);
      expect(data.person_id).toBe(WHO);
    });

    it('swaps the Who party to an existing visitor on update', async () => {
      model('appointment').findFirst.mockResolvedValueOnce(apptRow());
      model('profile').findFirst.mockResolvedValueOnce(scopeRow());
      model('visitor').findFirst.mockResolvedValueOnce({
        id: VISITOR,
        first_name: 'Tunde',
        last_name: 'Bello',
      }); // Who visitor
      model('appointment').update.mockResolvedValueOnce(
        apptRow({ person_id: SEC, visitor_id: VISITOR }),
      );
      model('profile').findMany.mockResolvedValueOnce([personRow({ id: SEC })]);
      model('visitor').findFirst.mockResolvedValueOnce({
        id: VISITOR,
        first_name: 'Tunde',
        last_name: 'Bello',
      }); // buildDetail

      const result = await service.update(
        apptRow().id as string,
        { whoKind: 'visitor', visitorId: VISITOR },
        CHURCH,
        SEC,
        'u',
      );
      const data = model('appointment').update.mock.calls[0][0].data;
      expect(data.visitor_id).toBe(VISITOR);
      expect(result.whoKind).toBe('visitor');
    });
  });

  describe('archive / restore / delete', () => {
    it('archives an active appointment', async () => {
      model('appointment').findFirst.mockResolvedValueOnce(apptRow());
      model('appointment').update.mockResolvedValueOnce(apptRow({ archived_at: new Date() }));
      await service.archive(apptRow().id as string, CHURCH, SEC, 'u');
      expect(model('appointment').update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { archived_at: expect.any(Date) } }),
      );
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'ARCHIVE' }));
    });

    it('400s archiving an already-archived appointment', async () => {
      model('appointment').findFirst.mockResolvedValueOnce(apptRow({ archived_at: new Date() }));
      await expect(service.archive(apptRow().id as string, CHURCH, SEC, 'u')).rejects.toThrow(
        'already archived',
      );
    });

    it('restores an archived appointment', async () => {
      model('appointment').findFirst.mockResolvedValueOnce(apptRow({ archived_at: new Date() }));
      model('appointment').update.mockResolvedValueOnce(apptRow());
      await service.restore(apptRow().id as string, CHURCH, SEC, 'u');
      expect(model('appointment').update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { archived_at: null } }),
      );
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'RESTORE' }));
    });

    it('400s restoring a non-archived appointment', async () => {
      model('appointment').findFirst.mockResolvedValueOnce(apptRow());
      await expect(service.restore(apptRow().id as string, CHURCH, SEC, 'u')).rejects.toThrow(
        'not archived',
      );
    });

    it('purges an archived appointment', async () => {
      model('appointment').findFirst.mockResolvedValueOnce(apptRow({ archived_at: new Date() }));
      model('appointment').delete.mockResolvedValueOnce(apptRow());
      await service.deleteForever(apptRow().id as string, CHURCH, SEC, 'u');
      expect(model('appointment').delete).toHaveBeenCalledWith({
        where: { id: apptRow().id },
      });
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'DELETE' }));
    });

    it('400s deleting a non-archived appointment', async () => {
      model('appointment').findFirst.mockResolvedValueOnce(apptRow());
      await expect(service.deleteForever(apptRow().id as string, CHURCH, SEC, 'u')).rejects.toThrow(
        'archived before permanent deletion',
      );
    });
  });

  describe('contacts', () => {
    it('lists With (pastor) participants in the same branch for a branch booker', async () => {
      model('profile').findFirst.mockResolvedValueOnce(scopeRow());
      model('profile').findMany.mockResolvedValueOnce([pastorRow()]);

      const result = await service.listContacts(CHURCH, SEC, { kind: 'with' });

      expect(result.total).toBe(1);
      expect(result.data[0].kind).toBe('with');
      expect(result.data[0].isPastor).toBe(true);
      const where = model('profile').findMany.mock.calls[0][0].where;
      expect(where.role.hasSome).toContain('branch_pastor');
      expect(where.branch_id).toBe(BRANCH_A);
    });

    it('lists all profiles for the Who picker plus optional existing visitors', async () => {
      model('profile').findFirst.mockResolvedValueOnce(scopeRow());
      model('profile').findMany.mockResolvedValueOnce([personRow()]);
      model('visitor').findMany.mockResolvedValueOnce([
        { id: VISITOR, first_name: 'Tunde', last_name: 'Bello' },
      ]);

      const result = await service.listContacts(CHURCH, SEC, {
        kind: 'who',
        includeVisitors: true,
      });

      expect(result.total).toBe(2);
      expect(result.data[0].kind).toBe('who');
      expect(result.data[1].role).toBe('visitor');
      expect(result.data[1].isPastor).toBe(false);
      const profileWhere = model('profile').findMany.mock.calls[0][0].where;
      expect(profileWhere.role).toBeUndefined();
      expect(profileWhere.branch_id).toBe(BRANCH_A);
      const visitorWhere = model('visitor').findMany.mock.calls[0][0].where;
      expect(visitorWhere.deleted_at).toBeNull();
    });

    it('lists pastor participants church-wide for an HQ booker', async () => {
      model('profile').findFirst.mockResolvedValueOnce(
        scopeRow({ is_admin_hq: true, branch_id: BRANCH_B, branch: { is_headquarters: true } }),
      );
      model('profile').findMany.mockResolvedValueOnce([pastorRow()]);

      const result = await service.listContacts(CHURCH, SEC, { kind: 'with' });

      expect(result.data[0].isPastor).toBe(true);
      const where = model('profile').findMany.mock.calls[0][0].where;
      expect(where.branch_id).toBeUndefined();
    });
  });
});

describe('Appointment branch read grants and optional edits', () => {
  it.each([
    { is_admin_hq: true, branch_id: BRANCH_A, permissions: ['appointments:branch:read'] },
    { is_admin_hq: false, branch_id: BRANCH_A, permissions: ['appointments:branch:read'] },
    { is_admin_hq: false, branch_id: null, permissions: ['appointments:branch:read'] },
  ])('pins list rows and status counts to the same authorized branch %j', async (viewer) => {
    model('appointment').findMany.mockResolvedValue([]);
    model('appointment').count.mockResolvedValue(0);
    model('appointment').groupBy.mockResolvedValue([]);
    const result = await service.list(
      CHURCH,
      SEC,
      { branchId: BRANCH_B, search: ' Budget ', startDate: '2026-01-01', archived: true },
      viewer,
    );
    const where = model('appointment').findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      church_id: CHURCH,
      branch_id: viewer.is_admin_hq ? BRANCH_B : (viewer.branch_id ?? ''),
      archived_at: { not: null },
      scheduled_at: { gte: new Date('2026-01-01T00:00:00Z') },
    });
    expect(where.scheduled_at).not.toHaveProperty('lte');
    expect(where.AND).toHaveLength(1);
    for (const [args] of model('appointment').count.mock.calls)
      expect(args.where.branch_id).toBe(where.branch_id);
    expect(result.total).toBe(0);
  });
  it('allows a church-wide branch reader to omit branch and use an end-only range', async () => {
    model('appointment').findMany.mockResolvedValue([]);
    model('appointment').count.mockResolvedValue(0);
    model('appointment').groupBy.mockResolvedValue([]);
    await service.list(
      CHURCH,
      SEC,
      { endDate: '2026-01-01' },
      { is_admin_hq: true, permissions: ['appointments:branch:read'] },
    );
    expect(model('appointment').findMany.mock.calls[0][0].where).toEqual({
      church_id: CHURCH,
      archived_at: null,
      scheduled_at: { lte: new Date('2026-01-01T23:59:59.999Z') },
    });
  });
  it('handles a missing viewer branch and historical contact without role or branch', async () => {
    model('profile').findFirst.mockResolvedValue(null);
    model('profile').findMany.mockResolvedValue([
      { ...personRow(), role: [], branch_id: null, branch: null },
    ]);
    const result = await service.listContacts(CHURCH, SEC, { search: '  ', role: 'secretary' });
    expect(model('profile').findMany.mock.calls[0][0].where).toMatchObject({
      church_id: CHURCH,
      branch_id: '',
      role: { has: 'secretary' },
    });
    expect(result.data[0]).toMatchObject({ role: '', branchId: undefined });
  });
});
