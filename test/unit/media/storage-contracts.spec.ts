import sharp from 'sharp';
import { ConfigService } from '@nestjs/config';
import { MediaService, MulterFile } from '../../../src/media/media.service';
import { BranchScopeService } from '../../../src/common/services/branch-scope.service';
import { RequestContextService } from '../../../src/common/services/request-context.service';
import { createPrismaMock } from '../../helpers/prisma-mock.helper';

describe('Managed media storage, byte validation and ownership', () => {
  const church = '11111111-1111-4111-8111-111111111111',
    branch = '22222222-2222-4222-8222-222222222222';
  const origin = 'https://synthetic.supabase.co';
  const viewer = {
    church_id: church,
    branch_id: branch,
    role: 'church_admin',
    is_admin_hq: true,
    permissions: [
      'media:upload:create',
      'media:library:read',
      'media:restricted:read',
      'church_settings:update',
      'branches:update',
    ],
  };
  const asset = {
    id: 'asset-a',
    church_id: church,
    branch_id: branch,
    folder: 'documents',
    permissions: 'members',
    filename: 'Synthetic "report".pdf',
    url: 'https://web.example.org/api/backend/media/files/asset-a',
    storage_bucket: 'private',
    storage_path: `documents/${church}/synthetic.pdf`,
    mime_type: 'application/pdf',
    size_bytes: 20,
    uploaded_by_user_id: 'owner',
    created_at: new Date('2026-01-01'),
  };
  let prisma: ReturnType<typeof createPrismaMock>, service: MediaService;
  const storage = {
    upload: jest.fn(),
    remove: jest.fn(),
    getPublicUrl: jest.fn(),
    createSignedUrl: jest.fn(),
    createSignedUploadUrl: jest.fn(),
    info: jest.fn(),
  };
  const provider = { from: jest.fn(), getBucket: jest.fn(), createBucket: jest.fn() };
  const audit = { log: jest.fn() };
  const file = (
    mimetype = 'application/pdf',
    buffer = Buffer.from('%PDF-1.4\nsynthetic'),
    originalname = 'report.pdf',
  ): MulterFile => ({ mimetype, buffer, size: buffer.length, originalname }) as MulterFile;
  beforeEach(() => {
    for (const mock of [...Object.values(storage), ...Object.values(provider), audit.log])
      mock.mockReset();
    storage.upload.mockResolvedValue({ error: null });
    storage.remove.mockResolvedValue({ error: null });
    storage.getPublicUrl.mockImplementation((path) => ({
      data: { publicUrl: `${origin}/storage/v1/object/public/media/${path}` },
    }));
    storage.createSignedUrl.mockResolvedValue({
      data: { signedUrl: 'https://storage.example.org/synthetic' },
    });
    storage.createSignedUploadUrl.mockResolvedValue({
      data: { signedUrl: 'https://storage.example.org/synthetic-upload' },
    });
    provider.from.mockReturnValue(storage);
    provider.getBucket.mockResolvedValue({ data: { public: false }, error: null });
    provider.createBucket.mockResolvedValue({ error: null });
    audit.log.mockResolvedValue(undefined);
    prisma = createPrismaMock();
    prisma.branch.findFirst.mockResolvedValue({ id: branch });
    prisma.mediaAsset.findFirst.mockResolvedValue(asset);
    prisma.mediaAsset.create.mockImplementation(({ data }) => Promise.resolve(data));
    prisma.mediaAsset.update.mockResolvedValue(asset);
    prisma.platformSubscription.findUnique.mockResolvedValue({
      plan: 'network',
      paid_until: new Date(Date.now() + 86400000),
    });
    service = new MediaService(
      { client: { storage: provider } } as never,
      new ConfigService({
        SUPABASE_URL: origin,
        SUPABASE_SERVICE_ROLE_KEY: 'synthetic-secret',
        SUPABASE_STORAGE_BUCKET: 'media',
        SUPABASE_PRIVATE_STORAGE_BUCKET: 'private',
        WEB_URL: 'https://web.example.org',
      }),
      prisma as never,
      audit as never,
      new BranchScopeService(new RequestContextService()),
    );
  });

  const signatures = [
    ['application/pdf', Buffer.from('%PDF-1.4')],
    ['text/csv', Buffer.from('name,value\nAda,1')],
    [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      Buffer.from('504b0304', 'hex'),
    ],
    ['application/vnd.ms-excel', Buffer.from('d0cf11e0a1b11ae1', 'hex')],
    ['audio/mpeg', Buffer.from('ID3synthetic')],
    ['audio/mpeg', Buffer.from('ffe0', 'hex')],
    ['audio/wav', Buffer.from('RIFF0000WAVE')],
    ['audio/ogg', Buffer.from('OggSsynthetic')],
    ['video/ogg', Buffer.from('OggSsynthetic')],
    ['audio/flac', Buffer.from('fLaCsynthetic')],
    ['audio/aac', Buffer.from('fff0', 'hex')],
    ['audio/mp4', Buffer.from('0000ftyp')],
    ['video/mp4', Buffer.from('0000ftyp')],
    ['video/quicktime', Buffer.from('0000moov')],
    ['video/webm', Buffer.from('1a45dfa3', 'hex')],
  ] as const;
  it.each(signatures)(
    'accepts a recognized %s signature and persists managed private storage',
    async (mimetype, buffer) => {
      const result = await service.uploadFile(
        file(mimetype, buffer),
        'documents',
        church,
        'owner',
        viewer,
        branch,
      );
      expect(result.contentType).toBe(mimetype);
      expect(result.size).toBe(buffer.length);
      expect(result.url).toBe(`https://web.example.org/api/backend/media/files/${result.assetId}`);
      expect(prisma.mediaAsset.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          church_id: church,
          branch_id: branch,
          storage_bucket: 'private',
          permissions: 'members',
          size_bytes: buffer.length,
          mime_type: mimetype,
          uploaded_by_user_id: 'owner',
        }),
      });
      expect(storage.upload).toHaveBeenCalledWith(
        expect.stringContaining(`/` + church + `/`),
        buffer,
        { contentType: mimetype, upsert: false },
      );
      expect(audit.log).toHaveBeenCalledTimes(1);
    },
  );
  it.each(signatures)('rejects bytes that contradict the declared %s type', async (mimetype) => {
    const bytes =
      mimetype === 'text/csv'
        ? Buffer.from('<script>alert(1)</script>')
        : Buffer.from('not a matching signature');
    await expect(
      service.uploadFile(file(mimetype, bytes), 'documents', church, 'owner', viewer),
    ).rejects.toThrow('does not match');
    expect(storage.upload).not.toHaveBeenCalled();
    expect(prisma.mediaAsset.create).not.toHaveBeenCalled();
  });
  it('rejects null bytes masquerading as CSV content', async () => {
    await expect(
      service.uploadFile(file('text/csv', Buffer.from([65, 0, 66])), 'documents', church),
    ).rejects.toThrow('does not match');
  });
  it.each(['../private', 'nested/folder', '', 'x'.repeat(81)])(
    'rejects unsafe folder names %j',
    async (folder) => {
      await expect(service.uploadFile(file(), folder, church)).rejects.toThrow(
        'simple folder name',
      );
      expect(storage.upload).not.toHaveBeenCalled();
    },
  );
  it.each(['churches', 'branches'])(
    'requires the purpose-specific branding grant for %s',
    async (folder) => {
      await expect(
        service.uploadFile(file(), folder, church, 'owner', { ...viewer, permissions: [] }),
      ).rejects.toThrow('permission');
    },
  );
  it('normalizes a filename without exposing local paths or control characters', async () => {
    await service.uploadFile(
      file(undefined, undefined, 'C:\\private\\report\u0000.pdf'),
      'documents',
      church,
      undefined,
      viewer,
    );
    expect(prisma.mediaAsset.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        filename: 'report.pdf',
        uploaded_by_user_id: null,
        branch_id: null,
      }),
    });
    expect(audit.log).not.toHaveBeenCalled();
  });
  it('assigns a generated filename when the client omitted it', async () => {
    await service.uploadFile(
      { ...file(), originalname: undefined } as never,
      'documents',
      church,
      undefined,
      viewer,
    );
    expect(prisma.mediaAsset.create.mock.calls[0][0].data.filename).toMatch(/\.pdf$/);
  });
  it('rejects foreign branches before storing private bytes', async () => {
    await expect(
      service.uploadFile(
        file(),
        'documents',
        church,
        'owner',
        { ...viewer, is_admin_hq: false },
        'foreign',
      ),
    ).rejects.toThrow('only upload to your branch');
    expect(storage.upload).not.toHaveBeenCalled();
    prisma.branch.findFirst.mockResolvedValue(null);
    await expect(
      service.uploadFile(file(), 'documents', church, 'owner', viewer, 'foreign'),
    ).rejects.toThrow('Invalid branch');
    expect(storage.upload).not.toHaveBeenCalled();
  });
  it('does not persist a library record when storage rejects the upload', async () => {
    storage.upload.mockResolvedValue({ error: { message: 'synthetic-private-provider-detail' } });
    await expect(service.uploadFile(file(), 'documents', church, 'owner', viewer)).rejects.toThrow(
      'Failed to upload file',
    );
    expect(prisma.mediaAsset.create).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });
  it('optimizes actual image bytes, bounds dimensions and strips embedded metadata', async () => {
    const bytes = await sharp({
      create: { width: 2000, height: 1000, channels: 3, background: '#336699' },
    })
      .withMetadata({ exif: { IFD0: { Artist: 'Synthetic private identity' } } })
      .png()
      .toBuffer();
    const result = await service.uploadFile(
      file('image/png', bytes),
      'profiles',
      church,
      'owner',
      viewer,
    );
    expect(result).toMatchObject({ width: 1200, height: 600, contentType: 'image/webp' });
    const uploaded = storage.upload.mock.calls[0][1] as Buffer;
    const metadata = await sharp(uploaded).metadata();
    expect(metadata.format).toBe('webp');
    expect(metadata.exif).toBeUndefined();
    expect(prisma.mediaAsset.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        permissions: 'public',
        storage_bucket: 'media',
        mime_type: 'image/webp',
      }),
    });
    expect(provider.getBucket).not.toHaveBeenCalled();
  });
  it('does not enlarge small images and keeps nonbranding images private', async () => {
    const bytes = await sharp({
      create: { width: 8, height: 4, channels: 3, background: '#336699' },
    })
      .png()
      .toBuffer();
    const result = await service.uploadImage(
      file('image/png', bytes),
      'documents',
      church,
      undefined,
      { ...viewer, is_admin_hq: false },
    );
    expect(result).toMatchObject({ width: 8, height: 4 });
    expect(prisma.mediaAsset.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ permissions: 'members', branch_id: branch }),
    });
    expect(audit.log).not.toHaveBeenCalled();
  });
  it.each([
    { data: { public: true }, error: null },
    { data: null, error: { statusCode: 500 } },
  ])('fails closed when private bucket confidentiality cannot be verified', async (result) => {
    provider.getBucket.mockResolvedValue(result);
    await expect(service.uploadFile(file(), 'documents', church)).rejects.toThrow();
    expect(storage.upload).not.toHaveBeenCalled();
  });
  it('creates a missing bucket as private and rechecks a concurrent creation failure', async () => {
    provider.getBucket
      .mockResolvedValueOnce({ error: { statusCode: '404' } })
      .mockResolvedValueOnce({ data: { public: false } });
    provider.createBucket.mockResolvedValue({ error: { statusCode: '409' } });
    await service.uploadFile(file(), 'documents', church);
    expect(provider.createBucket).toHaveBeenCalledWith('private', { public: false });
    expect(provider.getBucket).toHaveBeenCalledTimes(2);
    expect(storage.upload).toHaveBeenCalledTimes(1);
  });
  it('does not assume a concurrently created bucket is private', async () => {
    provider.getBucket
      .mockResolvedValueOnce({ error: { statusCode: 404 } })
      .mockResolvedValueOnce({ data: { public: true } });
    provider.createBucket.mockResolvedValue({ error: { statusCode: 409 } });
    await expect(service.uploadFile(file(), 'documents', church)).rejects.toThrow(
      'Private storage is unavailable',
    );
    expect(storage.upload).not.toHaveBeenCalled();
  });
  it('retries private-bucket verification after an earlier failure', async () => {
    provider.getBucket.mockResolvedValueOnce({ error: { statusCode: 500 } });
    await expect(service.uploadFile(file(), 'documents', church)).rejects.toThrow(
      'Unable to verify private storage',
    );
    await service.uploadFile(file(), 'documents', church);
    expect(provider.getBucket).toHaveBeenCalledTimes(2);
  });

  it.each(['get', 'delete', 'permissions'] as const)(
    'hides foreign-branch and leadership assets from unauthorized %s calls',
    async (action) => {
      const call = () =>
        action === 'get'
          ? service.getAsset(asset.id, church, { ...viewer, is_admin_hq: false, permissions: [] })
          : action === 'delete'
            ? service.deleteAsset(asset.id, church, 'other', {
                ...viewer,
                is_admin_hq: false,
                permissions: [],
              })
            : service.updatePermissions(asset.id, 'public', church, 'other', {
                ...viewer,
                is_admin_hq: false,
                permissions: [],
              });
      prisma.mediaAsset.findFirst.mockResolvedValue({ ...asset, branch_id: 'foreign' });
      await expect(call()).rejects.toThrow('not found');
      prisma.mediaAsset.findFirst.mockResolvedValue({ ...asset, permissions: 'leadership' });
      await expect(call()).rejects.toThrow('not found');
      expect(prisma.mediaAsset.update).not.toHaveBeenCalled();
      expect(prisma.mediaAsset.delete).not.toHaveBeenCalled();
    },
  );
  it.each(['delete', 'permissions'] as const)(
    'reserves shared asset %s to its owner or HQ',
    async (action) => {
      prisma.mediaAsset.findFirst.mockResolvedValue({ ...asset, branch_id: null });
      const limited = { ...viewer, is_admin_hq: false };
      const call = (user: string) =>
        action === 'delete'
          ? service.deleteAsset(asset.id, church, user, limited)
          : service.updatePermissions(asset.id, 'members', church, user, limited);
      await expect(call('other')).rejects.toThrow('Shared media can only');
      await call('owner');
      expect(audit.log).toHaveBeenCalledTimes(1);
    },
  );
  it('requires restricted access before promoting an asset to leadership visibility', async () => {
    await expect(
      service.updatePermissions(asset.id, 'leadership', church, 'owner', {
        ...viewer,
        permissions: [],
      }),
    ).rejects.toThrow('Restricted media permission');
    expect(prisma.mediaAsset.update).not.toHaveBeenCalled();
  });
  it('retains the library record when its byte deletion fails', async () => {
    storage.remove.mockResolvedValue({ error: { message: 'synthetic upstream detail' } });
    await expect(service.deleteAsset(asset.id, church, 'owner', viewer)).rejects.toThrow(
      'Unable to remove media bytes',
    );
    expect(prisma.mediaAsset.delete).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });
  it.each([
    'https://attacker.example.org/storage/v1/object/public/media/profiles/church/file.webp',
    `${origin}/wrong/path`,
    `${origin}/storage/v1/object/public/media/profiles//file.webp`,
    'not a URL',
  ])('does not delete bytes from unsafe public URL %s', async (url) => {
    await service.deleteByUrl(url);
    expect(storage.remove).not.toHaveBeenCalled();
  });
  it('only deletes obsolete branding URLs, preserving private library records', async () => {
    const url = `${origin}/storage/v1/object/public/media/profiles/${church}/old.webp`;
    prisma.mediaAsset.findFirst
      .mockResolvedValueOnce({ ...asset, folder: 'documents' })
      .mockResolvedValueOnce({ ...asset, folder: 'profiles' });
    await service.deleteByUrl(url);
    expect(storage.remove).not.toHaveBeenCalled();
    await service.deleteByUrl(url);
    expect(storage.remove).toHaveBeenCalledWith([`profiles/${church}/old.webp`]);
    expect(prisma.mediaAsset.delete).toHaveBeenCalledWith({ where: { id: asset.id } });
  });
  it.each([
    undefined,
    'uploads/foreign/file.pdf',
    `uploads/${church}/../file.pdf`,
    `uploads/${church}//file.pdf`,
  ])('rejects unscoped or traversing path deletion: %s', async (path) => {
    await expect(
      service.deleteFile(
        path ?? `uploads/${church}/file.pdf`,
        path ? church : undefined,
        'owner',
        viewer,
      ),
    ).rejects.toThrow('Invalid storage path');
    expect(storage.remove).not.toHaveBeenCalled();
  });
  describe('private file streaming permissions', () => {
    it.each(['missing', 'no-viewer', 'foreign', 'denied', 'restricted', 'no-path', 'no-bucket'])(
      'refuses private media bytes before provider traffic (%s)',
      async (scenario) => {
        prisma.mediaAsset.findFirst.mockResolvedValue(
          scenario === 'missing'
            ? null
            : {
                ...asset,
                ...(scenario === 'foreign' ? { branch_id: 'foreign' } : {}),
                ...(scenario === 'restricted' ? { permissions: 'leadership' } : {}),
                ...(scenario === 'no-path' ? { storage_path: null } : {}),
                ...(scenario === 'no-bucket' ? { storage_bucket: null } : {}),
              },
        );
        const scoped =
          scenario === 'no-viewer'
            ? undefined
            : {
                ...viewer,
                is_admin_hq: false,
                permissions: scenario === 'denied' ? [] : ['media:library:read'],
              };
        await expect(
          service.getFile(asset.id, church, scoped, undefined, 'other-user'),
        ).rejects.toThrow();
        expect(storage.createSignedUrl).not.toHaveBeenCalled();
      },
    );
    it.each(['assets', 'form-attachments', 'sermons'])(
      'permits %s media only through its module read grant',
      async (folder) => {
        prisma.mediaAsset.findFirst.mockResolvedValue({ ...asset, folder });
        const permissions = [
          folder === 'assets'
            ? 'assets:list:read'
            : folder === 'form-attachments'
              ? 'forms:submissions:read'
              : 'sermons:list:read',
        ];
        const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
          new Response('synthetic bytes', {
            status: 206,
            headers: { 'content-range': 'bytes 0-14/15', 'content-length': '15' },
          }),
        );
        const result = await service.getFile(
          asset.id,
          church,
          { ...viewer, permissions },
          'bytes=0-14',
          'other-user',
        );
        expect(result.status).toBe(206);
        expect(result.contentRange).toBe('bytes 0-14/15');
        expect(fetchMock).toHaveBeenCalledWith(
          'https://storage.example.org/synthetic',
          expect.objectContaining({ headers: { Range: 'bytes=0-14' }, redirect: 'error' }),
        );
        result.file.getStream().destroy();
      },
    );
    it.each([
      { data: null },
      { data: {}, error: null },
      { error: { message: 'provider failure' } },
    ])('sanitizes unusable provider download authorizations %j', async (response) => {
      storage.createSignedUrl.mockResolvedValue(response);
      const fetchMock = jest.spyOn(global, 'fetch');
      await expect(service.getFile(asset.id, church, viewer, undefined, 'owner')).rejects.toThrow(
        'Unable to retrieve media',
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });
    it.each([new Response(null, { status: 204 }), new Response('missing', { status: 404 })])(
      'refuses unavailable media byte responses',
      async (response) => {
        jest.spyOn(global, 'fetch').mockResolvedValue(response);
        await expect(
          service.getFile(asset.id, church, viewer, 'bytes=bad', 'owner'),
        ).rejects.toThrow('Media bytes are unavailable');
      },
    );
  });
});
