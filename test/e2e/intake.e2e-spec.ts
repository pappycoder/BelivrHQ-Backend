import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { PrismaService } from '../../src/prisma/prisma.service';
import { IntakeService } from '../../src/intake/intake.service';
import { BranchScopeService, ViewerScope } from '../../src/common/services/branch-scope.service';
import { RequestContextService } from '../../src/common/services/request-context.service';
import { AuditLoggingService } from '../../src/common/services/audit-logging.service';
import { MembersService } from '../../src/members/members.service';
import { VisitorsService } from '../../src/visitors/visitors.service';
import { NotificationsService } from '../../src/notifications/notifications.service';

// test/e2e-env.ts permits only a disposable localhost database.
describe('Intake atomic review and migration (PostgreSQL)', () => {
  const churchId = randomUUID(),
    branchId = randomUUID(),
    otherBranch = randomUUID(),
    otherChurch = randomUUID();
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
  const prisma = new PrismaService();
  const context = new RequestContextService();
  const scope = new BranchScopeService(context);
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const members = new MembersService(
    prisma,
    context,
    audit as unknown as AuditLoggingService,
    { createNotification: jest.fn() } as unknown as NotificationsService,
    scope,
  );
  const visitors = new VisitorsService(prisma, audit as unknown as AuditLoggingService, context);
  const service = new IntakeService(
    prisma,
    scope,
    audit as unknown as AuditLoggingService,
    members,
    visitors,
  );
  let memberToken: string, visitorToken: string;
  const data = { firstName: 'Grace', lastName: 'Adeyemi' };
  beforeAll(async () => {
    await prisma.$connect();
    await prisma.church.createMany({
      data: [
        { id: churchId, name: 'Intake test church' },
        { id: otherChurch, name: 'Other test church' },
      ],
    });
    await prisma.platformSubscription.create({
      data: {
        church_id: churchId,
        plan: 'network',
        cycle: 'monthly',
        paid_until: new Date(Date.now() + 86400000),
      },
    });
    await prisma.branch.createMany({
      data: [
        { id: branchId, church_id: churchId, name: 'Main branch' },
        { id: otherBranch, church_id: churchId, name: 'Other branch' },
      ],
    });

    await prisma.platformSubscription.update({
      where: { church_id: churchId },
      data: { plan: 'essentials' },
    });
    memberToken = (await service.link(viewer, 'members', branchId)).token;
    visitorToken = (await service.link(viewer, 'visitors', branchId)).token;
  });
  afterAll(async () => {
    await prisma.intakeLink.deleteMany({ where: { church_id: churchId } });
    await prisma.visitor.deleteMany({ where: { church_id: churchId } });
    await prisma.member.deleteMany({ where: { church_id: churchId } });
    await prisma.customFieldDefinition.deleteMany({ where: { church_id: churchId } });
    await prisma.branch.deleteMany({ where: { church_id: churchId } });
    await prisma.auditLog.deleteMany({ where: { church_id: { in: [churchId, otherChurch] } } });
    await prisma.church.deleteMany({ where: { id: { in: [churchId, otherChurch] } } });
    await prisma.$disconnect();
  });
  it('reuses the link across simultaneous requests', async () => {
    const links = await Promise.all([
      service.link(viewer, 'members', branchId),
      service.link(viewer, 'members', branchId),
    ]);
    expect(links.map((l) => l.token)).toEqual([memberToken, memberToken]);
    expect(visitorToken).not.toBe(memberToken);
    const fresh = await Promise.all([
      service.link({ ...viewer, is_admin_hq: true }, 'members', otherBranch),
      service.link({ ...viewer, is_admin_hq: true }, 'members', otherBranch),
    ]);
    expect(fresh[0].token).toBe(fresh[1].token);
  });
  it('creates exactly one member for simultaneous acceptance of one registration', async () => {
    const submitted = await service.submit(memberToken, { ...data, phone: 'concurrent-one' });
    const results = await Promise.allSettled([
      service.accept(
        viewer,
        'members',
        submitted.id,
        { ...data, phone: 'concurrent-one' },
        'reviewer',
      ),
      service.accept(
        viewer,
        'members',
        submitted.id,
        { ...data, phone: 'concurrent-one' },
        'reviewer',
      ),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      await prisma.member.count({ where: { church_id: churchId, phone: 'concurrent-one' } }),
    ).toBe(1);
    expect(await prisma.intakeSubmission.findUnique({ where: { id: submitted.id } })).toMatchObject(
      { status: 'accepted', reviewed_by: 'reviewer', destination_id: expect.any(String) },
    );
  });
  it('retains a pending response on a duplicate and accepts corrected details', async () => {
    const submitted = await service.submit(memberToken, { ...data, phone: 'concurrent-one' });
    await expect(
      service.accept(
        viewer,
        'members',
        submitted.id,
        { ...data, phone: 'concurrent-one' },
        'reviewer',
      ),
    ).rejects.toThrow('already exists');
    expect(await prisma.intakeSubmission.findUnique({ where: { id: submitted.id } })).toMatchObject(
      { status: 'pending' },
    );
    const result = await service.accept(
      viewer,
      'members',
      submitted.id,
      { ...data, phone: 'corrected-number' },
      'reviewer',
    );
    expect(await prisma.member.findUnique({ where: { id: result.destinationId } })).toMatchObject({
      phone: 'corrected-number',
      branch_id: branchId,
    });
  });
  it('rolls destination creation back if resolving the submission fails', async () => {
    const submitted = await service.submit(memberToken, data);
    // A PostgreSQL CHECK failure occurs after member.create, inside the same transaction.
    await prisma.$executeRawUnsafe(
      `ALTER TABLE intake_submissions ADD CONSTRAINT intake_test_failure CHECK (id <> '${submitted.id}' OR status <> 'accepted')`,
    );
    try {
      const before = await prisma.member.count({ where: { church_id: churchId } });
      await expect(
        service.accept(viewer, 'members', submitted.id, data, 'reviewer'),
      ).rejects.toThrow();
      expect(await prisma.member.count({ where: { church_id: churchId } })).toBe(before);
      expect(
        await prisma.intakeSubmission.findUnique({ where: { id: submitted.id } }),
      ).toMatchObject({ status: 'pending' });
    } finally {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE intake_submissions DROP CONSTRAINT intake_test_failure',
      );
    }
    await service.reject(viewer, 'members', submitted.id, 'reviewer');
  });
  it('creates visitor defaults and permanently removes rejected data', async () => {
    const submitted = await service.submit(visitorToken, { firstName: 'Visitor' });
    const accepted = await service.accept(
      { ...viewer, is_admin_hq: true },
      'visitors',
      submitted.id,
      { firstName: 'Corrected guest' },
      'reviewer',
    );
    expect(
      await prisma.visitor.findUnique({ where: { id: accepted.destinationId } }),
    ).toMatchObject({
      first_name: 'Corrected guest',
      follow_up_status: 'new',
      branch_id: branchId,
    });
    const rejected = await service.submit(visitorToken, { firstName: 'Sensitive rejected answer' });
    await service.reject(viewer, 'visitors', rejected.id, 'reviewer');
    expect(await prisma.intakeSubmission.findUnique({ where: { id: rejected.id } })).toBeNull();
    expect(audit.log).toHaveBeenLastCalledWith({
      userId: 'reviewer',
      churchId,
      entity: 'intake_submission',
      action: 'DELETE',
      entityId: rejected.id,
    });
  });
  it('does not leak another tenant or branch and blocks archived branch submissions', async () => {
    const submitted = await service.submit(memberToken, data);
    await expect(
      service.detail({ ...viewer, church_id: otherChurch }, 'members', submitted.id),
    ).rejects.toThrow('not found');
    await expect(
      service.detail({ ...viewer, branch_id: otherBranch }, 'members', submitted.id),
    ).rejects.toThrow('not found');
    await expect(
      service.reject({ ...viewer, branch_id: otherBranch }, 'members', submitted.id, 'reviewer'),
    ).rejects.toThrow('not found');
    await prisma.platformSubscription.update({
      where: { church_id: churchId },
      data: { plan: 'network' },
    });
    await prisma.branch.update({ where: { id: branchId }, data: { archived_at: new Date() } });
    try {
      await expect(service.submit(memberToken, data)).rejects.toThrow('unavailable');
    } finally {
      await prisma.branch.update({ where: { id: branchId }, data: { archived_at: null } });
    }
    await service.reject(viewer, 'members', submitted.id, 'reviewer');
  });
  it('serializes acceptance against permanent rejection', async () => {
    const submitted = await service.submit(visitorToken, { firstName: 'Race guest' });
    const results = await Promise.allSettled([
      service.accept(viewer, 'visitors', submitted.id, { firstName: 'Race guest' }, 'reviewer'),
      service.reject(viewer, 'visitors', submitted.id, 'reviewer'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const receipt = await prisma.intakeSubmission.findUnique({ where: { id: submitted.id } });
    expect(
      await prisma.visitor.count({ where: { church_id: churchId, first_name: 'Race guest' } }),
    ).toBe(receipt ? 1 : 0);
    if (receipt) expect(receipt.status).toBe('accepted');
  });
  it('keeps registration data inaccessible to direct browser database roles', async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const client = await pool.connect();
    try {
      for (const role of ['anon', 'authenticated']) {
        await client.query(`SET ROLE ${role}`);
        await expect(client.query('SELECT * FROM intake_submissions')).rejects.toThrow(
          'permission denied',
        );
        await expect(client.query('SELECT * FROM intake_links')).rejects.toThrow(
          'permission denied',
        );
        await client.query('RESET ROLE');
      }
    } finally {
      client.release();
      await pool.end();
    }
  });
});
