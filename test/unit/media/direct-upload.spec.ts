import { MediaService } from '../../../src/media/media.service';
import { createPrismaMock } from '../../helpers/prisma-mock.helper';
import { ViewerScope } from '../../../src/common/services/branch-scope.service';
import { assertPlanFeature } from '../../../src/billing/entitlements';
jest.mock('../../../src/billing/entitlements', () => ({ assertPlanFeature: jest.fn() }));

describe('direct media authorization and completion', () => {
  const churchId = 'church-a';
  const viewer = {
    church_id: churchId,
    branch_id: 'branch-a',
    is_admin_hq: true,
    permissions: ['sermons:update'],
  } as ViewerScope;
  let service: MediaService;
  let settings: Record<string, string>;
  const legacyKey = 'test-only-signing-key-'.repeat(2);
  let prisma: ReturnType<typeof createPrismaMock>;
  let storage: { createSignedUploadUrl: jest.Mock; info: jest.Mock };
  let audit: { log: jest.Mock };
  const input = {
    filename: 'Sunday Message.mp4',
    contentType: 'video/mp4',
    size: 8000000,
    folder: 'sermons',
    branchId: 'branch-a',
  };
  beforeEach(() => {
    settings = {};
    jest
      .mocked(assertPlanFeature)
      .mockReset()
      .mockResolvedValue(undefined as never);
    prisma = createPrismaMock();
    prisma.branch.findFirst.mockResolvedValue({ id: 'branch-a' });
    prisma.mediaAsset.findFirst.mockResolvedValue(null);
    prisma.mediaAsset.upsert.mockImplementation(({ create }) => Promise.resolve(create));
    storage = {
      createSignedUploadUrl: jest
        .fn()
        .mockResolvedValue({ data: { signedUrl: 'https://storage.example/signed' }, error: null }),
      info: jest.fn().mockResolvedValue({
        data: { size: input.size, contentType: input.contentType },
        error: null,
      }),
    };
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    service = new MediaService(
      {
        client: {
          storage: {
            from: () => storage,
            getBucket: jest.fn().mockResolvedValue({ data: { public: false } }),
          },
        },
      } as never,
      {
        get: (key: string, fallback: unknown) =>
          settings[key] ?? (key === 'WEB_URL' ? 'https://church.example' : fallback),
        getOrThrow: () => settings.SUPABASE_SERVICE_ROLE_KEY ?? legacyKey,
      } as never,
      prisma as never,
      audit as never,
      {
        resolve: (profile: ViewerScope) => ({
          churchOnly: !!profile.is_admin_hq,
          branchId: profile.branch_id,
        }),
      } as never,
    );
  });
  it('supports dedicated signing-key rotation without accepting the Supabase fallback indefinitely', async () => {
    const legacy = await service.prepareDirectUpload(input, churchId, 'user-a', viewer);
    settings.MEDIA_UPLOAD_SIGNING_KEY = 'new-upload-key-'.repeat(4);
    settings.MEDIA_UPLOAD_SIGNING_KEY_PREVIOUS_KEYS = JSON.stringify([legacyKey]);
    await expect(
      service.completeDirectUpload(legacy.ticket, churchId, 'user-a', viewer),
    ).resolves.toBeDefined();
    settings.MEDIA_UPLOAD_SIGNING_KEY_PREVIOUS_KEYS = '[]';
    storage.info.mockClear();
    await expect(
      service.completeDirectUpload(legacy.ticket, churchId, 'user-a', viewer),
    ).rejects.toThrow('Invalid upload authorization');
    expect(storage.info).not.toHaveBeenCalled();
    const current = await service.prepareDirectUpload(input, churchId, 'user-a', viewer);
    settings.SUPABASE_SERVICE_ROLE_KEY = 'rotated-provider-service-role';
    await expect(
      service.completeDirectUpload(current.ticket, churchId, 'user-a', viewer),
    ).resolves.toBeDefined();
  });

  it('verifies stored bytes before publishing a private library asset and is idempotent', async () => {
    const grant = await service.prepareDirectUpload(input, churchId, 'user-a', viewer);
    expect(prisma.mediaAsset.upsert).not.toHaveBeenCalled();
    const saved = await service.completeDirectUpload(grant.ticket, churchId, 'user-a', viewer);
    expect(saved.url).toBe(`https://church.example/api/backend/media/files/${saved.assetId}`);
    expect(prisma.mediaAsset.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          church_id: churchId,
          branch_id: 'branch-a',
          filename: input.filename,
          permissions: 'members',
          size_bytes: input.size,
        }),
      }),
    );
    prisma.mediaAsset.findFirst.mockResolvedValue({ id: saved.assetId, url: saved.url });
    await service.completeDirectUpload(grant.ticket, churchId, 'user-a', viewer);
    expect(prisma.mediaAsset.upsert).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledTimes(1);
  });
  it.each(['user', 'church', 'signature', 'branch', 'permission', 'expiry'])(
    'rejects changed %s authorization before reading storage',
    async (change) => {
      const grant = await service.prepareDirectUpload(input, churchId, 'user-a', viewer);
      if (change === 'expiry') jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * 3600000);
      try {
        await expect(
          service.completeDirectUpload(
            change === 'signature' ? grant.ticket + 'x' : grant.ticket,
            change === 'church' ? 'other-church' : churchId,
            change === 'user' ? 'other-user' : 'user-a',
            change === 'branch'
              ? { ...viewer, is_admin_hq: false, branch_id: 'branch-b' }
              : change === 'permission'
                ? { ...viewer, permissions: [] }
                : viewer,
          ),
        ).rejects.toThrow();
        expect(storage.info).not.toHaveBeenCalled();
        expect(prisma.mediaAsset.upsert).not.toHaveBeenCalled();
      } finally {
        jest.restoreAllMocks();
      }
    },
  );
  it.each(['size', 'contentType', 'missing'])('does not publish a %s mismatch', async (change) => {
    const grant = await service.prepareDirectUpload(input, churchId, 'user-a', viewer);
    storage.info.mockResolvedValue({
      data:
        change === 'missing'
          ? null
          : {
              size: change === 'size' ? 1 : input.size,
              contentType: change === 'contentType' ? 'text/html' : input.contentType,
            },
      error: null,
    });
    await expect(
      service.completeDirectUpload(grant.ticket, churchId, 'user-a', viewer),
    ).rejects.toThrow();
    expect(prisma.mediaAsset.upsert).not.toHaveBeenCalled();
  });
  it('checks plan entitlement again at completion', async () => {
    const grant = await service.prepareDirectUpload(input, churchId, 'user-a', viewer);
    jest.mocked(assertPlanFeature).mockRejectedValueOnce(new Error('Upgrade required'));
    await expect(
      service.completeDirectUpload(grant.ticket, churchId, 'user-a', viewer),
    ).rejects.toThrow('Upgrade required');
    expect(storage.info).not.toHaveBeenCalled();
  });
  it.each([
    { ...input, size: 51 * 1024 * 1024 },
    { ...input, contentType: 'text/html' },
    { ...input, folder: '../sermons' },
  ])('rejects unsupported uploads before signing', async (value) => {
    await expect(service.prepareDirectUpload(value, churchId, 'user-a', viewer)).rejects.toThrow();
    expect(storage.createSignedUploadUrl).not.toHaveBeenCalled();
  });
  it.each([
    { contentType: 'application/x-executable' },
    { size: 0 },
    { size: -1 },
    { size: 1.5 },
    { size: 52428801 },
    { filename: '   ' },
  ])('refuses an invalid presign request before storage authorization %j', async (override) => {
    await expect(
      service.prepareDirectUpload({ ...input, ...override }, churchId, 'user-a', viewer),
    ).rejects.toThrow();
    expect(storage.createSignedUploadUrl).not.toHaveBeenCalled();
  });
  it.each(['other', undefined])(
    'refuses cross-branch or unassigned staff uploads (%s)',
    async (branch_id) => {
      await expect(
        service.prepareDirectUpload(
          { ...input, branchId: branch_id ? 'branch-a' : undefined },
          churchId,
          'user-a',
          { ...viewer, is_admin_hq: false, branch_id },
        ),
      ).rejects.toThrow();
      expect(storage.createSignedUploadUrl).not.toHaveBeenCalled();
    },
  );
  it('uses the staff branch when its ID is omitted and validates that it remains active at completion', async () => {
    const scoped = { ...viewer, is_admin_hq: false };
    const grant = await service.prepareDirectUpload(
      { ...input, branchId: undefined },
      churchId,
      'user-a',
      scoped,
    );
    prisma.branch.findFirst.mockResolvedValue(null);
    await expect(
      service.completeDirectUpload(grant.ticket, churchId, 'user-a', scoped),
    ).rejects.toThrow('Invalid branch');
    expect(prisma.mediaAsset.upsert).not.toHaveBeenCalled();
    expect(storage.info).not.toHaveBeenCalled();
  });
  it('refuses presigning for a missing tenant-owned branch', async () => {
    prisma.branch.findFirst.mockResolvedValue(null);
    await expect(service.prepareDirectUpload(input, churchId, 'user-a', viewer)).rejects.toThrow(
      'Invalid branch',
    );
    expect(storage.createSignedUploadUrl).not.toHaveBeenCalled();
  });
  it.each([
    { data: null, error: null },
    { data: {}, error: null },
    { data: null, error: { message: 'private provider error' } },
  ])('refuses unusable storage authorization responses %j', async (response) => {
    storage.createSignedUploadUrl.mockResolvedValue(response);
    await expect(service.prepareDirectUpload(input, churchId, 'user-a', viewer)).rejects.toThrow(
      'Unable to authorize storage upload',
    );
    expect(prisma.mediaAsset.upsert).not.toHaveBeenCalled();
  });
  it.each([
    { size: input.size + 1, contentType: input.contentType },
    { size: input.size, contentType: 'application/pdf' },
    {},
  ])('refuses mismatched stored metadata before publishing an asset %j', async (data) => {
    const grant = await service.prepareDirectUpload(input, churchId, 'user-a', viewer);
    storage.info.mockResolvedValue({ data, error: null });
    await expect(
      service.completeDirectUpload(grant.ticket, churchId, 'user-a', viewer),
    ).rejects.toThrow('does not match');
    expect(prisma.mediaAsset.upsert).not.toHaveBeenCalled();
  });
  it('accepts the provider nested metadata response and an HQ upload without branch', async () => {
    const grant = await service.prepareDirectUpload(
      { ...input, branchId: undefined },
      churchId,
      'user-a',
      viewer,
    );
    storage.info.mockResolvedValue({
      data: { metadata: { size: input.size, mimetype: input.contentType } },
      error: null,
    });
    await service.completeDirectUpload(grant.ticket, churchId, 'user-a', viewer);
    expect(prisma.mediaAsset.upsert.mock.calls[0][0].create.branch_id).toBeNull();
  });
  it.each(['filename', 'size_bytes'])(
    'filters library access by branch and private-media permission with %s sort',
    async (sortBy) => {
      prisma.mediaAsset.findMany.mockResolvedValue([]);
      prisma.mediaAsset.count.mockResolvedValue(0);
      await service.listLibrary(
        {
          branchId: 'branch-a',
          folder: 'sermons',
          mimeType: 'video',
          search: 'Sunday',
          permissions: 'members',
          sortBy,
        },
        churchId,
        viewer,
      );
      const args = prisma.mediaAsset.findMany.mock.calls[0][0];
      expect(args.where).toMatchObject({
        church_id: churchId,
        folder: { contains: 'sermons', mode: 'insensitive' },
        mime_type: { contains: 'video', mode: 'insensitive' },
        filename: { contains: 'Sunday', mode: 'insensitive' },
        AND: [
          { OR: [{ branch_id: 'branch-a' }, { branch_id: null }] },
          { permissions: { not: 'leadership' } },
        ],
      });
      expect(args.orderBy).toEqual(
        sortBy === 'filename' ? { filename: 'asc' } : { size_bytes: 'desc' },
      );
    },
  );
});
