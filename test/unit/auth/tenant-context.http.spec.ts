import { AttendanceController } from '../../../src/attendance/attendance.controller';
import { AttendanceService } from '../../../src/attendance/attendance.service';
import { WebhooksController } from '../../../src/webhooks/webhooks.controller';
import { WebhooksService } from '../../../src/webhooks/webhooks.service';
import { additionalTenantContracts } from '../../helpers/tenant-http-contracts';
jest.mock('jose', () => ({ errors: { JOSEError: class JOSEError extends Error {} } }));
import 'reflect-metadata';
import { INestApplication, Type } from '@nestjs/common';
import { GUARDS_METADATA, INTERCEPTORS_METADATA } from '@nestjs/common/constants';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { MembersController } from '../../../src/members/members.controller';
import { MembersService } from '../../../src/members/members.service';
import { AssetsController } from '../../../src/assets/assets.controller';
import { AssetsService } from '../../../src/assets/assets.service';
import { TemplatesController } from '../../../src/templates/templates.controller';
import { TemplatesService } from '../../../src/templates/templates.service';
import { ChurchController } from '../../../src/church/church.controller';
import { ChurchService } from '../../../src/church/church.service';
import { PastoralController } from '../../../src/pastoral/pastoral.controller';
import { PastoralService } from '../../../src/pastoral/pastoral.service';
import { SermonsController } from '../../../src/sermons/sermons.controller';
import { SermonsService } from '../../../src/sermons/sermons.service';
import { SyncController } from '../../../src/sync/sync.controller';
import { SyncService } from '../../../src/sync/sync.service';
import { PermissionsGuard } from '../../../src/auth/guards/permissions.guard';
import { PERMISSIONS_KEY } from '../../../src/auth/decorators/permissions.decorator';

