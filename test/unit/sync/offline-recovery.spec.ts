import { BadRequestException } from '@nestjs/common';
import { OfflineService, offlineHash } from '../../../src/sync/offline.service';
import { OfflineMutationDto } from '../../../src/sync/dto/offline.dto';
import { AuthenticatedRequest } from '../../../src/common/decorators/current-user.decorator';
import { createPrismaMock } from '../../helpers/prisma-mock.helper';

describe('Offline mutations preserve account scope, idempotency and optimistic concurrency', () => {
  const church = '11111111-1111-4111-8111-111111111111';
  const branch = '22222222-2222-4222-8222-222222222222';
  const id = '33333333-3333-4333-8333-333333333333';
  const date = new Date('2026-01-02T12:00:00Z');
  const viewer: NonNullable<AuthenticatedRequest['profile']> = {
    id,
    church_id: church,
    branch_id: branch,
    role: 'secretary',
    is_admin_hq: false,
    permissions: [
      'offline:read',
      'members:all:read',
      'members:new:create',
      'members:all:update',
      'visitors:list:read',
      'visitors:new:create',
      'visitors:list:update',
      'forms:list:read',
    ],
  };
  let prisma: ReturnType<typeof createPrismaMock>;
  let service: OfflineService;
  const forms = { validateSubmissionData: jest.fn() };
  const mutation = (overrides: Partial<OfflineMutationDto> = {}): OfflineMutationDto => ({
    mutationId: id,
    entityId: id,
    branchId: branch,
    entity: 'member',
    action: 'create',
    data: { firstName: 'Ada', lastName: 'Obi' },
    ...overrides,
  });
  beforeEach(() => {
    const delegates = createPrismaMock();
    const executeRaw = jest.fn().mockResolvedValue(undefined);
    prisma = new Proxy(delegates, {
      get: (target, key) => (key === '$executeRaw' ? executeRaw : Reflect.get(target, key)),
    });
    forms.validateSubmissionData.mockReset();
    service = new OfflineService(prisma as never, forms as never);
    (prisma.$transaction as unknown as jest.Mock).mockImplementation(
      (callback: (tx: unknown) => unknown) => callback(prisma),
    );
    prisma.branch.findFirst.mockResolvedValue({ id: branch, name: 'Main' });
    prisma.offlineReceipt.findUnique.mockResolvedValue(null);
    for (const entity of ['member', 'visitor']) {
      prisma[entity].findFirst.mockResolvedValue(null);
      prisma[entity].create.mockResolvedValue({ updated_at: date });
      prisma[entity].updateMany.mockResolvedValue({ count: 1 });
      prisma[entity].findMany.mockResolvedValue([]);
    }
    prisma.form.findMany.mockResolvedValue([]);
    prisma.form.findFirst.mockResolvedValue({
      id,
      fields: [],
      updated_at: date,
      submission_limit: 0,
      unique_field: null,
    });
    prisma.formSubmission.findFirst.mockResolvedValue(null);
    prisma.formSubmission.count.mockResolvedValue(0);
    prisma.formSubmission.create.mockResolvedValue({ created_at: date });
  });
  const push = async (input = mutation()) =>
    (await service.push(viewer, 'verified-user', [input]))[0];
  it('hashes nested arrays consistently without ignoring element ordering', () => {
    expect(offlineHash({ rows: [{ b: 2, a: 1 }, null] })).toBe(
      offlineHash({ rows: [{ a: 1, b: 2 }, null] }),
    );
    expect(offlineHash([1, 2])).not.toBe(offlineHash([2, 1]));
  });
  it.each(['member', 'visitor'] as const)(
    'accepts %s creation and commits an account-bound receipt and audit',
    async (entity) => {
      const input = mutation({
        entity,
        data: { firstName: ' Ada ', lastName: ' Obi ', email: '' },
      });
      await expect(push(input)).resolves.toEqual({
        mutationId: id,
        status: 'accepted',
        version: date.toISOString(),
      });
      expect(prisma[entity].create).toHaveBeenCalledWith({
        data: {
          id,
          church_id: church,
          branch_id: branch,
          first_name: 'Ada',
          last_name: 'Obi',
          email: null,
        },
      });
      expect(prisma.offlineReceipt.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          church_id: church,
          profile_id: id,
          mutation_id: id,
          payload_hash: offlineHash(input),
        }),
      });
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          church_id: church,
          user_id: 'verified-user',
          entity,
          action: 'CREATE',
        }),
      });
    },
  );
  it('returns the original acknowledgement for an exact replay without repeating business work', async () => {
    const input = mutation();
    const ack = { mutationId: id, status: 'accepted', version: date.toISOString() };
    prisma.offlineReceipt.findUnique.mockResolvedValue({
      payload_hash: offlineHash(input),
      result: ack,
    });
    await expect(push(input)).resolves.toEqual(ack);
    expect(prisma.member.create).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    expect(prisma.offlineReceipt.create).not.toHaveBeenCalled();
  });
  it('rejects mutation-ID rebinding rather than applying a different payload', async () => {
    prisma.offlineReceipt.findUnique.mockResolvedValue({ payload_hash: 'different', result: {} });
    await expect(push()).resolves.toMatchObject({
      status: 'rejected',
      message: 'Mutation ID was reused with different content',
    });
    expect(prisma.member.create).not.toHaveBeenCalled();
  });
  it.each(['member', 'visitor', 'submission'] as const)(
    'does not write %s data after its entity grant is revoked',
    async (entity) => {
      const result = await service.push(
        { ...viewer, permissions: ['offline:read'] },
        'verified-user',
        [mutation({ entity, formId: id })],
      );
      expect(result[0]).toMatchObject({
        status: 'rejected',
        message: expect.stringContaining('Missing permission'),
      });
      expect(prisma.offlineReceipt.findUnique).not.toHaveBeenCalled();
    },
  );
  it.each([
    { church_id: '' },
    { permissions: undefined },
    { branch_id: undefined },
    { branch_id: 'foreign' },
  ])('rejects incomplete or foreign branch scope: %j', async (changes) => {
    const result = await service.push({ ...viewer, ...changes } as typeof viewer, 'verified-user', [
      mutation(),
    ]);
    expect(result[0].status).toBe('rejected');
    expect(prisma.member.create).not.toHaveBeenCalled();
  });
  it('rejects archived or missing branches', async () => {
    prisma.branch.findFirst.mockResolvedValue(null);
    await expect(push()).resolves.toMatchObject({
      status: 'rejected',
      message: 'Branch is unavailable',
    });
    expect(prisma.member.create).not.toHaveBeenCalled();
  });
  it.each([
    { firstName: 'Ada', lastName: 'Obi', email: 'invalid' },
    { firstName: 'Ada', lastName: 'Obi', dateOfBirth: '2000-01-01' },
    { firstName: 'Ada', lastName: 'Obi', notes: null },
    { firstName: 'Ada', lastName: 'Obi', notes: 'x'.repeat(5001) },
    { firstName: ' ', lastName: 'Obi' },
    { firstName: 'Ada', lastName: ' ' },
  ])('stores a nonretryable rejection for invalid or unsupported contact data', async (data) => {
    await expect(push(mutation({ data }))).resolves.toMatchObject({ status: 'rejected' });
    expect(prisma.member.create).not.toHaveBeenCalled();
    expect(prisma.offlineReceipt.create).toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
  it('reports conflicting phone ownership without creating a second member', async () => {
    prisma.member.findFirst.mockResolvedValue({ id: 'other-member' });
    await expect(
      push(mutation({ data: { firstName: 'Ada', lastName: 'Obi', phone: '55555' } })),
    ).resolves.toMatchObject({
      status: 'conflict',
      message: 'A member already uses this phone number',
    });
    expect(prisma.member.create).not.toHaveBeenCalled();
  });
  it.each(['member', 'visitor'] as const)(
    'does not overwrite an existing %s on create',
    async (entity) => {
      prisma[entity].findFirst.mockResolvedValue({ id, updated_at: date });
      await expect(push(mutation({ entity }))).resolves.toMatchObject({
        status: 'conflict',
        message: 'Record already exists',
      });
      expect(prisma[entity].create).not.toHaveBeenCalled();
    },
  );
  it.each(['member', 'visitor'] as const)(
    'conditionally updates a %s at its original branch and version',
    async (entity) => {
      prisma[entity].findFirst.mockResolvedValue({ id, updated_at: date });
      const ack = await push(
        mutation({ entity, action: 'update', baseVersion: date.toISOString() }),
      );
      expect(ack.status).toBe('accepted');
      expect(Date.parse(ack.version!)).toBeGreaterThan(date.getTime());
      expect(prisma[entity].updateMany).toHaveBeenCalledWith({
        where: { id, church_id: church, branch_id: branch, archived_at: null, updated_at: date },
        data: { first_name: 'Ada', last_name: 'Obi', updated_at: expect.any(Date) },
      });
    },
  );
  it.each([undefined, '2025-01-01T00:00:00Z'])(
    'rejects edits with missing or stale base versions: %s',
    async (baseVersion) => {
      prisma.member.findFirst.mockResolvedValue({ id, updated_at: date });
      await expect(push(mutation({ action: 'update', baseVersion }))).resolves.toMatchObject({
        status: 'conflict',
        message: expect.stringContaining('changed online'),
      });
      expect(prisma.member.updateMany).not.toHaveBeenCalled();
    },
  );
  it('does not restore records that disappeared from the branch while offline', async () => {
    await expect(
      push(mutation({ action: 'update', baseVersion: date.toISOString() })),
    ).resolves.toMatchObject({
      status: 'conflict',
      message: expect.stringContaining('no longer available'),
    });
    expect(prisma.member.updateMany).not.toHaveBeenCalled();
  });
  it('detects a concurrent edit between its read and conditional update', async () => {
    prisma.member.findFirst.mockResolvedValue({ id, updated_at: date });
    prisma.member.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      push(mutation({ action: 'update', baseVersion: date.toISOString() })),
    ).resolves.toMatchObject({ status: 'conflict' });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
  it('keeps infrastructure errors retryable and does not return database diagnostics', async () => {
    prisma.member.create.mockRejectedValue(new Error('synthetic-private-database-detail'));
    await expect(push()).resolves.toMatchObject({
      status: 'retry',
      message: 'Unable to sync now. Try again.',
    });
    expect(prisma.offlineReceipt.create).not.toHaveBeenCalled();
  });

  const submission = () =>
    mutation({
      entity: 'submission',
      formId: id,
      baseVersion: date.toISOString(),
      data: { answer: 'Yes' },
    });
  it('commits a current form submission with its verified submitter identity', async () => {
    await expect(push(submission())).resolves.toEqual({
      mutationId: id,
      status: 'accepted',
      version: date.toISOString(),
    });
    expect(forms.validateSubmissionData).toHaveBeenCalledWith([], { answer: 'Yes' });
    expect(prisma.formSubmission.create).toHaveBeenCalledWith({
      data: {
        id,
        church_id: church,
        form_id: id,
        data: { answer: 'Yes' },
        submitted_by: 'verified-user',
      },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ entity: 'form_submission', user_id: 'verified-user' }),
    });
  });
  it.each([{ action: 'update' as const }, { formId: undefined }])(
    'rejects unsupported offline form operations: %j',
    async (change) => {
      await expect(push({ ...submission(), ...change })).resolves.toMatchObject({
        status: 'rejected',
        message: 'Only new form submissions can be synced',
      });
      expect(prisma.formSubmission.create).not.toHaveBeenCalled();
    },
  );
  it.each([null, { id, fields: [], updated_at: new Date('2026-02-01') }])(
    'rejects unavailable or changed forms: %j',
    async (form) => {
      prisma.form.findFirst.mockResolvedValue(form);
      await expect(push(submission())).resolves.toMatchObject({ status: 'conflict' });
      expect(prisma.formSubmission.create).not.toHaveBeenCalled();
    },
  );
  it('rejects invalid submission fields without writing or auditing', async () => {
    forms.validateSubmissionData.mockImplementation(() => {
      throw new BadRequestException('Invalid form answer');
    });
    await expect(push(submission())).resolves.toMatchObject({
      status: 'rejected',
      message: 'Invalid form answer',
    });
    expect(prisma.formSubmission.create).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
  it('prevents a second form submission by the same user', async () => {
    prisma.formSubmission.findFirst.mockResolvedValue({ id: 'previous' });
    await expect(push(submission())).resolves.toMatchObject({
      status: 'conflict',
      message: 'You have already submitted this form',
    });
  });
  it('enforces form submission limits', async () => {
    prisma.form.findFirst.mockResolvedValue({
      id,
      fields: [],
      updated_at: date,
      submission_limit: 2,
      unique_field: null,
    });
    prisma.formSubmission.count.mockResolvedValue(2);
    await expect(push(submission())).resolves.toMatchObject({
      status: 'conflict',
      message: 'The submission limit was reached',
    });
    expect(prisma.formSubmission.create).not.toHaveBeenCalled();
  });
  it.each([null, { id: 'existing-answer' }])(
    'enforces configured unique form fields: %j',
    async (duplicate) => {
      prisma.form.findFirst.mockResolvedValue({
        id,
        fields: [],
        updated_at: date,
        submission_limit: 2,
        unique_field: 'answer',
      });
      prisma.formSubmission.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(duplicate);
      expect((await push(submission())).status).toBe(duplicate ? 'conflict' : 'accepted');
      expect(prisma.formSubmission.findFirst).toHaveBeenLastCalledWith({
        where: { church_id: church, form_id: id, data: { path: ['answer'], equals: 'Yes' } },
      });
    },
  );

  it('returns only authorized snapshot collections and a bounded seven-day lease', async () => {
    prisma.member.findMany.mockResolvedValue([{ id: 'member' }]);
    prisma.visitor.findMany.mockResolvedValue([{ id: 'visitor' }]);
    prisma.form.findMany.mockResolvedValue([{ id: 'form' }]);
    const before = Date.now();
    const snapshot = await service.snapshot(viewer, branch);
    expect(snapshot).toMatchObject({
      churchId: church,
      profileId: id,
      branchId: branch,
      branchName: 'Main',
      records: { member: [{ id: 'member' }], visitor: [{ id: 'visitor' }], form: [{ id: 'form' }] },
    });
    expect(Date.parse(snapshot.expiresAt)).toBeGreaterThanOrEqual(before + 7 * 86400000);
    expect(Date.parse(snapshot.expiresAt)).toBeLessThanOrEqual(Date.now() + 7 * 86400000);
    expect(prisma.member.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { church_id: church, branch_id: branch, archived_at: null },
        take: 2001,
      }),
    );
    expect(prisma.visitor.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { church_id: church, branch_id: branch, archived_at: null, deleted_at: null },
        take: 2001,
      }),
    );
    expect(prisma.form.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          church_id: church,
          branch_id: branch,
          archived_at: null,
          status: 'published',
          is_template: false,
        },
        take: 501,
      }),
    );
  });
  it('does not query collections when their read grants are absent', async () => {
    const snapshot = await service.snapshot({ ...viewer, permissions: ['offline:read'] }, branch);
    expect(snapshot.records).toEqual({ member: [], visitor: [], form: [] });
    for (const entity of ['member', 'visitor', 'form'])
      expect(prisma[entity].findMany).not.toHaveBeenCalled();
  });
  it.each([
    { entity: 'member', count: 2001 },
    { entity: 'visitor', count: 2001 },
    { entity: 'form', count: 501 },
  ])(
    'refuses incomplete oversized $entity snapshots instead of silently truncating',
    async ({ entity, count }) => {
      prisma[entity].findMany.mockResolvedValue(Array.from({ length: count }, () => ({ id })));
      await expect(service.snapshot(viewer, branch)).rejects.toThrow(
        'exceeds the offline workspace limit',
      );
    },
  );
  it('caps snapshot validity at subscription expiry and strips write grants in read-only mode', async () => {
    const deadline = new Date(Date.now() + 3600000).toISOString();
    const snapshot = await service.snapshot(
      { ...viewer, subscriptionReadOnly: true, subscriptionPaidUntil: deadline },
      branch,
    );
    expect(snapshot.expiresAt).toBe(deadline);
    expect(snapshot.permissions).toContain('members:all:read');
    expect(snapshot.permissions).not.toContain('members:new:create');
    expect(snapshot.permissions).not.toContain('members:all:update');
  });
  it('validates the requested branch even for HQ snapshot readers', async () => {
    prisma.branch.findFirst.mockResolvedValue(null);
    await expect(
      service.snapshot({ ...viewer, is_admin_hq: true }, 'foreign-branch'),
    ).rejects.toThrow('Branch is unavailable');
    expect(prisma.branch.findFirst).toHaveBeenCalledWith({
      where: { id: 'foreign-branch', church_id: church, archived_at: null },
      select: { id: true, name: true },
    });
  });
});
