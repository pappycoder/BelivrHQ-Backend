import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../src/prisma/prisma.service';
import { WebhookDispatchService } from '../../src/webhooks/webhook-dispatch.service';
import { WebhooksService } from '../../src/webhooks/webhooks.service';

describe('Transactional webhook intent and dispatch recovery', () => {
  const prisma = new PrismaService();
  const churches: string[] = [];
  const subscriptions: string[] = [];
  let churchId: string;
  let subscriptionId: string;
  const queue = { add: jest.fn(), getJob: jest.fn() };
  beforeAll(async () => {
    await prisma.$connect();
  });
  beforeEach(async () => {
    queue.add.mockReset().mockResolvedValue({});
    queue.getJob.mockReset().mockResolvedValue(null);
    const church = await prisma.church.create({ data: { name: 'Isolated webhook fixture' } });
    churchId = church.id;
    churches.push(churchId);
    await prisma.platformSubscription.create({
      data: {
        church_id: churchId,
        plan: 'network',
        cycle: 'monthly',
        paid_until: new Date(Date.now() + 86400000),
      },
    });
    const subscription = await prisma.webhookSubscription.create({
      data: {
        church_id: churchId,
        url: 'https://example.invalid/hook',
        events: ['member.created', 'transaction.completed'],
        secret: 'synthetic-fixture-secret',
      },
    });
    subscriptionId = subscription.id;
    subscriptions.push(subscriptionId);
  });
  afterAll(async () => {
    const where = { church_id: { in: churches } };
    await prisma.webhookDelivery.deleteMany({ where: { subscription_id: { in: subscriptions } } });
    await prisma.webhookSubscription.deleteMany({ where });
    await prisma.member.deleteMany({ where });
    await prisma.transaction.deleteMany({ where });
    await prisma.profile.deleteMany({ where });
    await prisma.auditLog.deleteMany({ where });
    await prisma.church.deleteMany({ where: { id: { in: churches } } });
    await prisma.$disconnect();
  });

  it('atomically records documented member events with minimal payloads and exact subscription scope', async () => {
    const otherChurch = await prisma.church.create({ data: { name: 'Other webhook tenant' } });
    churches.push(otherChurch.id);
    await prisma.platformSubscription.create({
      data: {
        church_id: otherChurch.id,
        plan: 'network',
        cycle: 'monthly',
        paid_until: new Date(Date.now() + 86400000),
      },
    });
    const otherSubscriptions = await Promise.all([
      prisma.webhookSubscription.create({
        data: {
          church_id: churchId,
          url: 'https://example.invalid/inactive',
          events: ['member.created'],
          secret: 'fixture',
          is_active: false,
        },
      }),
      prisma.webhookSubscription.create({
        data: {
          church_id: churchId,
          url: 'https://example.invalid/archive',
          events: ['member.created'],
          secret: 'fixture',
          archived_at: new Date(),
        },
      }),
      prisma.webhookSubscription.create({
        data: {
          church_id: otherChurch.id,
          url: 'https://example.invalid/other',
          events: ['member.created'],
          secret: 'fixture',
        },
      }),
    ]);
    subscriptions.push(...otherSubscriptions.map((sub) => sub.id));
    const member = await prisma.member.create({
      data: {
        church_id: churchId,
        first_name: 'Private',
        last_name: 'Fixture',
        email: 'private@example.invalid',
      },
    });
    const rows = await prisma.webhookDelivery.findMany({
      where: {
        subscription_id: { in: [subscriptionId, ...otherSubscriptions.map((sub) => sub.id)] },
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      subscription_id: subscriptionId,
      event: 'member.created',
      status: 'pending',
      payload: { memberId: member.id, branchId: null },
    });
    expect(JSON.stringify(rows[0].payload)).not.toContain('private@example.invalid');
    await prisma.webhookSubscription.deleteMany({
      where: { id: { in: otherSubscriptions.map((sub) => sub.id) } },
    });
  });
  it('rolls back delivery intent when its domain transaction rolls back', async () => {
    const id = randomUUID();
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.member.create({
          data: { id, church_id: churchId, first_name: 'Rollback', last_name: 'Fixture' },
        });
        throw new Error('synthetic rollback');
      }),
    ).rejects.toThrow('synthetic rollback');
    expect(await prisma.member.findUnique({ where: { id } })).toBeNull();
    expect(await prisma.webhookDelivery.count({ where: { subscription_id: subscriptionId } })).toBe(
      0,
    );
  });
  it('records settlement once and ignores replayed success updates', async () => {
    const payment = await prisma.transaction.create({
      data: { church_id: churchId, amount: 100, currency: 'NGN', status: 'pending' },
    });
    expect(await prisma.webhookDelivery.count({ where: { subscription_id: subscriptionId } })).toBe(
      0,
    );
    await prisma.transaction.update({ where: { id: payment.id }, data: { status: 'success' } });
    await prisma.transaction.update({ where: { id: payment.id }, data: { status: 'success' } });
    const rows = await prisma.webhookDelivery.findMany({
      where: { subscription_id: subscriptionId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].event).toBe('transaction.completed');
    expect(rows[0].payload).toMatchObject({ transactionId: payment.id, currency: 'NGN' });
  });
  it('allows one concurrent dispatcher to claim pending intent', async () => {
    const row = await prisma.webhookDelivery.create({
      data: { subscription_id: subscriptionId, event: 'test.ping', payload: {} },
    });
    const a = new WebhookDispatchService(prisma, queue as never);
    const b = new WebhookDispatchService(prisma, queue as never);
    const results = await Promise.all([a.dispatch(row.id), b.dispatch(row.id)]);
    expect(results.sort()).toEqual([false, true]);
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add.mock.calls[0][2].jobId).toBe(`webhook-${row.id}`);
  });
  it('recovers after ambiguous queue acceptance and a process restart without duplicating intent', async () => {
    const row = await prisma.webhookDelivery.create({
      data: { subscription_id: subscriptionId, event: 'test.ping', payload: {} },
    });
    queue.add.mockRejectedValueOnce(new Error('acknowledgement lost'));
    expect(await new WebhookDispatchService(prisma, queue as never).dispatch(row.id)).toBe(false);
    expect((await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(
      'pending',
    );
    expect(await new WebhookDispatchService(prisma, queue as never).dispatch(row.id)).toBe(false);
    await prisma.webhookDelivery.update({
      where: { id: row.id },
      data: { next_retry_at: new Date(Date.now() - 1) },
    });
    expect(await new WebhookDispatchService(prisma, queue as never).dispatch(row.id)).toBe(true);
    expect(queue.add.mock.calls.map((call) => call[2].jobId)).toEqual([
      `webhook-${row.id}`,
      `webhook-${row.id}`,
    ]);
    expect(await prisma.webhookDelivery.count({ where: { id: row.id } })).toBe(1);
  });

  it('serializes competing operator retries and commits one audited generation', async () => {
    const actor = randomUUID();
    await prisma.profile.create({
      data: {
        church_id: churchId,
        user_id: actor,
        first_name: 'Operator',
        last_name: 'Fixture',
        role: ['super_admin'],
        is_admin_hq: true,
      },
    });
    const row = await prisma.webhookDelivery.create({
      data: { subscription_id: subscriptionId, event: 'test.ping', payload: {}, status: 'failed' },
    });
    const dispatcher = new WebhookDispatchService(prisma, queue as never);
    const service = new WebhooksService(prisma, {} as never, dispatcher);
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        service.retryDelivery(row.id, churchId, actor, 'Reviewed isolated fixture failure'),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(
      (await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: row.id } }))
        .dispatch_generation,
    ).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: { entity: 'webhook_delivery', entity_id: row.id, user_id: actor },
      }),
    ).toBe(1);
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add.mock.calls[0][2].jobId).toBe(`webhook-${row.id}-1`);
  });
  it('rejects ordinary administrators before changing failed deliveries', async () => {
    const actor = randomUUID();
    await prisma.profile.create({
      data: {
        church_id: churchId,
        user_id: actor,
        first_name: 'Admin',
        last_name: 'Fixture',
        role: ['church_admin'],
        is_admin_hq: true,
      },
    });
    const row = await prisma.webhookDelivery.create({
      data: { subscription_id: subscriptionId, event: 'test.ping', payload: {}, status: 'failed' },
    });
    const service = new WebhooksService(
      prisma,
      {} as never,
      new WebhookDispatchService(prisma, queue as never),
    );
    await expect(
      service.retryDelivery(row.id, churchId, actor, 'Reviewed isolated fixture failure'),
    ).rejects.toThrow('Only super administrators');
    expect((await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(
      'failed',
    );
    expect(queue.add).not.toHaveBeenCalled();
  });
});
