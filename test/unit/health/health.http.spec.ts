import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AddressInfo } from 'node:net';
import { HealthController } from '../../../src/health/health.controller';
import { HealthService } from '../../../src/health/health.service';
import { ResponseInterceptor } from '../../../src/common/interceptors/response.interceptor';

describe('Public health HTTP contract', () => {
  let app: INestApplication;
  let origin: string;
  const check = jest.fn();
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: HealthService, useValue: { check } }],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.listen(0, '127.0.0.1');
    origin = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await app?.close();
  });

  it('serves liveness without checking external dependencies', async () => {
    const response = await fetch(`${origin}/api/v1/health/live`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, data: { status: 'alive' } });
    expect(check).not.toHaveBeenCalled();
  });
  it.each(['/api/v1/health', '/api/v1/health/ready'])(
    'keeps the response envelope at %s and sets a truthful HTTP status',
    async (path) => {
      check.mockResolvedValue({
        status: 'degraded',
        services: { database: 'up', redis: 'up' },
        queues: {},
        workers: {},
      });
      const unavailable = await fetch(`${origin}${path}`);
      expect(unavailable.status).toBe(503);
      expect(await unavailable.json()).toMatchObject({
        success: true,
        data: { status: 'degraded' },
        meta: { path },
      });
      check.mockResolvedValue({
        status: 'healthy',
        services: { database: 'up', redis: 'up' },
        queues: {},
        workers: {},
      });
      const available = await fetch(`${origin}${path}`);
      expect(available.status).toBe(200);
    },
  );
});
