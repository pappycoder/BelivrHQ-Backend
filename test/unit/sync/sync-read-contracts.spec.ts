import { SyncService } from '../../../src/sync/sync.service';
import { AuthenticatedRequest } from '../../../src/common/decorators/current-user.decorator';
import { createPrismaMock } from '../../helpers/prisma-mock.helper';

describe('Incremental sync preserves scoped records, dates and resumable cursors', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const church = '22222222-2222-4222-8222-222222222222';
  const branch = '33333333-3333-4333-8333-333333333333';
  const second = '44444444-4444-4444-8444-444444444444';
  const date = new Date('2026-01-02T12:00:00Z');
  const viewer: NonNullable<AuthenticatedRequest['profile']> = {
    id,
    church_id: church,
    branch_id: branch,
    role: 'church_admin',
    member_id: id,
    is_admin_hq: true,
    permissions: [
      'members:all:read',
      'members:all:update',
      'attendance:services:read',
      'giving:categories:read',
      'visitors:list:read',
      'attendance:records:read',
      'giving:records:read',
      'pastoral:life-events:read',
      'sermons:list:read',
      'events:registrations:read',
      'events:checkin:read',
    ],
  };
  const row = {
    id,
    church_id: church,
    branch_id: branch,
    member_id: id,
    event_id: id,
    service_id: id,
    sermon_id: id,
    first_name: 'Ada',
    last_name: 'Obi',
    email: 'synthetic@example.org',
    phone: '55555',
    whatsapp_number: '66666',
    date_of_birth: date,
    gender: 'female',
    address: 'Main',
    city: 'Lagos',
    state: 'Lagos',
    status: 'active',
    member_since: date,
    photo_url: null,
    custom_fields: {},
    notes: 'Synthetic note',
    archived_at: null,
    created_at: date,
    updated_at: date,
    name: 'Synthetic',
    description: 'Description',
    day_of_week: 0,
    start_time: date,
    end_time: date,
    is_active: true,
    display_order: 1,
    is_recurring: true,
    first_visit_date: date,
    follow_up_status: 'new',
    assigned_to_id: id,
    converted_member_id: id,
    converted_at: date,
    visitor_name: null,
    checkin_at: date,
    source: 'manual',
    category_id: id,
    amount: 100,
    currency: 'NGN',
    type: 'cash',
    payment_reference: 'reference',
    payment_gateway: 'manual',
    payment_method: 'cash',
    receipt_number: '2026/SYN/1',
    giving_date: new Date('2025-12-31'),
    date,
    details: {},
    notified: false,
    custom_data: {},
    payment_status: 'paid',
    transaction_id: id,
    ticket_id: id,
    tier_id: id,
    quantity: 2,
    checked_in: true,
    checked_in_at: date,
  };
  const contracts = [
    {
      entity: 'member',
      collection: 'members',
      expected: {
        firstName: 'Ada',
        dateOfBirth: date.toISOString(),
        memberSince: date.toISOString(),
      },
    },
    {
      entity: 'service',
      collection: 'services',
      expected: {
        name: 'Synthetic',
        dayOfWeek: 0,
        startTime: date.toISOString(),
        endTime: date.toISOString(),
      },
    },
    {
      entity: 'givingCategory',
      collection: 'givingCategories',
      expected: { name: 'Synthetic', displayOrder: 1, isRecurring: true },
    },
    {
      entity: 'visitor',
      collection: 'visitors',
      expected: {
        firstName: 'Ada',
        firstVisitDate: date.toISOString(),
        convertedAt: date.toISOString(),
      },
    },
    {
      entity: 'attendance',
      collection: 'attendance',
      expected: { checkinAt: date.toISOString(), serviceId: id, source: 'manual' },
    },
    {
      entity: 'transaction',
      collection: 'transactions',
      expected: {
        amount: 100,
        currency: 'NGN',
        givingDate: '2025-12-31',
        paymentReference: 'reference',
      },
    },
    { entity: 'lifeEvent', expected: { date: date.toISOString(), memberId: id, notified: false } },
    { entity: 'sermonBookmark', expected: { memberId: id, sermonId: id } },
    {
      entity: 'eventRegistration',
      expected: {
        eventId: id,
        paymentStatus: 'paid',
        quantity: 2,
        checkedInAt: date.toISOString(),
      },
    },
  ];
  let prisma: ReturnType<typeof createPrismaMock>, service: SyncService;
  beforeEach(() => {
    prisma = createPrismaMock();
    service = new SyncService(prisma as never, { log: jest.fn() } as never);
    prisma.syncDevice.upsert.mockResolvedValue({ id: 'device-row', last_pull_cursor: null });
    prisma.syncQueue.findMany.mockResolvedValue([]);
    for (const { entity } of contracts) {
      prisma[entity].findFirst.mockResolvedValue(row);
      prisma[entity].findMany.mockResolvedValue([]);
    }
  });
  const queue = (entity: string, action = 'update', data: unknown = {}) => ({
    id,
    entity,
    action,
    data,
    entity_id: id,
    church_id: church,
    created_at: date,
  });
  it.each(contracts)(
    'hydrates $entity changes from authoritative records with API date formats',
    async ({ entity, expected }) => {
      prisma.syncQueue.findMany.mockResolvedValue([queue(entity)]);
      const result = await service.pullChanges(church, 'device', 10, undefined, viewer);
      expect(result.changes).toEqual([
        {
          entity,
          entityId: id,
          action: 'update',
          createdAt: date.toISOString(),
          data: expect.objectContaining({ id, churchId: church, ...expected }),
        },
      ]);
      expect(prisma[entity].findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id, church_id: church }) }),
      );
      expect(prisma.syncDevice.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { church_id_device_id: { church_id: church, device_id: `${id}:device` } },
        }),
      );
    },
  );
  it.each(contracts.filter((contract) => contract.collection))(
    'returns bounded $entity bootstrap pages with an explicit continuation cursor',
    async ({ entity, collection, expected }) => {
      prisma[entity].findMany.mockResolvedValue([row, { ...row, id: second }]);
      const result = await service.bootstrap(church, viewer, 1, entity, second);
      expect((result.collections as Record<string, unknown[]>)[collection!]).toEqual([
        expect.objectContaining(expected),
      ]);
      expect(result.nextCursors![entity]).toBe(id);
      expect(prisma[entity].findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ church_id: church, id: { gt: second } }),
          orderBy: { id: 'asc' },
          take: 2,
        }),
      );
      expect(result.generatedAt).toBe(result.revision);
    },
  );
  it.each([
    { entity: 'member', values: { date_of_birth: null }, expected: { dateOfBirth: null } },
    {
      entity: 'service',
      values: { start_time: null, end_time: null },
      expected: { startTime: null, endTime: null },
    },
    { entity: 'visitor', values: { converted_at: null }, expected: { convertedAt: null } },
    {
      entity: 'eventRegistration',
      values: { checked_in_at: null },
      expected: { checkedInAt: null },
    },
    {
      entity: 'transaction',
      values: { giving_date: undefined },
      expected: { givingDate: '2026-01-02' },
    },
  ])(
    'preserves nullable and historical date semantics for $entity',
    async ({ entity, values, expected }) => {
      prisma[entity].findFirst.mockResolvedValue({ ...row, ...values });
      prisma.syncQueue.findMany.mockResolvedValue([queue(entity)]);
      const result = await service.pullChanges(church, 'device', 10, undefined, viewer);
      expect(result.changes[0].data).toMatchObject(expected);
    },
  );
  it.each(contracts)(
    'does not return $entity updates after its read grant is revoked',
    async ({ entity }) => {
      prisma.syncQueue.findMany.mockResolvedValue([queue(entity)]);
      const result = await service.pullChanges(church, 'device', 10, undefined, {
        ...viewer,
        permissions: [],
      });
      expect(result.changes).toEqual([]);
      expect(prisma[entity].findFirst).not.toHaveBeenCalled();
    },
  );
  it.each([
    { entity: 'attendance', parent: 'service', field: 'service_id' },
    { entity: 'lifeEvent', parent: 'member', field: 'member_id' },
    { entity: 'eventRegistration', parent: 'event', field: 'event_id' },
    { entity: 'sermonBookmark', parent: 'sermon', field: 'sermon_id' },
  ])(
    'checks $entity parent scope before returning a branchless deletion tombstone',
    async ({ entity, parent, field }) => {
      prisma[parent].findFirst.mockResolvedValue({ id });
      prisma.syncQueue.findMany.mockResolvedValue([
        queue(entity, 'delete', { [field]: id, member_id: id }),
      ]);
      const result = await service.pullChanges(church, 'device', 10, undefined, {
        ...viewer,
        is_admin_hq: false,
      });
      expect(result.changes[0]).toMatchObject({ entity, action: 'delete', data: null });
      expect(prisma[parent].findFirst).toHaveBeenCalledWith({
        where: { id, church_id: church, branch_id: branch },
      });
    },
  );
  it.each(['member', 'visitor', 'attendance', 'lifeEvent', 'eventRegistration', 'sermonBookmark'])(
    'drops foreign-branch $entity deletion tombstones',
    async (entity) => {
      prisma.syncQueue.findMany.mockResolvedValue([
        queue(entity, 'delete', { branch_id: 'foreign', member_id: id }),
      ]);
      prisma.member.findFirst.mockResolvedValue(null);
      const result = await service.pullChanges(church, 'device', 10, undefined, {
        ...viewer,
        is_admin_hq: false,
      });
      expect(result.changes).toEqual([]);
    },
  );
  it('never returns another member’s bookmark deletion, even for HQ viewers', async () => {
    prisma.syncQueue.findMany.mockResolvedValue([
      queue('sermonBookmark', 'delete', { member_id: second, branch_id: branch }),
    ]);
    expect((await service.pullChanges(church, 'device', 10, undefined, viewer)).changes).toEqual(
      [],
    );
  });
  it('uses parent branch scope and independent event grants when hydrating attendance', async () => {
    prisma.syncQueue.findMany.mockResolvedValue([queue('attendance')]);
    await service.pullChanges(church, 'device', 10, undefined, {
      ...viewer,
      is_admin_hq: false,
      permissions: ['attendance:records:read'],
    });
    expect(prisma.attendance.findFirst).toHaveBeenCalledWith({
      where: {
        church_id: church,
        id,
        event_id: null,
        OR: [
          { service: { church_id: church, branch_id: branch } },
          { event: { church_id: church, branch_id: branch } },
        ],
      },
    });
  });
  it.each([
    'v2:not-json',
    `v2:${Buffer.from(JSON.stringify({ date: date.toISOString(), id: 'invalid' })).toString('base64url')}`,
    'x'.repeat(301),
  ])('refuses malformed continuation cursors before reading business rows', async (cursor) => {
    await expect(service.pullChanges(church, 'device', 10, cursor, viewer)).rejects.toThrow(
      'Invalid cursor',
    );
    expect(prisma.syncQueue.findMany).not.toHaveBeenCalled();
  });
  it('resumes equal-timestamp pages by queue ID and retains a replay-safe low watermark', async () => {
    const cursor = `v2:${Buffer.from(JSON.stringify({ date: date.toISOString(), id })).toString('base64url')}`;
    prisma.syncQueue.findMany.mockResolvedValue([
      { ...queue('member'), id: second },
      { ...queue('member'), id: '55555555-5555-4555-8555-555555555555' },
    ]);
    const result = await service.pullChanges(church, 'device', 1, cursor, viewer);
    expect(result.hasMore).toBe(true);
    expect(prisma.syncQueue.findMany).toHaveBeenCalledWith({
      where: {
        church_id: church,
        OR: [{ created_at: { gt: date } }, { created_at: date, id: { gt: id } }],
      },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
      take: 2,
    });
    expect(prisma.syncDevice.update).toHaveBeenCalledWith({
      where: { id: 'device-row' },
      data: { last_pull_cursor: new Date(date.getTime() - 1) },
    });
    const decoded = JSON.parse(Buffer.from(result.cursor!.slice(3), 'base64url').toString());
    expect(decoded).toEqual({ date: date.toISOString(), id: second });
  });
  it.each([
    { entity: 'unknown' },
    { cursor: 'invalid' },
    { cursor: id },
    { limit: 0 },
    { limit: 101 },
    { limit: 1.5 },
  ])('rejects invalid bootstrap requests: %j', async ({ entity, cursor, limit }) => {
    await expect(service.bootstrap(church, viewer, limit, entity, cursor)).rejects.toThrow();
    expect(prisma.member.findMany).not.toHaveBeenCalled();
  });
});
