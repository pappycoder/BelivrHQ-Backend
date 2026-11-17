// Identity verification is isolated from the external JWKS provider. The real
// JwtAuthGuard and Nest routing/guard execution still run for every request.
jest.mock('jose', () => ({ errors: { JOSEError: class JOSEError extends Error {} } }));

import 'reflect-metadata';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { INestApplication, RequestMethod, Type, UnauthorizedException } from '@nestjs/common';
import {
  GUARDS_METADATA,
  INTERCEPTORS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { JwtAuthGuard } from '../../../src/auth/guards/jwt-auth.guard';

function controllerFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? controllerFiles(path)
      : path.endsWith('.controller.ts')
        ? [path]
        : [];
  });
}
const controllers = controllerFiles(join(__dirname, '../../../src')).flatMap((file) => {
  // Runtime discovery deliberately exercises the installed controller decorators.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const exports = require(file) as Record<string, Type>;
  return Object.values(exports).filter(
    (value) => typeof value === 'function' && Reflect.hasMetadata(PATH_METADATA, value),
  );
});
const metadata = (key: string, target: object): Type[] => Reflect.getMetadata(key, target) ?? [];
const routes = controllers.flatMap((controller) =>
  Object.getOwnPropertyNames(controller.prototype).flatMap((name) => {
    if (name === 'constructor') return [];
    const handler = controller.prototype[name];
    const method: RequestMethod | undefined = Reflect.getMetadata(METHOD_METADATA, handler);
    const guards = [
      ...metadata(GUARDS_METADATA, controller),
      ...metadata(GUARDS_METADATA, handler),
    ];
    if (method === undefined || !guards.includes(JwtAuthGuard)) return [];
    const prefixes = [Reflect.getMetadata(PATH_METADATA, controller)].flat();
    const paths = [Reflect.getMetadata(PATH_METADATA, handler)].flat();
    return prefixes.flatMap((prefix: string) =>
      paths.map((path: string) => ({
        controller,
        name,
        method: RequestMethod[method].toLowerCase(),
        path: `/${prefix}/${path}`
          .replace(/\/{2,}/g, '/')
          .replace(/\/$/, '')
          .replace(/:[\w]+/g, '11111111-1111-4111-8111-111111111111'),
      })),
    );
  }),
);

describe('Protected HTTP routes reject unauthenticated requests before business work', () => {
  let app: INestApplication;
  let origin: string;
  const work = jest.fn(() => {
    throw new Error('Business service must not run before authentication');
  });
  const verify = jest.fn().mockRejectedValue(new UnauthorizedException('Invalid synthetic token'));
  beforeAll(async () => {
    const selected = [...new Set(routes.map((route) => route.controller))];
    const dependencies = [
      ...new Set(
        selected.flatMap(
          (controller) => Reflect.getMetadata('design:paramtypes', controller) ?? [],
        ),
      ),
    ];
    const blocked = new Proxy(
      {},
      {
        get: (_target, key) =>
          [
            'then',
            'onModuleInit',
            'onModuleDestroy',
            'onApplicationBootstrap',
            'beforeApplicationShutdown',
            'onApplicationShutdown',
          ].includes(String(key))
            ? undefined
            : work,
      },
    );
    const builder = Test.createTestingModule({
      controllers: selected,
      providers: dependencies.map((provide) => ({ provide, useValue: blocked })),
    });
    const guards = new Set<Type>();
    const interceptors = new Set<Type>();
    for (const controller of selected) {
      for (const target of [
        controller,
        ...Object.getOwnPropertyNames(controller.prototype)
          .filter((name) => name !== 'constructor')
          .map((name) => controller.prototype[name]),
      ]) {
        for (const guard of metadata(GUARDS_METADATA, target)) guards.add(guard);
        for (const interceptor of metadata(INTERCEPTORS_METADATA, target))
          interceptors.add(interceptor);
      }
    }
    for (const guard of guards)
      builder
        .overrideGuard(guard)
        .useValue(
          guard === JwtAuthGuard
            ? new JwtAuthGuard({ verifyToken: verify } as never, {} as never, {} as never)
            : { canActivate: () => true },
        );
    for (const interceptor of interceptors)
      builder.overrideInterceptor(interceptor).useValue({
        intercept: (_context: unknown, next: { handle: () => unknown }) => next.handle(),
      });
    const module = await builder.compile();
    app = module.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    origin = await app.getUrl();
    work.mockClear();
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(() => {
    work.mockClear();
    verify.mockClear();
  });

  it('covers the full protected controller inventory rather than a few example endpoints', () => {
    expect(new Set(routes.map((route) => route.controller.name)).size).toBeGreaterThan(25);
    expect(routes.length).toBeGreaterThan(250);
  });
  it.each(routes)(
    '$method $path ($name) rejects a missing bearer token',
    async ({ method, path }) => {
      const response = await fetch(origin + path, {
        method: method.toUpperCase(),
        ...(method === 'get' || method === 'head'
          ? {}
          : { body: '{}', headers: { 'Content-Type': 'application/json' } }),
      });
      await response.arrayBuffer();
      expect(response.status).toBe(401);
      expect(verify).not.toHaveBeenCalled();
      expect(work).not.toHaveBeenCalled();
    },
  );
  it.each(routes)(
    '$method $path ($name) rejects an invalid bearer token',
    async ({ method, path }) => {
      const response = await fetch(origin + path, {
        method: method.toUpperCase(),
        headers: {
          Authorization: 'Bearer synthetic-invalid-token',
          'Content-Type': 'application/json',
        },
        ...(method === 'get' || method === 'head' ? {} : { body: '{}' }),
      });
      await response.arrayBuffer();
      expect(response.status).toBe(401);
      expect(verify).toHaveBeenCalledWith('synthetic-invalid-token');
      expect(work).not.toHaveBeenCalled();
    },
  );
});
