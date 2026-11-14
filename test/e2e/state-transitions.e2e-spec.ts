import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { validate } from 'class-validator';
import { PrismaService } from '../../src/prisma/prisma.service';
import { RequestContextService } from '../../src/common/services/request-context.service';
import { BranchScopeService } from '../../src/common/services/branch-scope.service';
import { AssetsService } from '../../src/assets/assets.service';
import { VisitorsService } from '../../src/visitors/visitors.service';
import { FormsService } from '../../src/forms/forms.service';
import { UpdateSubmissionStatusDto } from '../../src/forms/dto/update-submission-status.dto';
import { BroadcastService } from '../../src/broadcast/broadcast.service';
import { BillingService } from '../../src/billing/billing.service';
import { accessGrants } from '../../src/billing/payment-access';

jest.mock('jose', () => ({}));
describe('State transitions with PostgreSQL', () => {
  const prisma = new PrismaService(),
    context = new RequestContextService();
  const audit = { log: jest.fn(), notifyMutation: jest.fn() };
  const assets = new AssetsService(prisma, context, audit as never);
  const visitors = new VisitorsService(prisma, audit as never, context);
  const forms = new FormsService(prisma, audit as never, new BranchScopeService(context));
  const user = randomUUID(),
    churches: string[] = [];
  const verifier = jest.fn(),
    adjustments = jest.fn().mockResolvedValue([]);
  const provider = {
    name: 'flutterwave',
    isConfigured: () => true,
    verifyTransaction: verifier,
    listAdjustments: adjustments,
  };
  const emails = { dispatch: jest.fn(), enqueueSubscription: jest.fn() };
  const billing = new BillingService(
    prisma,
    new ConfigService(),
    provider as never,
    provider as never,
    { gatewayCurrencies: () => ['NGN'] } as never,
    emails as never,
  );
  async function church() {
    const id = randomUUID();
    churches.push(id);
    await prisma.church.create({ data: { id, name: 'Transition fixture' } });
    await prisma.platformSubscription.create({
      data: {
        church_id: id,
        plan: 'network',
        cycle: 'monthly',
        paid_until: new Date(Date.now() + 86400000),
      },
    });
    return id;
  }
  const asset = (churchId: string) =>
    prisma.asset.create({
      data: { church_id: churchId, asset_tag: randomUUID(), name: 'Loan fixture' },
    });
  const visitor = (churchId: string, notes?: string) =>
    prisma.visitor.create({
      data: { church_id: churchId, first_name: 'Visitor', last_name: 'Fixture', notes },
    });
  async function payment(churchId: string, intent = 'renewal') {
    const reference = `BHQSUB_${randomUUID().replaceAll('-', '')}`;
    verifier.mockImplementation(async (ref: string) => ({
      reference: ref,
      amount: 100,
      currency: 'NGN',
      status: 'success',
      providerTransactionId: ref,
    }));
    return prisma.subscriptionPayment.create({
      data: {
        reference,
        church_id: churchId,
        gateway: 'flutterwave',
        plan: 'essentials',
        cycle: 'monthly',
        amount: 100,
        currency: 'NGN',
        intent,
        status: 'success',
        verified_at: new Date(),
        application_status: 'review',
        checkout_closed_at: new Date(),
        checkout_close_reason: 'cancelled',
      },
    });
  }
  const reviewer = { id: user, roles: ['super_admin'] };
  beforeAll(async () => {
    await prisma.$connect();
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION state_test_conversion_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.notes = 'force rollback' AND NEW.converted_member_id IS NOT NULL THEN RAISE EXCEPTION 'forced rollback'; END IF; RETURN NEW; END $$`,
    );
    await prisma.$executeRawUnsafe(
      'CREATE TRIGGER state_test_conversion_failure BEFORE UPDATE ON visitors FOR EACH ROW EXECUTE FUNCTION state_test_conversion_failure()',
    );
  });
  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'DROP TRIGGER IF EXISTS state_test_conversion_failure ON visitors',
    );
    await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS state_test_conversion_failure()');
    const where = { church_id: { in: churches } };
    await prisma.broadcast.deleteMany({ where });
    await prisma.template.deleteMany({ where });
    await prisma.formSubmission.deleteMany({ where });
    await prisma.form.deleteMany({ where });
    await prisma.asset.deleteMany({ where });
    await prisma.visitor.deleteMany({ where });
    await prisma.member.deleteMany({ where });
    await prisma.subscriptionPayment.deleteMany({ where });
    await prisma.auditLog.deleteMany({ where });
    await prisma.church.deleteMany({ where: { id: { in: churches } } });
    await prisma.$disconnect();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    adjustments.mockResolvedValue([]);
  });
  it('allows one concurrent loan and leaves asset status independent', async () => {
    const id = await church(),
      item = await asset(id);
    const attempts = await Promise.allSettled(
      [1, 2].map(() =>
        assets.createLoan(
          id,
          item.id,
          { borrowedByName: 'Vendor', expectedReturnDate: '2099-01-01' },
          user,
        ),
      ),
    );
    expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.assetLoan.count({ where: { asset_id: item.id } })).toBe(1);
    expect((await prisma.asset.findUniqueOrThrow({ where: { id: item.id } })).status).toBe(
      'active',
    );
  });
  it('enforces the outstanding-loan constraint for direct writers', async () => {
    const id = await church(),
      item = await asset(id);
    const data = {
      asset_id: item.id,
      borrowed_by_name: 'Vendor',
      expected_return_date: new Date('2099-01-01'),
    };
    await prisma.assetLoan.create({ data });
    await expect(
      prisma.assetLoan.create({ data: { ...data, status: 'overdue' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
  it('accepts one concurrent return without reactivating retired equipment', async () => {
    const id = await church(),
      item = await asset(id);
    const loan = await assets.createLoan(
      id,
      item.id,
      { borrowedByName: 'Vendor', expectedReturnDate: '2099-01-01' },
      user,
    );
    await prisma.asset.update({ where: { id: item.id }, data: { status: 'retired' } });
    const attempts = await Promise.allSettled(
      [1, 2].map(() => assets.returnLoan(id, item.id, loan.id, {}, user)),
    );
    expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await prisma.asset.findUniqueOrThrow({ where: { id: item.id } })).status).toBe(
      'retired',
    );
  });
  it('rejects unavailable and foreign-tenant equipment', async () => {
    const id = await church(),
      other = await church(),
      item = await asset(id);
    await prisma.asset.update({ where: { id: item.id }, data: { status: 'maintenance' } });
    await expect(
      assets.createLoan(
        id,
        item.id,
        { borrowedByName: 'Vendor', expectedReturnDate: '2099-01-01' },
        user,
      ),
    ).rejects.toThrow('Only active');
    await expect(
      assets.createLoan(
        other,
        item.id,
        { borrowedByName: 'Vendor', expectedReturnDate: '2099-01-01' },
        user,
      ),
    ).rejects.toThrow('not found');
  });
  it('converts once under concurrency and returns the same result on replay', async () => {
    const id = await church(),
      person = await visitor(id);
    const results = await Promise.all(
      [1, 2].map(() =>
        visitors.convertToMember(
          person.id,
          { firstName: 'Converted', lastName: 'Fixture' },
          id,
          user,
        ),
      ),
    );
    expect(results[0].memberId).toBe(results[1].memberId);
    expect(await prisma.member.count({ where: { church_id: id } })).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: { church_id: id, entity: 'visitor', action: 'UPDATE' },
      }),
    ).toBe(1);
    expect(audit.notifyMutation).toHaveBeenCalledTimes(1);
  });
  it('rejects a conversion destination branch owned by another church', async () => {
    const id = await church(),
      other = await church(),
      person = await visitor(id);
    const branch = await prisma.branch.create({
      data: { church_id: other, name: 'Foreign destination' },
    });
    try {
      await expect(
        visitors.convertToMember(
          person.id,
          { firstName: 'Converted', lastName: 'Fixture', branchId: branch.id },
          id,
          user,
        ),
      ).rejects.toThrow('Branch not found');
      expect(await prisma.member.count({ where: { church_id: id } })).toBe(0);
    } finally {
      await prisma.branch.delete({ where: { id: branch.id } });
    }
  });
  it('rolls back the member when conversion fails after creating it', async () => {
    const id = await church(),
      person = await visitor(id, 'force rollback');
    await expect(
      visitors.convertToMember(
        person.id,
        { firstName: 'Converted', lastName: 'Fixture' },
        id,
        user,
      ),
    ).rejects.toThrow();
    expect(await prisma.member.count({ where: { church_id: id } })).toBe(0);
    expect(
      (await prisma.visitor.findUniqueOrThrow({ where: { id: person.id } })).converted_member_id,
    ).toBeNull();
    expect(audit.notifyMutation).not.toHaveBeenCalled();
  });
  it('accepts exactly one competing review and forbids pending as a decision', async () => {
    const id = await church();
    const form = await prisma.form.create({
      data: { church_id: id, title: 'Fixture', fields: [], status: 'published' },
    });
    const submission = await prisma.formSubmission.create({
      data: { church_id: id, form_id: form.id, data: {} },
    });
    const attempts = await Promise.allSettled(
      (['approved', 'rejected'] as const).map((status) =>
        forms.updateSubmissionStatus(id, form.id, submission.id, { status }, user),
      ),
    );
    expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      (attempts.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason,
    ).toBeInstanceOf(ConflictException);
    expect(audit.log).toHaveBeenCalledTimes(1);
    const dto = Object.assign(new UpdateSubmissionStatusDto(), { status: 'pending' });
    expect(await validate(dto)).not.toHaveLength(0);
    await expect(
      forms.updateSubmissionStatus(id, form.id, submission.id, dto, user),
    ).rejects.toThrow('approved or rejected');
  });
  it('serializes cancellation with enqueue and preserves cancelled status', async () => {
    const id = await church();
    const template = await prisma.template.create({
      data: {
        church_id: id,
        name: 'Fixture',
        channel: 'sms',
        content: 'Hello',
        status: 'published',
      },
    });
    const campaign = await prisma.broadcast.create({
      data: {
        church_id: id,
        template_id: template.id,
        name: 'Fixture',
        channel: 'sms',
        audience_filter: {},
        status: 'scheduled',
      },
    });
    await prisma.broadcastRecipient.createMany({
      data: [1, 2].map((n) => ({ broadcast_id: campaign.id, phone: `+234800000000${n}` })),
    });
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
      }),
      entered = new Promise<void>((resolve) => {
        started = resolve;
      });
    const queue = {
      add: jest.fn(async (..._args: unknown[]) => {
        started();
        await gate;
      }),
    };
    const broadcasts = new BroadcastService(
      prisma,
      context,
      audit as never,
      { broadcastToChurch: jest.fn() } as never,
      queue as never,
      queue as never,
      queue as never,
      queue as never,
      { resolve: jest.fn() } as never,
    );
    const processing = broadcasts.processBroadcast(campaign.id, id);
    await entered;
    const cancellation = broadcasts.cancel(campaign.id, id, user);
    try {
      const until = Date.now() + 3000;
      let waiting = false;
      while (Date.now() < until) {
        const rows = await prisma.$queryRaw<
          { count: bigint }[]
        >`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
        if (Number(rows[0].count) > 0) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
    } finally {
      release();
    }
    await Promise.all([processing, cancellation]);
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect((await prisma.broadcast.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe(
      'cancelled',
    );
    expect(
      await prisma.broadcastRecipient.count({
        where: { broadcast_id: campaign.id, status: 'pending' },
      }),
    ).toBe(1);
    expect(queue.add.mock.calls[0][2]).toMatchObject({
      jobId: expect.stringContaining(campaign.id),
    });
  });
  it('applies a renewal once after existing future coverage', async () => {
    const id = await church(),
      paid = await payment(id);
    const now = Date.now(),
      end = now + 86400000,
      futureEnd = end + 86400000;
    await prisma.platformSubscription.update({
      where: { church_id: id },
      data: {
        access_grants: {
          grants: [
            {
              reference: 'base',
              plan: 'network',
              cycle: 'monthly',
              start: new Date(now - 1000).toISOString(),
              end: new Date(end).toISOString(),
              state: 'clear',
            },
            {
              reference: 'future',
              plan: 'network',
              cycle: 'monthly',
              start: new Date(end).toISOString(),
              end: new Date(futureEnd).toISOString(),
              state: 'clear',
            },
          ],
        },
      },
    });
    await Promise.all(
      [1, 2].map(() =>
        billing.resolveUnappliedPayment(
          id,
          reviewer,
          paid.reference,
          'apply',
          'Verified late payment reviewed',
        ),
      ),
    );
    const grants = accessGrants(
      (await prisma.platformSubscription.findUniqueOrThrow({ where: { church_id: id } }))
        .access_grants,
    ).filter((g) => g.reference === paid.reference);
    expect(grants).toHaveLength(1);
    expect(Date.parse(grants[0].start)).toBe(futureEnd);
    expect(
      await prisma.auditLog.count({
        where: { church_id: id, entity: 'subscription_payment_application_review' },
      }),
    ).toBe(1);
    expect(emails.enqueueSubscription).toHaveBeenCalledTimes(1);
  });
  it('does not delay a newly reviewed renewal behind revoked future coverage', async () => {
    const id = await church(),
      paid = await payment(id);
    const before = Date.now();
    await prisma.platformSubscription.update({
      where: { church_id: id },
      data: {
        paid_until: new Date('2099-01-01'),
        access_grants: {
          grants: [
            {
              reference: 'revoked',
              plan: 'network',
              cycle: 'monthly',
              start: new Date(before - 1000).toISOString(),
              end: '2099-01-01T00:00:00.000Z',
              state: 'revoked',
            },
          ],
        },
      },
    });
    await billing.resolveUnappliedPayment(
      id,
      reviewer,
      paid.reference,
      'apply',
      'New independently paid renewal',
    );
    const grant = accessGrants(
      (await prisma.platformSubscription.findUniqueOrThrow({ where: { church_id: id } }))
        .access_grants,
    ).find((g) => g.reference === paid.reference)!;
    expect(Date.parse(grant.start)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(grant.start)).toBeLessThanOrEqual(Date.now());
  });
  it('preserves manual application revocation through later adjustment reconciliation', async () => {
    const id = await church(),
      paid = await payment(id, 'upgrade');
    await billing.resolveUnappliedPayment(
      id,
      reviewer,
      paid.reference,
      'revoke',
      'Stale upgrade needs fresh checkout',
    );
    adjustments.mockResolvedValue([
      { id: 'r1', kind: 'refund', state: 'failed', amount: 100, currency: 'NGN' },
    ]);
    await billing.reconcileAdjustments(id, paid.reference);
    await billing.reconcilePayment(id, paid.reference);
    const saved = await prisma.subscriptionPayment.findUniqueOrThrow({
      where: { reference: paid.reference },
    });
    expect(saved.application_status).toBe('revoked');
    expect(saved.lifecycle).toMatchObject({ applicationReview: { decision: 'revoke' } });
    expect(
      accessGrants(
        (await prisma.platformSubscription.findUniqueOrThrow({ where: { church_id: id } }))
          .access_grants,
      ),
    ).toHaveLength(0);
  });
  it('rejects ordinary administrators and applying stale prorated upgrades', async () => {
    const id = await church(),
      paid = await payment(id, 'upgrade');
    await expect(
      billing.resolveUnappliedPayment(
        id,
        { id: user, roles: ['church_admin'] },
        paid.reference,
        'apply',
        'Administrator review reason',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(verifier).not.toHaveBeenCalled();
    await expect(
      billing.resolveUnappliedPayment(
        id,
        reviewer,
        paid.reference,
        'apply',
        'Administrator review reason',
      ),
    ).rejects.toThrow('stale prorated upgrade');
  });
  it('does not bypass an open dispute through application review', async () => {
    const id = await church(),
      paid = await payment(id);
    await prisma.subscriptionPayment.update({
      where: { reference: paid.reference },
      data: {
        lifecycle: {
          access: 'review',
          adjustments: [{ kind: 'dispute', id: 'd1', state: 'open' }],
        },
      },
    });
    await expect(
      billing.resolveUnappliedPayment(
        id,
        reviewer,
        paid.reference,
        'apply',
        'Administrator review reason',
      ),
    ).rejects.toThrow('refund or dispute');
  });
});
