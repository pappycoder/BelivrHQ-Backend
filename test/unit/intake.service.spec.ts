import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { IntakeService } from '../../src/intake/intake.service';
import { intakeFields, validateIntake } from '../../src/intake/intake-fields';
import { IntakeListDto } from '../../src/intake/intake.dto';
import { PrismaService } from '../../src/prisma/prisma.service';
import { MembersService } from '../../src/members/members.service';
import { VisitorsService } from '../../src/visitors/visitors.service';
import { BranchScopeService, ViewerScope } from '../../src/common/services/branch-scope.service';
import { RequestContextService } from '../../src/common/services/request-context.service';
import { AuditLoggingService } from '../../src/common/services/audit-logging.service';
import { createPrismaMock } from '../helpers/prisma-mock.helper';

const churchId = '11111111-1111-4111-8111-111111111111';
const branchId = '22222222-2222-4222-8222-222222222222';
const link = {
  id: 'link',
  church_id: churchId,
  branch_id: branchId,
  kind: 'members',
  token: 'token',
  created_at: new Date(),
};
const viewer: ViewerScope = {
  church_id: churchId,
  branch_id: branchId,
  role: 'secretary',
  permissions: [
    'members:new:create',
    'members:all:read',
    'visitors:new:create',
    'visitors:list:read',
  ],
};
const answers = { firstName: ' Grace ', lastName: 'Adeyemi', email: 'grace@example.test' };
const row = { ...link, id: 'response', link_id: link.id, link, data: answers, status: 'pending' };

