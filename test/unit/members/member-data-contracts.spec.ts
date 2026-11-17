import { Workbook } from 'exceljs';
import { MembersService } from '../../../src/members/members.service';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { RequestContextService } from '../../../src/common/services/request-context.service';
import { BranchScopeService } from '../../../src/common/services/branch-scope.service';
import { CreateMemberDto } from '../../../src/members/dto/create-member.dto';
import { createPrismaMock } from '../../helpers/prisma-mock.helper';

describe('Member import, export and history contracts', () => {
  const church = '11111111-1111-4111-8111-111111111111';
  const branch = '22222222-2222-4222-8222-222222222222';
  const member = '33333333-3333-4333-8333-333333333333';
  const actor = 'actor';
  const date = new Date('2026-01-02T12:00:00Z');
  const record = {
    id: member,
    church_id: church,
    branch_id: branch,
    first_name: 'Ada',
    last_name: 'Obi',
    email: 'ada@example.org',
    phone: '+2348000000000',
    whatsapp_number: '+2348111111111',
    date_of_birth: new Date('2000-06-01'),
    gender: 'female',
    address: '1 Main Street',
    city: 'Lagos',
    state: 'Lagos',
    status: 'active',
    notes: 'Private pastoral note',
    member_since: date,
    created_at: date,
    updated_at: date,
    photo_url: null,
    archived_at: null,
    custom_fields: {},
  };
  let prisma: ReturnType<typeof createPrismaMock>;
  let service: MembersService;
  let context: RequestContextService;
  const audit = { log: jest.fn() };
  beforeEach(() => {
    prisma = createPrismaMock();
    context = new RequestContextService();
    audit.log.mockReset().mockResolvedValue(undefined);
    prisma.member.findMany.mockResolvedValue([record]);
    prisma.member.findUnique.mockResolvedValue(record);
    prisma.member.findFirst.mockResolvedValue(null);
    prisma.member.create.mockResolvedValue(record);
    prisma.member.update.mockResolvedValue(record);
    prisma.branch.findMany.mockResolvedValue([{ id: branch }]);
    service = new MembersService(
      prisma as unknown as PrismaService,
      context,
      audit as never,
      { broadcastToChurch: jest.fn().mockResolvedValue({}) } as never,
      new BranchScopeService(context),
    );
  });

  it.each([undefined, [], Array.from({ length: 101 }, () => ({}))])(
    'rejects invalid import batch sizes before any writes',
    async (batch) => {
      await expect(
        service.bulkImportMembers(batch as CreateMemberDto[], church, actor),
      ).rejects.toThrow('between 1 and 100');
      expect(prisma.member.create).not.toHaveBeenCalled();
    },
  );
  it('rejects nonboolean dry-run flags rather than accidentally writing', async () => {
    await expect(
      service.bulkImportMembers(
        [{ firstName: 'Ada', lastName: 'Obi' }],
        church,
        actor,
        'false' as never,
      ),
    ).rejects.toThrow('dryRun must be a boolean');
    expect(prisma.member.create).not.toHaveBeenCalled();
  });
  it.each([
    [{ firstName: '', lastName: 'Obi' }, 'firstName'],
    [{ firstName: 'Ada', lastName: 'Obi', email: 'invalid' }, 'email'],
    [{ firstName: 'Ada', lastName: 'Obi', injected: true }, 'injected'],
    [
      { firstName: 'Ada', lastName: 'Obi', branchId: '44444444-4444-4444-8444-444444444444' },
      'Branch does not belong',
    ],
    [{ firstName: 'Ada', lastName: 'Obi', dateOfBirth: 'invalid-date' }, 'Invalid date'],
  ])('reports invalid import rows without writing: %j', async (input, message) => {
    const result = await service.bulkImportMembers([input as CreateMemberDto], church, actor);
    expect(result.created).toBe(0);
    expect(result.errors).toEqual([{ row: 1, message: expect.stringContaining(message) }]);
    expect(prisma.member.create).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });
  it.each(['phone', 'email'] as const)(
    'rejects duplicate %s within the same church',
    async (key) => {
      const value = key === 'phone' ? '123456789' : 'duplicate@example.org';
      prisma.member.findFirst.mockResolvedValue({ id: 'existing' });
      const result = await service.bulkImportMembers(
        [{ firstName: 'Ada', lastName: 'Obi', [key]: value }],
        church,
        actor,
      );
      expect(result.errors).toEqual([
        { row: 1, message: expect.stringContaining('already exists') },
      ]);
      expect(prisma.member.findFirst).toHaveBeenCalledWith({
        where: { church_id: church, [key]: value },
      });
      expect(prisma.member.create).not.toHaveBeenCalled();
    },
  );
  it('validates dry-run rows and never persists or audits them', async () => {
    const result = await service.bulkImportMembers(
      [{ firstName: 'Ada', lastName: 'Obi', branchId: branch }],
      church,
      actor,
      true,
    );
    expect(result).toEqual({ created: 1, errors: [], dryRun: true });
    expect(prisma.member.create).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });
  it('imports full and minimal records, preserving dates and null defaults with an audit', async () => {
    const full = {
      firstName: 'Ada',
      lastName: 'Obi',
      branchId: branch,
      email: record.email,
      phone: record.phone,
      whatsappNumber: record.whatsapp_number,
      dateOfBirth: '2000-06-01',
      gender: 'female',
      address: '1 Main Street',
      city: 'Lagos',
      state: 'Lagos',
      customFields: { occupation: 'Engineer' },
      notes: 'Private note',
    };
    const result = await service.bulkImportMembers(
      [full, { firstName: 'Ben', lastName: 'Obi' }],
      church,
      actor,
    );
    expect(result).toEqual({ created: 2, errors: [], dryRun: false });
    expect(prisma.member.create).toHaveBeenNthCalledWith(1, {
      data: {
        church_id: church,
        branch_id: branch,
        first_name: 'Ada',
        last_name: 'Obi',
        email: record.email,
        phone: record.phone,
        whatsapp_number: record.whatsapp_number,
        date_of_birth: new Date('2000-06-01'),
        gender: 'female',
        address: '1 Main Street',
        city: 'Lagos',
        state: 'Lagos',
        custom_fields: { occupation: 'Engineer' },
        notes: 'Private note',
      },
    });
    expect(prisma.member.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        first_name: 'Ben',
        email: null,
        phone: null,
        branch_id: null,
        date_of_birth: null,
      }),
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        churchId: church,
        userId: actor,
        newValues: { importedCount: 2, errorCount: 0 },
      }),
    );
  });
  it.each([new Error('write unavailable'), 'non-error failure'])(
    'reports per-row write failures and continues the batch',
    async (failure) => {
      prisma.member.create.mockRejectedValueOnce(failure);
      const result = await service.bulkImportMembers(
        [
          { firstName: 'Ada', lastName: 'Obi' },
          { firstName: 'Ben', lastName: 'Obi' },
        ],
        church,
        actor,
      );
      expect(result.created).toBe(1);
      expect(result.errors).toEqual([
        { row: 1, message: failure instanceof Error ? failure.message : 'Unknown error' },
      ]);
      expect(prisma.member.create).toHaveBeenCalledTimes(2);
    },
  );

  it.each(
    [[], ['unrelated:read'], ['members:update'], ['members:delete']].map((permissions) => ({
      permissions,
    })),
  )(
    'redacts CSV personal data unless a sensitive grant is present: %j',
    async ({ permissions }) => {
      const csv = await service.exportMembersCsv(church, undefined, undefined, permissions);
      const allowed =
        permissions.includes('members:update') || permissions.includes('members:delete');
      for (const value of [
        record.email,
        record.phone,
        record.whatsapp_number,
        record.notes,
        record.address,
      ]) {
        expect(csv.includes(value)).toBe(allowed);
      }
      expect(csv).toContain('Ada,Obi');
      expect(csv).toContain('2026-01-02');
    },
  );
  it('escapes CSV formulas, commas, quotes and line breaks', async () => {
    prisma.member.findMany.mockResolvedValue([
      {
        ...record,
        first_name: '=HYPERLINK("bad")',
        last_name: 'Obi, Jr',
        notes: 'Line 1\nLine "2"',
      },
    ]);
    const csv = await service.exportMembersCsv(church, undefined, undefined, ['members:update']);
    expect(csv).toContain('"\'=HYPERLINK(""bad"")"');
    expect(csv).toContain('"Obi, Jr"');
    expect(csv).toContain('"Line 1\nLine ""2"""');
  });
  it.each([false, true])(
    'serializes a real XLSX while respecting sensitive access=%s',
    async (allowed) => {
      const data = await service.exportMembersXlsx(
        church,
        undefined,
        undefined,
        allowed ? ['members:update'] : [],
      );
      const workbook = new Workbook();
      await workbook.xlsx.load(data as never);
      const sheet = workbook.getWorksheet('Members')!;
      expect(sheet.getCell('B7').value).toBe('Ada');
      expect(sheet.getCell('D7').value).toBe(allowed ? record.email : '');
      expect(sheet.getCell('N7').value).toBe(allowed ? record.notes : '');
      expect(sheet.getCell('A2').text).toContain('All branches');
      expect(workbook.creator).toBe('BelivrHQ');
    },
  );
  it.each(['csv', 'xlsx'] as const)(
    'pins %s exports to the viewer branch despite a foreign requested branch',
    async (format) => {
      const viewer = {
        church_id: church,
        role: 'secretary',
        branch_id: branch,
        is_admin_hq: false,
      };
      if (format === 'csv') await service.exportMembersCsv(church, 'active', 'foreign', [], viewer);
      else await service.exportMembersXlsx(church, 'active', 'foreign', [], viewer);
      expect(prisma.member.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { church_id: church, branch_id: branch, status: 'active' },
        }),
      );
    },
  );
  it.each(['csv', 'xlsx'] as const)(
    'allows HQ selection and null personal fields in %s exports',
    async (format) => {
      prisma.member.findMany.mockResolvedValue([
        {
          ...record,
          email: null,
          phone: null,
          whatsapp_number: null,
          date_of_birth: null,
          gender: null,
          address: null,
          city: null,
          state: null,
          notes: null,
        },
      ]);
      const viewer = { church_id: church, role: 'church_admin', is_admin_hq: true };
      if (format === 'csv')
        expect(
          await service.exportMembersCsv(church, 'inactive', branch, ['members:delete'], viewer),
        ).not.toContain('null');
      else {
        const workbook = new Workbook();
        await workbook.xlsx.load(
          (await service.exportMembersXlsx(
            church,
            'inactive',
            branch,
            ['members:delete'],
            viewer,
          )) as never,
        );
        expect(workbook.getWorksheet('Members')!.getCell('D7').value).toBe('');
      }
      expect(prisma.member.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { church_id: church, branch_id: branch, status: 'inactive' },
        }),
      );
    },
  );

  it.each(['qr', 'giving', 'attendance', 'note', 'restore'] as const)(
    'hides missing or foreign members in %s operations',
    async (operation) => {
      for (const found of [null, { ...record, church_id: 'foreign' }]) {
        prisma.member.findUnique.mockResolvedValue(found);
        const action =
          operation === 'qr'
            ? service.generateMemberQRCode(member, church)
            : operation === 'giving'
              ? service.getMemberGivingHistory(member, church)
              : operation === 'attendance'
                ? service.getMemberAttendanceHistory(member, church)
                : operation === 'note'
                  ? service.addMemberNote(member, 'note', church, actor)
                  : service.restoreMember(member, church, actor);
        await expect(action).rejects.toThrow('Member not found');
      }
      expect(prisma.member.update).not.toHaveBeenCalled();
    },
  );
  it('returns a stable QR payload for an authorized member', async () => {
    await expect(service.generateMemberQRCode(member, church)).resolves.toEqual({
      memberId: member,
      qrData: `BELIVRHQ:MEMBER:${member}`,
    });
  });
  it('preserves business giving dates and falls back for legacy records', async () => {
    prisma.transaction.findMany.mockResolvedValue([
      {
        id: 'one',
        amount: 100,
        currency: 'NGN',
        category_id: 'tithe',
        status: 'success',
        giving_date: new Date('2025-12-31'),
        created_at: date,
      },
      {
        id: 'two',
        amount: 200,
        currency: 'NGN',
        category_id: null,
        status: 'success',
        giving_date: null,
        created_at: date,
      },
    ]);
    await expect(service.getMemberGivingHistory(member, church)).resolves.toEqual([
      {
        id: 'one',
        amount: 100,
        currency: 'NGN',
        categoryId: 'tithe',
        status: 'success',
        givingDate: '2025-12-31',
        createdAt: date.toISOString(),
      },
      {
        id: 'two',
        amount: 200,
        currency: 'NGN',
        categoryId: '',
        status: 'success',
        givingDate: '2026-01-02',
        createdAt: date.toISOString(),
      },
    ]);
  });
  it.each([undefined, [], ['events:checkin:read']].map((permissions) => ({ permissions })))(
    'applies independent event-history permission: %j',
    async ({ permissions }) => {
      prisma.attendance.findMany.mockResolvedValue([
        {
          id: 'one',
          checkin_at: date,
          created_at: date,
          source: 'manual',
          service: { name: 'Sunday' },
        },
        { id: 'two', checkin_at: date, created_at: date, source: 'qr', service: null },
      ]);
      const history = await service.getMemberAttendanceHistory(
        member,
        church,
        permissions ? { church_id: church, role: 'secretary', permissions } : undefined,
      );
      expect(history.map((row) => row.serviceName)).toEqual(['Sunday', 'Unknown Service']);
      expect(prisma.attendance.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            member_id: member,
            church_id: church,
            ...(permissions && !permissions.includes('events:checkin:read')
              ? { event_id: null }
              : {}),
          },
        }),
      );
    },
  );
  it.each([null, 'Existing note'])(
    'appends timestamped notes without losing history: %s',
    async (notes) => {
      prisma.member.findUnique.mockResolvedValue({ ...record, notes });
      await expect(service.addMemberNote(member, 'New note', church, actor)).resolves.toEqual({
        success: true,
      });
      const saved = prisma.member.update.mock.calls[0][0].data.notes as string;
      expect(saved).toMatch(/\[\d{4}-\d\d-\d\dT.*Z\] New note$/);
      expect(saved.startsWith(notes ? `${notes}\n[` : '[')).toBe(true);
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: actor,
          churchId: church,
          entityId: member,
          newValues: { action: 'note_added', note: 'New note' },
        }),
      );
    },
  );
  it('does not append a note to an archived member', async () => {
    prisma.member.findUnique.mockResolvedValue({ ...record, archived_at: date });
    await expect(service.addMemberNote(member, 'note', church, actor)).rejects.toThrow(
      'Member not found',
    );
    expect(prisma.member.update).not.toHaveBeenCalled();
  });
  it.each(['active', 'inactive'])(
    'restores inactive members without rewriting active ones: %s',
    async (status) => {
      prisma.member.findUnique.mockResolvedValue({ ...record, status });
      const result = await service.restoreMember(member, church, actor);
      expect(result.status).toBe('active');
      expect(prisma.member.update).toHaveBeenCalledTimes(status === 'inactive' ? 1 : 0);
      expect(audit.log).toHaveBeenCalledTimes(status === 'inactive' ? 1 : 0);
    },
  );

  it('updates all supplied member fields without losing their mapped values', async () => {
    const dto = {
      firstName: 'New',
      lastName: 'Name',
      email: 'new@example.org',
      phone: '5555',
      whatsappNumber: '6666',
      dateOfBirth: '2001-01-02',
      gender: 'male',
      address: '2 Main',
      city: 'Abuja',
      state: 'FCT',
      status: 'inactive' as const,
      branchId: branch,
      photoUrl: 'https://example.org/photo',
      customFields: { occupation: 'Doctor' },
      notes: 'Updated',
    };
    await service.updateMember(member, dto, church, actor);
    expect(prisma.member.update).toHaveBeenCalledWith({
      where: { id: member },
      data: {
        first_name: 'New',
        last_name: 'Name',
        email: 'new@example.org',
        phone: '5555',
        whatsapp_number: '6666',
        date_of_birth: new Date('2001-01-02'),
        gender: 'male',
        address: '2 Main',
        city: 'Abuja',
        state: 'FCT',
        status: 'inactive',
        branch: { connect: { id: branch } },
        photo_url: 'https://example.org/photo',
        custom_fields: { occupation: 'Doctor' },
        notes: 'Updated',
      },
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: member, userId: actor, churchId: church }),
    );
  });

  it('clears nullable member fields explicitly and leaves omitted names untouched', async () => {
    await service.updateMember(
      member,
      {
        email: '',
        phone: '',
        whatsappNumber: '',
        dateOfBirth: '',
        gender: '',
        address: '',
        city: '',
        state: '',
        photoUrl: '',
        notes: '',
        customFields: null as never,
      },
      church,
      actor,
    );
    const data = prisma.member.update.mock.calls[0][0].data;
    expect(data).toMatchObject({
      email: null,
      phone: null,
      whatsapp_number: null,
      date_of_birth: null,
      gender: null,
      address: null,
      city: null,
      state: null,
      photo_url: null,
      notes: null,
    });
    expect(data).not.toHaveProperty('first_name');
    expect(data).not.toHaveProperty('last_name');
  });

  it.each(['qr', 'giving', 'attendance', 'note', 'restore'] as const)(
    'denies another branch before %s operations expose or alter member data',
    async (operation) => {
      const viewer = {
        church_id: church,
        role: 'secretary',
        branch_id: 'other-branch',
        is_admin_hq: false,
      };
      await expect(
        context.run<unknown>({ churchId: church, userId: actor, role: 'secretary', viewer }, () => {
          if (operation === 'qr') return service.generateMemberQRCode(member, church);
          if (operation === 'giving') return service.getMemberGivingHistory(member, church);
          if (operation === 'attendance') return service.getMemberAttendanceHistory(member, church);
          if (operation === 'note') return service.addMemberNote(member, 'note', church, actor);
          return service.restoreMember(member, church, actor);
        }),
      ).rejects.toThrow('Member not found');
      expect(prisma.member.update).not.toHaveBeenCalled();
      expect(prisma.transaction.findMany).not.toHaveBeenCalled();
      expect(prisma.attendance.findMany).not.toHaveBeenCalled();
    },
  );
});