const id = '11111111-1111-4111-8111-111111111111';
const church = '22222222-2222-4222-8222-222222222222';
const actor = '33333333-3333-4333-8333-333333333333';
const profileId = '44444444-4444-4444-8444-444444444444';
interface Contract {
  controller: Type;
  service: Type;
  handler: string;
  operation: string;
  method: string;
  path: string;
  churchArg: number;
  actorArg?: number;
  profileArg?: number;
  status?: number;
}
type Row = [string, string, string, number, number?, string?, number?];
function group(controller: Type, service: Type, prefix: string, rows: Row[]): Contract[] {
  return rows.map(([handler, method, path, churchArg, actorArg, operation, status]) => ({
    controller,
    service,
    handler,
    method,
    path: `/${prefix}${path}`,
    churchArg,
    actorArg,
    operation: operation ?? handler,
    status: status ?? (method === 'POST' ? 201 : 200),
  }));
}
// These contracts pin the server-owned tenant/actor handoff. Validation and
// business authorization run in their own suites; no database/provider is used.
const contracts: Contract[] = [
  ...additionalTenantContracts,
  ...group(AttendanceController, AttendanceService, 'services', [
    ['createService', 'POST', '', 1, 2],
    ['listServices', 'GET', '', 0],
    ['getServiceById', 'GET', `/${id}`, 1],
    ['updateService', 'PATCH', `/${id}`, 2, 3],
    ['deleteService', 'DELETE', `/${id}`, 1, 2, undefined, 200],
    ['archiveService', 'POST', `/${id}/archive`, 1, 2, undefined, 200],
    ['restoreService', 'POST', `/${id}/restore`, 1, 2, undefined, 200],
  ]),
  ...group(AttendanceController, AttendanceService, 'attendance', [
    ['listAttendance', 'GET', '', 0],
    ['recordAttendance', 'POST', '', 1, 2],
    ['recordBulkAttendance', 'POST', '/bulk', 1, 2],
    ['recordVisitorAttendance', 'POST', '/visitor', 1, 2],
    ['recordGeneralAttendance', 'POST', '/general', 1, 2],
    ['listGeneralAttendance', 'GET', '/general', 0],
    [
      'generalAttendanceSummary',
      'GET',
      '/general/summary',
      0,
      undefined,
      'getGeneralAttendanceSummary',
    ],
    ['updateGeneralAttendance', 'PATCH', `/general/${id}`, 2, 3],
    ['deleteAttendance', 'DELETE', `/${id}`, 1, 2, undefined, 200],
    ['getAttendanceSummary', 'GET', '/summary', 0],
    ['getAttendanceTrends', 'GET', '/trends', 0],
    ['getAttendanceByService', 'GET', `/by-service/${id}`, 1],
  ]),
  ...group(WebhooksController, WebhooksService, 'webhooks', [
    ['create', 'POST', '', 1, 2, 'createSubscription'],
    ['list', 'GET', '', 0, undefined, 'listSubscriptions'],
    ['retryDelivery', 'POST', `/deliveries/${id}/retry`, 1, 2],
    ['deactivate', 'DELETE', `/${id}`, 1, 2, 'deactivateSubscription'],
    ['listDeliveries', 'GET', `/${id}/deliveries`, 1],
    ['testDelivery', 'POST', `/${id}/test`, 1],
    ['archive', 'POST', `/${id}/archive`, 1, 2, 'archiveSubscription'],
    ['restore', 'POST', `/${id}/restore`, 1, 2, 'restoreSubscription'],
  ]),
  ...group(MembersController, MembersService, 'members', [
    ['create', 'POST', '', 1, 2, 'createMember'],
    ['findAll', 'GET', '', 0, undefined, 'listMembers'],
    ['getDashboard', 'GET', '/dashboard', 0],
    ['search', 'GET', '/search', 0, undefined, 'searchMembers'],
    ['findOne', 'GET', `/${id}`, 1, undefined, 'getMemberById'],
    ['update', 'PATCH', `/${id}`, 2, 3, 'updateMember'],
    ['remove', 'DELETE', `/${id}`, 1, 2, 'softDeleteMember', 204],
    ['restore', 'POST', `/${id}/restore`, 1, 2, 'restoreMember', 200],
    ['archive', 'POST', `/${id}/archive`, 1, 2, 'archiveMember', 200],
    ['restoreArchive', 'POST', `/${id}/restore-archive`, 1, 2, 'restoreArchivedMember', 200],
    ['bulkImport', 'POST', '/bulk-import', 1, 2, 'bulkImportMembers'],
    ['generateQRCode', 'GET', `/${id}/qr-code`, 1, undefined, 'generateMemberQRCode'],
    ['getGivingHistory', 'GET', `/${id}/giving`, 1, undefined, 'getMemberGivingHistory'],
    [
      'getAttendanceHistory',
      'GET',
      `/${id}/attendance`,
      1,
      undefined,
      'getMemberAttendanceHistory',
    ],
    ['addNote', 'POST', `/${id}/notes`, 2, 3, 'addMemberNote'],
  ]),
  ...group(AssetsController, AssetsService, 'assets', [
    ['createCategory', 'POST', '/categories', 0, 2],
    ['listCategories', 'GET', '/categories', 0],
    ['updateCategory', 'PATCH', `/categories/${id}`, 0, 3],
    ['deleteCategory', 'DELETE', `/categories/${id}`, 0, 2],
    ['archiveCategory', 'POST', `/categories/${id}/archive`, 0, 2, undefined, 200],
    ['restoreCategory', 'POST', `/categories/${id}/restore`, 0, 2, undefined, 200],
    ['createAsset', 'POST', '', 0, 2],
    ['listAssets', 'GET', '', 0],
    ['getAssetsSummary', 'GET', '/stats', 0],
    ['listLoanWorklist', 'GET', '/worklists/loans', 0],
    ['listMaintenanceWorklist', 'GET', '/worklists/maintenance', 0],
    ['getAsset', 'GET', `/${id}`, 0],
    ['updateAsset', 'PATCH', `/${id}`, 0, 3],
    ['deleteAsset', 'DELETE', `/${id}`, 0, 2],
    ['archiveAsset', 'POST', `/${id}/archive`, 0, 2, undefined, 200],
    ['restoreAsset', 'POST', `/${id}/restore`, 0, 2, undefined, 200],
    ['generateQr', 'POST', `/${id}/qr`, 0, undefined, 'generateQrCode'],
    ['getQr', 'GET', `/${id}/qr`, 0, undefined, 'getQrCode'],
    ['scanAsset', 'POST', '/scan', 0],
    ['createMaintenance', 'POST', `/${id}/maintenance`, 0, 3],
    ['listMaintenance', 'GET', `/${id}/maintenance`, 0],
    ['updateMaintenance', 'PATCH', `/${id}/maintenance/${id}`, 0, 4],
    ['createDepreciation', 'POST', `/${id}/depreciation`, 0, 2],
    ['listDepreciation', 'GET', `/${id}/depreciation`, 0],
    ['getDepreciationSummary', 'GET', `/${id}/depreciation/summary`, 0],
    ['createLoan', 'POST', `/${id}/loans`, 0, 3],
    ['listLoans', 'GET', `/${id}/loans`, 0],
    ['returnLoan', 'PATCH', `/${id}/loans/${id}/return`, 0, 4],
  ]),
  ...group(TemplatesController, TemplatesService, 'templates', [
    ['create', 'POST', '', 1, 2],
    ['findAll', 'GET', '', 0],
    ['publish', 'POST', `/${id}/publish`, 1, 2, undefined, 200],
    ['findOne', 'GET', `/${id}`, 1, undefined, 'findById'],
    ['update', 'PATCH', `/${id}`, 2, 3],
    ['archive', 'POST', `/${id}/archive`, 1, 2, undefined, 200],
    ['restore', 'POST', `/${id}/restore`, 1, 2, undefined, 200],
    ['remove', 'DELETE', `/${id}`, 1, 2, 'delete'],
  ]),
  ...group(ChurchController, ChurchService, 'church', [
    ['getChurch', 'GET', '', 0],
    ['updateChurch', 'PATCH', '', 0, 2],
    ['updateChurchEmail', 'PATCH', '/email', 0, 1],
    ['archiveChurch', 'POST', '/archive', 0, 1, undefined, 200],
    ['restoreChurch', 'POST', '/restore', 0, 1, undefined, 200],
    ['getConfig', 'GET', '/config', 0, undefined, 'getChurchConfig'],
    ['updateConfig', 'PATCH', '/config', 0, 2, 'updateChurchConfig'],
    ['inviteStaff', 'POST', '/invite', 0, 2],
    ['listStaff', 'GET', '/staff', 0],
    ['updateStaffRole', 'PATCH', `/staff/${id}/role`, 0, 3],
    ['removeStaff', 'DELETE', `/staff/${id}`, 0, 2, undefined, 204],
  ]),
  ...group(PastoralController, PastoralService, 'pastoral', [
    ['createNote', 'POST', '/notes', 1, 2],
    ['listNotes', 'GET', '/notes', 1, 3],
    ['getNoteById', 'GET', `/notes/${id}`, 1, 3],
    ['updateNote', 'PATCH', `/notes/${id}`, 2, 3],
    ['deleteNote', 'DELETE', `/notes/${id}`, 1, 2, undefined, 204],
    ['archiveNote', 'POST', `/notes/${id}/archive`, 1, 2, undefined, 200],
    ['restoreNote', 'POST', `/notes/${id}/restore`, 1, 2, undefined, 200],
    ['createLifeEvent', 'POST', '/life-events', 1, 2],
    ['listLifeEvents', 'GET', '/life-events', 1],
    ['getUpcomingLifeEvents', 'GET', '/life-events/upcoming', 0],
    ['getLifeEventById', 'GET', `/life-events/${id}`, 1],
    ['deleteLifeEvent', 'DELETE', `/life-events/${id}`, 1, 2, undefined, 204],
    ['archiveLifeEvent', 'POST', `/life-events/${id}/archive`, 1, 2, undefined, 200],
    ['restoreLifeEvent', 'POST', `/life-events/${id}/restore`, 1, 2, undefined, 200],
  ]),
  ...group(SermonsController, SermonsService, 'sermons', [
    ['createSermon', 'POST', '', 1, 2],
    ['listSermons', 'GET', '', 1],
    ['listMyBookmarks', 'GET', '/bookmarks/me', 1, 0, 'listBookmarks'],
    ['listSeries', 'GET', '/series', 0],
    ['listSpeakers', 'GET', '/speakers', 0],
    ['newSermonOptions', 'GET', '/new/options', 0, undefined, 'formOptions'],
    ['editSermonOptions', 'GET', '/edit/options', 0, undefined, 'formOptions'],
    ['getSermon', 'GET', `/${id}`, 1],
    ['updateSermon', 'PATCH', `/${id}`, 2, 3],
    ['deleteSermon', 'DELETE', `/${id}`, 1, 2, undefined, 204],
    ['archiveSermon', 'POST', `/${id}/archive`, 1, 2, undefined, 200],
    ['restoreSermon', 'POST', `/${id}/restore`, 1, 2, undefined, 200],
  ]),
  ...group(SyncController, SyncService, 'sync', [
    ['pushChanges', 'POST', '/push', 0, 1],
    ['bootstrap', 'GET', '/bootstrap', 0],
    ['pullChanges', 'GET', '/pull', 0],
    ['markSynced', 'POST', '/mark-synced', 0],
  ]),
];