describe('public people intake', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let service: IntakeService;
  const audit = { log: jest.fn() };
  const members = { createMember: jest.fn(), afterMemberCreated: jest.fn() };
  const visitors = { create: jest.fn() };
  beforeEach(() => {
    jest.clearAllMocks();
    const models = createPrismaMock();
    const rawQuery = jest.fn().mockResolvedValue([]);
    prisma = new Proxy(models, {
      get: (target, key: string) => (key === '$queryRaw' ? rawQuery : target[key]),
    });
    (prisma.$transaction as unknown as jest.Mock).mockImplementation(
      async (fn: (tx: unknown) => unknown) => fn(prisma),
    );
    prisma.intakeLink.findUnique.mockResolvedValue(link);
    prisma.branch.findFirst.mockResolvedValue({
      id: branchId,
      name: 'Main branch',
      church: { name: 'Grace Church', logo_url: 'https://example.test/logo.png' },
    });
    prisma.customFieldDefinition.findMany.mockResolvedValue([]);
    prisma.platformSubscription.findUnique.mockResolvedValue({
      plan: 'essentials',
      paid_until: new Date(Date.now() + 86400000),
    });
    prisma.intakeSubmission.findFirst.mockResolvedValue(row);
    prisma.intakeSubmission.create.mockResolvedValue({ id: 'response' });
    members.createMember.mockResolvedValue({ memberId: 'new-member', firstName: 'Grace' });
    members.afterMemberCreated.mockResolvedValue(undefined);
    visitors.create.mockResolvedValue({ id: 'new-visitor', firstName: 'Grace' });
    service = new IntakeService(
      prisma as unknown as PrismaService,
      new BranchScopeService(new RequestContextService()),
      audit as unknown as AuditLoggingService,
      members as unknown as MembersService,
      visitors as unknown as VisitorsService,
    );
  });
  it('returns church branding on Essentials and fixes the branch from the link', async () => {
    expect(await service.meta('token')).toMatchObject({
      churchName: 'Grace Church',
      churchLogoUrl: 'https://example.test/logo.png',
      branchName: 'Main branch',
    });
    await service.submit('token', answers);
    expect(prisma.intakeSubmission.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        church_id: churchId,
        branch_id: branchId,
        kind: 'members',
        data: { ...answers, firstName: 'Grace' },
      }),
    });
    expect(members.createMember).not.toHaveBeenCalled();
  });
  it('generates stable links using a unique branch-kind key', async () => {
    prisma.intakeLink.upsert.mockResolvedValue(link);
    await service.link(viewer, 'members', branchId);
    expect(prisma.intakeLink.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          church_id_branch_id_kind: { church_id: churchId, branch_id: branchId, kind: 'members' },
        },
        update: { kind: 'members' },
        create: expect.objectContaining({ token: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      }),
    );
  });
  it('denies other branches and requires create plus read to review', async () => {
    await expect(service.link(viewer, 'members', 'other')).rejects.toThrow(ForbiddenException);
    await expect(
      service.detail({ ...viewer, permissions: ['members:new:create'] }, 'members', 'response'),
    ).rejects.toThrow(ForbiddenException);
    await expect(service.submit('token', { ...answers, branchId: 'other' })).rejects.toThrow(
      BadRequestException,
    );
    await expect(service.submit('token', { ...answers, notes: 'internal' })).rejects.toThrow(
      BadRequestException,
    );
  });
  it.each([null, 'archived'])('hides missing or archived churches/branches (%s)', async () => {
    prisma.branch.findFirst.mockResolvedValue(null);
    await expect(service.submit('token', answers)).rejects.toThrow(NotFoundException);
    expect(prisma.intakeSubmission.create).not.toHaveBeenCalled();
    expect(prisma.branch.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ archived_at: null, church: { archived_at: null } }),
      }),
    );
  });
  it('hides invalid links and inactive subscriptions', async () => {
    prisma.intakeLink.findUnique.mockResolvedValueOnce(null);
    await expect(service.meta('bad')).rejects.toThrow(NotFoundException);
    prisma.platformSubscription.findUnique.mockResolvedValue({
      plan: 'essentials',
      paid_until: new Date(0),
    });
    await expect(service.meta('token')).rejects.toThrow(NotFoundException);
  });
  it('keeps church and branch restrictions on searches and details', async () => {
    prisma.intakeSubmission.findMany.mockResolvedValue([]);
    prisma.intakeSubmission.count.mockResolvedValue(0);
    prisma.branch.findMany.mockResolvedValue([]);
    await service.list(viewer, {
      kind: 'members',
      page: 2,
      limit: 10,
      search: 'Grace',
      branchId: 'other',
    } as IntakeListDto);
    expect(prisma.intakeSubmission.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          church_id: churchId,
          branch_id: branchId,
          kind: 'members',
          status: 'pending',
          search_text: { contains: 'Grace', mode: 'insensitive' },
        },
        skip: 10,
        take: 10,
      }),
    );
    prisma.intakeSubmission.findFirst.mockResolvedValue(null);
    await expect(service.detail(viewer, 'members', 'other-tenant')).rejects.toThrow(
      NotFoundException,
    );
  });
  it('accepts corrections using the transaction and defers member side effects', async () => {
    await expect(
      service.accept(
        viewer,
        'members',
        'response',
        { ...answers, firstName: 'Corrected' },
        'reviewer',
      ),
    ).resolves.toEqual({ destinationId: 'new-member' });
    expect(members.createMember).toHaveBeenCalledWith(
      expect.objectContaining({ firstName: 'Corrected', branchId }),
      churchId,
      'reviewer',
      expect.anything(),
    );
    expect(members.createMember.mock.calls[0][3]).toBe(prisma);
    expect(prisma.intakeSubmission.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'accepted',
          destination_id: 'new-member',
          reviewed_by: 'reviewer',
        }),
      }),
    );
    expect(members.afterMemberCreated).toHaveBeenCalledTimes(1);
  });
  it('uses visitor creation defaults and does not create a member', async () => {
    prisma.intakeSubmission.findFirst.mockResolvedValue({
      ...row,
      kind: 'visitors',
      link: { ...link, kind: 'visitors' },
    });
    await expect(
      service.accept(viewer, 'visitors', 'response', { firstName: 'Guest' }, 'reviewer'),
    ).resolves.toEqual({ destinationId: 'new-visitor' });
    expect(visitors.create).toHaveBeenCalledWith(
      expect.objectContaining({ firstName: 'Guest', branchId }),
      churchId,
      'reviewer',
      viewer,
      expect.anything(),
    );
    expect(visitors.create.mock.calls[0][4]).toBe(prisma);
    expect(members.createMember).not.toHaveBeenCalled();
  });
  it('preserves pending state when creation or validation fails', async () => {
    members.createMember.mockRejectedValueOnce(new ConflictException('Duplicate phone'));
    await expect(
      service.accept(viewer, 'members', 'response', answers, 'reviewer'),
    ).rejects.toThrow('Duplicate phone');
    await expect(
      service.accept(viewer, 'members', 'response', { firstName: 'Only' }, 'reviewer'),
    ).rejects.toThrow('Last name is required');
    expect(prisma.intakeSubmission.update).not.toHaveBeenCalled();
    expect(members.afterMemberCreated).not.toHaveBeenCalled();
  });
  it('cannot accept an already accepted receipt', async () => {
    prisma.intakeSubmission.findFirst.mockResolvedValue({ ...row, status: 'accepted' });
    await expect(
      service.accept(viewer, 'members', 'response', answers, 'reviewer'),
    ).rejects.toThrow(ConflictException);
    expect(members.createMember).not.toHaveBeenCalled();
  });
  it('hard deletes rejected answers without copying them to audit', async () => {
    prisma.intakeSubmission.deleteMany.mockResolvedValue({ count: 1 });
    await service.reject(viewer, 'members', 'response', 'reviewer');
    expect(prisma.intakeSubmission.deleteMany).toHaveBeenCalledWith({
      where: {
        church_id: churchId,
        branch_id: branchId,
        kind: 'members',
        id: 'response',
        status: 'pending',
      },
    });
    expect(audit.log).toHaveBeenCalledWith({
      churchId,
      userId: 'reviewer',
      entity: 'intake_submission',
      action: 'DELETE',
      entityId: 'response',
    });
    expect(prisma.intakeSubmission.update).not.toHaveBeenCalled();
  });
  it('validates all required, optional, date and custom field values', async () => {
    const fields = intakeFields('members', [
      {
        id: 'custom',
        name: 'Ministry',
        field_type: 'dropdown',
        options: ['Music'],
        is_required: true,
      } as never,
    ]);
    expect(() => validateIntake(fields, answers)).toThrow('Ministry is required');
    expect(() => validateIntake(fields, { ...answers, 'custom:custom': 'Other' })).toThrow(
      'Invalid Ministry',
    );
    expect(() =>
      validateIntake(fields, { ...answers, 'custom:custom': 'Music', dateOfBirth: '2026-02-30' }),
    ).toThrow('Invalid Date of birth');
    await expect(service.submit('token', { ...answers, email: 'bad' })).rejects.toThrow(
      BadRequestException,
    );
    expect(validateIntake(fields, { ...answers, 'custom:custom': 'Music' })).toMatchObject({
      firstName: 'Grace',
    });
  });
});
