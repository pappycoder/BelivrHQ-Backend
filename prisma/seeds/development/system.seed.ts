/**
 * @file system.seed.ts
 * @description Seeds system rows: church configs, audit logs, webhooks,
 * and sync queue/devices.
 */

import { PrismaClient, Prisma } from '@prisma/client';

export async function seedSystem(prisma: PrismaClient, churchId: string): Promise<void> {
  console.log('📦 Seeding system rows (configs, audit, webhooks, sync)...');

  // ---------------------------------------------------------------------------
  // Church configs
  // ---------------------------------------------------------------------------

  const configs: Array<[string, unknown]> = [
    ['currency', 'NGN'],
    ['timezone', 'Africa/Lagos'],
    ['attendance_enabled', true],
    ['whatsapp_enabled', true],
    ['giving_enabled', true],
    ['default_language', 'en'],
  ];

  for (const config of configs) {
    const [key, value] = config;

    const existing = await prisma.churchConfig.findFirst({
      where: {
        church_id: churchId,
        key,
      },
    });

    if (existing) {
      continue;
    }

    await prisma.churchConfig.create({
      data: {
        church_id: churchId,
        key,
        value: value as Prisma.InputJsonValue,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Sample audit logs
  // ---------------------------------------------------------------------------

  const auditLogCount = await prisma.auditLog.count({
    where: {
      church_id: churchId,
    },
  });

  if (auditLogCount === 0) {
    await prisma.auditLog.createMany({
      data: [
        {
          church_id: churchId,
          action: 'CREATE',
          entity: 'church',
          entity_id: churchId,
          new_values: {
            name: 'Grace Community Church',
          } as Prisma.InputJsonValue,
        },
        {
          church_id: churchId,
          action: 'LOGIN',
          entity: 'auth',
          user_id: 'seed-user',
          new_values: {
            ok: true,
          } as Prisma.InputJsonValue,
        },
        {
          church_id: churchId,
          action: 'UPDATE',
          entity: 'member',
          entity_id: 'seed-member',
          new_values: {
            status: 'active',
          } as Prisma.InputJsonValue,
        },
      ],
    });
  }

  // ---------------------------------------------------------------------------
  // Webhook subscription + delivery
  // ---------------------------------------------------------------------------

  const existingSubscription = await prisma.webhookSubscription.findFirst({
    where: {
      church_id: churchId,
    },
  });

  if (!existingSubscription) {
    const subscription = await prisma.webhookSubscription.create({
      data: {
        church_id: churchId,
        url: 'https://hooks.example.com/belivrhq',
        events: ['member.created', 'transaction.completed'],
        secret: 'seed-webhook-secret',
        is_active: true,
      },
    });

    await prisma.webhookDelivery.create({
      data: {
        subscription_id: subscription.id,
        event: 'member.created',
        payload: {
          id: 'seed-member-1',
        } as Prisma.InputJsonValue,
        status: 'success',
        response_status: 200,
        response_body: 'OK',
        attempts: 1,
      },
    });

    await prisma.webhookDelivery.create({
      data: {
        subscription_id: subscription.id,
        event: 'transaction.completed',
        payload: {
          id: 'seed-tx-1',
        } as Prisma.InputJsonValue,
        status: 'pending',
        attempts: 0,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Sync rows
  // ---------------------------------------------------------------------------

  const existingSyncDevice = await prisma.syncDevice.findFirst({
    where: {
      church_id: churchId,
    },
  });

  if (!existingSyncDevice) {
    const device = await prisma.syncDevice.create({
      data: {
        church_id: churchId,
        device_id: 'seed-device-001',
      },
    });

    await prisma.syncQueue.create({
      data: {
        church_id: churchId,
        entity: 'member',
        entity_id: 'seed-member-1',
        action: 'create',
        data: {
          first_name: 'Seed',
        } as Prisma.InputJsonValue,
        synced: false,
      },
    });

    console.log(`  ✅ Sync device: ${device.id.slice(0, 8)}`);
  }

  console.log('  🎉 System rows written');
}