describe('HTTP tenant and actor handoff is owned by the verified session', () => {
  let app: INestApplication, origin: string;
  let allowed: string[];
  const mocks = new Map<Type, Record<string, jest.Mock>>();
  const allPermissions = [
    ...new Set(
      contracts.flatMap(
        ({ controller, handler }) =>
          Reflect.getMetadata(PERMISSIONS_KEY, controller.prototype[handler]) ?? [],
      ),
    ),
  ];
  const output = {
    id: 'synthetic-result',
    data: [],
    items: [],
    total: 21,
    page: 1,
    limit: 20,
    asset: { id },
    scanLog: { id },
  };
  beforeAll(async () => {
    const selected = [...new Set(contracts.map((contract) => contract.controller))];
    const dependencies: Type[] = [
      ...new Set(
        selected.flatMap(
          (controller) => Reflect.getMetadata('design:paramtypes', controller) ?? [],
        ),
      ),
    ];
    for (const dependency of dependencies) mocks.set(dependency, {});
    const builder = Test.createTestingModule({
      controllers: selected,
      providers: [
        ...dependencies.map((provide) => ({
          provide,
          useValue: new Proxy(mocks.get(provide)!, {
            get: (target, key: string) => {
              if (
                [
                  'then',
                  'onModuleInit',
                  'onModuleDestroy',
                  'onApplicationBootstrap',
                  'beforeApplicationShutdown',
                  'onApplicationShutdown',
                ].includes(key)
              )
                return undefined;
              return (target[key] ??= jest.fn().mockResolvedValue(output));
            },
          }),
        })),
        {
          provide: APP_GUARD,
          useValue: new PermissionsGuard(new Reflector(), {} as never, {} as never),
        },
      ],
    });
    for (const controller of selected)
      for (const target of [
        controller,
        ...Object.getOwnPropertyNames(controller.prototype)
          .filter((name) => name !== 'constructor')
          .map((name) => controller.prototype[name]),
      ]) {
        for (const guard of Reflect.getMetadata(GUARDS_METADATA, target) ?? [])
          builder.overrideGuard(guard).useValue({ canActivate: () => true });
        for (const interceptor of Reflect.getMetadata(INTERCEPTORS_METADATA, target) ?? [])
          builder.overrideInterceptor(interceptor).useValue({
            intercept: (_context: unknown, next: { handle: () => unknown }) => next.handle(),
          });
      }
    app = (await builder.compile()).createNestApplication({ logger: false });
    app.use((req: Record<string, unknown>, _res: unknown, next: () => void) => {
      req.user = { id: actor, sub: actor };
      req.profile = {
        id: profileId,
        church_id: church,
        branch_id: id,
        role: 'church_admin',
        roles: ['church_admin'],
        is_admin_hq: false,
        permissions: allowed,
      };
      next();
    });
    await app.listen(0, '127.0.0.1');
    origin = await app.getUrl();
  });
  beforeEach(() => {
    allowed = [...allPermissions];
    for (const mock of mocks.values()) for (const method of Object.values(mock)) method.mockClear();
  });
  afterAll(async () => {
    await app?.close();
  });
  const send = async (contract: Contract) => {
    const response = await fetch(
      `${origin}${contract.path}?page=2&limit=10&churchId=forged&userId=forged&branchId=foreign&latitude=6.5&longitude=3.4&kind=who`,
      {
        method: contract.method,
        headers: {
          Authorization: 'Bearer synthetic-session',
          'Content-Type': 'application/json',
          'x-church-id': 'forged',
        },
        ...(contract.method === 'GET'
          ? {}
          : {
              body: JSON.stringify({
                name: 'Synthetic',
                note: 'Synthetic',
                changes: [],
                entityIds: [id],
                members: [],
                churchId: 'forged',
                userId: 'forged',
              }),
            }),
      },
    );
    const body = await response.text();
    return { status: response.status, body };
  };
  it.each(contracts)('$method $path keeps the trusted tenant and actor', async (contract) => {
    const result = await send(contract);
    expect(result.status).toBe(contract.status);
    const operation = mocks.get(contract.service)![contract.operation];
    expect(operation).toHaveBeenCalledTimes(1);
    expect(operation.mock.calls[0][contract.churchArg]).toBe(church);
    if (contract.profileArg !== undefined)
      expect(operation.mock.calls[0][contract.profileArg]).toBe(profileId);
    if (contract.actorArg !== undefined)
      expect(operation.mock.calls[0][contract.actorArg]).toBe(actor);
  });
  const protectedContracts = contracts.filter(
    ({ controller, handler }) =>
      Reflect.getMetadata(PERMISSIONS_KEY, controller.prototype[handler])?.length,
  );
  it.each(protectedContracts)(
    '$method $path denies missing grants before business work',
    async (contract) => {
      allowed = [];
      expect((await send(contract)).status).toBe(403);
      for (const mock of mocks.values())
        for (const method of Object.values(mock)) expect(method).not.toHaveBeenCalled();
    },
  );
});
