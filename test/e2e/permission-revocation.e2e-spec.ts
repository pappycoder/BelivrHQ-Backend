import { Controller, Get, INestApplication, UseGuards } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import { Request, Response, NextFunction } from 'express';
import { PermissionsGuard } from '../../src/auth/guards/permissions.guard';
import { RequirePermissions } from '../../src/auth/decorators/permissions.decorator';
import { PermissionsService } from '../../src/auth/services/permissions.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { RedisService } from '../../src/redis/redis.service';
import { AuditLoggingService } from '../../src/common/services/audit-logging.service';
import { seedWorkflowSubscription } from '../helpers/workflow-subscription.helper';

// Identity is a local fixture; actual grant resolution, guard and PostgreSQL are exercised.
@Controller('audit-permission')
@UseGuards(PermissionsGuard)
class AuditPermissionController {
  @Get()
  @RequirePermissions('members:all:delete')
  check() {
    return { allowed: true };
  }
}

describe('Committed permission revocation (PostgreSQL + HTTP)', () => {
  const churches = [randomUUID(), randomUUID()];
  const roleName = `audit_${randomUUID().replace(/-/g, '')}`;
  let actorChurch = churches[0];
  let prisma: PrismaService;
  let app: INestApplication;
  let origin: string;
  let service: PermissionsService;
  let createdPermission: string | undefined;
  const redis = {
    get: jest.fn().mockResolvedValue(['members:all:delete']),
    set: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockRejectedValue(new Error('Simulated invalidation failure')),
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    let permission = await prisma.permission.findUnique({ where: { name: 'members:all:delete' } });
    if (!permission) {
      permission = await prisma.permission.create({
        data: { name: 'members:all:delete', resource: 'members:all', action: 'delete' },
      });
      createdPermission = permission.id;
    }
    for (const churchId of churches) {
      await prisma.church.create({ data: { id: churchId, name: 'Permission audit fixture' } });
      await seedWorkflowSubscription(prisma, churchId);
      await prisma.role.create({
        data: {
          church_id: churchId,
          name: roleName,
          label: 'Audit fixture',
          permissions: { create: { permission_id: permission.id } },
        },
      });
    }
    const module = await Test.createTestingModule({
      controllers: [AuditPermissionController],
      providers: [
        PermissionsService,
        PermissionsGuard,
        Reflector,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
        { provide: AuditLoggingService, useValue: { log: jest.fn() } },
      ],
    }).compile();
    service = module.get(PermissionsService);
    app = module.createNestApplication();
    app.use((request: Request, _response: Response, next: NextFunction) => {
      Object.assign(request, {
        user: { sub: 'synthetic-audit-identity' },
        profile: { church_id: actorChurch, role: roleName, roles: [roleName], is_admin_hq: false },
      });
      next();
    });
    await app.listen(0, '127.0.0.1');
    origin = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.rolePermission.deleteMany({ where: { role: { church_id: { in: churches } } } });
    await prisma?.role.deleteMany({ where: { church_id: { in: churches } } });
    await prisma?.church.deleteMany({ where: { id: { in: churches } } });
    if (createdPermission) await prisma.permission.delete({ where: { id: createdPermission } });
    await prisma?.$disconnect();
  });

  it('denies the next request after revocation despite stale Redis, without changing another church', async () => {
    expect((await fetch(`${origin}/audit-permission`)).status).toBe(200);
    await service.setPermissionsForRole(churches[0], roleName, []);
    expect(redis.del).toHaveBeenCalled();
    expect((await fetch(`${origin}/audit-permission`)).status).toBe(403);
    actorChurch = churches[1];
    expect((await fetch(`${origin}/audit-permission`)).status).toBe(200);
    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });
});
