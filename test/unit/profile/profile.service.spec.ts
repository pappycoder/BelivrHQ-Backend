import { AccountEmailService } from '../../../src/company-email/account-email.service';
import {
  StaffInvitationService,
  StaffInvitationInput,
} from '../../../src/company-email/staff-invitation.service';
import { RequestContextService } from '../../../src/common/services/request-context.service';
/**
 * @file profile.service.spec.ts
 * @description Unit tests for ProfileService.
 *
 * Tests profile CRUD, photo upload, role management, and listing.
 * All external dependencies (Prisma, MediaService, AuditLogging) are mocked.
 *
 * @module test/unit/profile/profile.service.spec
 * @since 1.0.0
 */

import { validate } from 'class-validator';
import { InviteUserDto } from '../../../src/profile/dto/invite-user.dto';
import { InviteStaffDto } from '../../../src/church/dto/invite-staff.dto';
import { ProfileService } from '../../../src/profile/profile.service';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { AuditLoggingService } from '../../../src/common/services/audit-logging.service';
import { BranchScopeService } from '../../../src/common/services/branch-scope.service';
import { MediaService, MulterFile } from '../../../src/media/media.service';
import { SupabaseService } from '../../../src/supabase/supabase.service';
import { PermissionsService } from '../../../src/auth/services/permissions.service';
import {
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';

describe('ProfileService', () => {
  let service: ProfileService;
  let accountEmails: { sendPasswordReset: jest.Mock };
  let staffInvitations: { create: jest.Mock };
  let prisma: Record<string, unknown> & { $transaction: jest.Mock };
  let audit: { log: jest.Mock };
  let mediaService: { uploadImage: jest.Mock; deleteByUrl: jest.Mock };
  let supabase: {
    client: {
      auth: {
        admin: {
          inviteUserByEmail: jest.Mock;
          updateUserById: jest.Mock;
          getUserById: jest.Mock;
          generateLink: jest.Mock;
          signOut: jest.Mock;
          deleteUser: jest.Mock;
        };
      };
    };
  };
  let permissionsService: {
    getRolePermissions: jest.Mock;
    getAllPermissions: jest.Mock;
    getUserPermissions: jest.Mock;
  };

  it.each([InviteUserDto, InviteStaffDto])(
    'accepts custom church roles and rejects platform roles in %p',
    async (Dto) => {
      const input = { email: 'invite@example.com', firstName: 'Test', lastName: 'User' };
      expect(await validate(Object.assign(new Dto(), input, { role: 'media_team' }))).toEqual([]);
      for (const role of ['member', 'super_admin']) {
        expect(await validate(Object.assign(new Dto(), input, { role }))).toEqual(
          expect.arrayContaining([expect.objectContaining({ property: 'role' })]),
        );
      }
    },
  );

  const mockUserId = '11111111-1111-1111-1111-111111111111';
  const mockChurchId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const mockProfileId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const mockAdminUserId = '22222222-2222-2222-2222-222222222222';

  function createPrismaMock() {
    const models: Record<string, Record<string, jest.Mock>> = {};
    const $transactionMock = jest.fn();

    const handler: ProxyHandler<Record<string, unknown>> = {
      get(_target, prop: string) {
        if (prop === '$transaction') {
          return $transactionMock;
        }
        if (!models[prop]) {
          models[prop] = {
            findMany: jest.fn(),
            findUnique: jest.fn(),
            findFirst: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
            updateMany: jest.fn(),
            delete: jest.fn(),
            deleteMany: jest.fn(),
            count: jest.fn(),
          };
        }
        return models[prop];
      },
    };

    return new Proxy(
      { $transaction: $transactionMock } as Record<string, unknown>,
      handler,
    ) as Record<string, unknown> & { $transaction: jest.Mock };
  }

  function model(prismaMock: Record<string, unknown>, name: string): Record<string, jest.Mock> {
    return prismaMock[name] as Record<string, jest.Mock>;
  }

  beforeEach(() => {
    prisma = createPrismaMock();
    model(prisma, 'platformSubscription').findUnique.mockResolvedValue({
      plan: 'network',
      paid_until: new Date('2099-01-01'),
    });
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    mediaService = {
      uploadImage: jest.fn(),
      deleteByUrl: jest.fn().mockResolvedValue(undefined),
    };
    supabase = {
      client: {
        auth: {
          admin: {
            inviteUserByEmail: jest.fn(),
            updateUserById: jest.fn(),
            getUserById: jest.fn(),
            generateLink: jest.fn(),
            signOut: jest.fn(),
            deleteUser: jest.fn().mockResolvedValue({ error: null }),
          },
        },
      },
    };
    permissionsService = {
      getRolePermissions: jest.fn().mockRejectedValue(new Error('Role not found')),
      getAllPermissions: jest.fn().mockResolvedValue([]),
      getUserPermissions: jest.fn().mockResolvedValue([]),
    };

    model(prisma, 'role').findFirst.mockResolvedValue({ name: 'cell_leader' });
    // Echo requested role names back as valid roles by default
    model(prisma, 'role').findMany.mockImplementation(
      ({ where }: { where?: { name?: { in?: string[] } } }) =>
        Promise.resolve((where?.name?.in ?? []).map((name: string) => ({ name }))),
    );
    supabase.client.auth.admin.getUserById.mockResolvedValue({
      data: { user: { last_sign_in_at: '2026-08-20T09:12:00.000Z' } },
      error: null,
    });

    staffInvitations = {
      create: jest.fn(async (input: StaffInvitationInput) =>
        model(prisma, 'profile').create({
          data: {
            user_id: 'new-user',
            church_id: input.churchId,
            branch_id: input.branchId || null,
            role: [input.role],
            is_admin_hq: input.role === 'church_admin',
            first_name: input.firstName,
            last_name: input.lastName,
            email: input.email,
            phone: input.phone || null,
          },
        }),
      ),
    };
    accountEmails = { sendPasswordReset: jest.fn().mockResolvedValue(undefined) };
    service = new ProfileService(
      prisma as unknown as PrismaService,
      new RequestContextService(),
      audit as unknown as AuditLoggingService,
      mediaService as unknown as MediaService,
      supabase as unknown as SupabaseService,
      permissionsService as unknown as PermissionsService,
      new BranchScopeService(new RequestContextService()),
      staffInvitations as unknown as StaffInvitationService,
      accountEmails as unknown as AccountEmailService,
    );
  });

  const mockProfileWithRelations = {
    id: mockProfileId,
    user_id: mockUserId,
    church_id: mockChurchId,
    branch_id: 'branch-1',
    role: ['church_admin'],
    first_name: 'Adebayo',
    last_name: 'Ogundimu',
    email: 'pastor@demo.com',
    phone: '+234 803 456 7890',
    avatar_url: null,
    mfa_enabled: false,
    two_factor_enabled: false,
    archived_at: null,
    created_at: new Date('2026-07-15T10:00:00.000Z'),
    updated_at: new Date('2026-07-19T14:30:00.000Z'),
    assigned_roles: [{ role_name: 'church_admin' }],
    member: null,
    church: {
      id: mockChurchId,
      name: 'Grace Community Church',
      denomination: 'Pentecostal',
      logo_url: null,
    },
    branch: {
      id: 'branch-1',
      name: 'Headquarters',
      is_headquarters: true,
    },
  };

  // ─── GET MY PROFILE ────────────────────────────────────────────────

  describe('getMyProfile', () => {
    it('should return profile with church and branch details', async () => {
      model(prisma, 'profile').findUnique.mockResolvedValue(mockProfileWithRelations);

      const result = await service.getMyProfile(mockUserId);

      expect(result.profileId).toBe(mockProfileId);
      expect(result.userId).toBe(mockUserId);
      expect(result.churchId).toBe(mockChurchId);
      expect(result.role).toEqual(['church_admin']);
      expect(result.firstName).toBe('Adebayo');
      expect(result.church?.name).toBe('Grace Community Church');
      expect(result.branch?.name).toBe('Headquarters');
      expect(result.createdAt).toBe('2026-07-15T10:00:00.000Z');
    });

    it('should include the resolved permission union on /me', async () => {
      model(prisma, 'profile').findUnique.mockResolvedValue(mockProfileWithRelations);
      permissionsService.getUserPermissions.mockResolvedValue([
        'members:read',
        'members:create',
        'branches:read',
      ]);

      const result = await service.getMyProfile(mockUserId);

      expect(permissionsService.getUserPermissions).toHaveBeenCalledWith(
        mockChurchId,
        ['church_admin'],
        undefined,
      );
      expect(result.permissions).toEqual(['members:read', 'members:create', 'branches:read']);
    });

    it('should soft-fail to empty permissions when resolution errors', async () => {
      model(prisma, 'profile').findUnique.mockResolvedValue(mockProfileWithRelations);
      permissionsService.getUserPermissions.mockRejectedValue(new Error('redis down'));

      const result = await service.getMyProfile(mockUserId);

      expect(result.permissions).toEqual([]);
    });

    it('should throw NotFoundException if profile does not exist', async () => {
      model(prisma, 'profile').findUnique.mockResolvedValue(null);

      await expect(service.getMyProfile('nonexistent-user')).rejects.toThrow(NotFoundException);
    });

    it('should hydrate a missing email from Supabase Auth and persist it', async () => {
      supabase.client.auth.admin.getUserById.mockResolvedValueOnce({
        data: { user: { email: 'hydrated@demo.com' } },
        error: null,
      });
      model(prisma, 'profile').findUnique.mockResolvedValue({
        ...mockProfileWithRelations,
        email: null,
      });

      const result = await service.getMyProfile(mockUserId);

      expect(result.email).toBe('hydrated@demo.com');
      expect(supabase.client.auth.admin.getUserById).toHaveBeenCalledWith(mockUserId);
      expect(model(prisma, 'profile').update).toHaveBeenCalledWith({
        where: { id: mockProfileId },
        data: { email: 'hydrated@demo.com' },
      });
    });

    it('should handle profile without branch', async () => {
      const profileWithoutBranch = {
        ...mockProfileWithRelations,
        branch_id: null,
        branch: null,
        phone: null,
      };

      model(prisma, 'profile').findUnique.mockResolvedValue(profileWithoutBranch);

      const result = await service.getMyProfile(mockUserId);

      expect(result.branchId).toBeUndefined();
      expect(result.branch).toBeUndefined();
      expect(result.phone).toBeUndefined();
    });

    it('should handle profile with avatar', async () => {
      const profileWithAvatar = {
        ...mockProfileWithRelations,
        avatar_url: 'https://example.com/avatar.webp',
      };

      model(prisma, 'profile').findUnique.mockResolvedValue(profileWithAvatar);

      const result = await service.getMyProfile(mockUserId);

      expect(result.avatarUrl).toBe('https://example.com/avatar.webp');
    });

    it('should emit the linked memberId when the profile is linked to a member', async () => {
      const profileWithMember = {
        ...mockProfileWithRelations,
        member_id: 'member-uuid',
      };

      model(prisma, 'profile').findUnique.mockResolvedValue(profileWithMember);

      const result = await service.getMyProfile(mockUserId);

      expect(result.memberId).toBe('member-uuid');
    });

    it('should leave memberId undefined when no member is linked', async () => {
      model(prisma, 'profile').findUnique.mockResolvedValue({
        ...mockProfileWithRelations,
        member_id: null,
      });

      const result = await service.getMyProfile(mockUserId);

      expect(result.memberId).toBeUndefined();
    });
  });

  // ─── UPDATE MY PROFILE ─────────────────────────────────────────────

  describe('updateMyProfile', () => {
    it('should update profile fields successfully', async () => {
      model(prisma, 'profile')
        .findUnique.mockResolvedValueOnce({
          id: mockProfileId,
          user_id: mockUserId,
          church_id: mockChurchId,
        })
        .mockResolvedValueOnce(mockProfileWithRelations);

      model(prisma, 'profile').update.mockResolvedValue({});

      const result = await service.updateMyProfile(mockUserId, {
        lastName: 'Updated',
        phone: '+2348000000000',
      });

      expect(result.lastName).toBe('Ogundimu');
      expect(model(prisma, 'profile').update).toHaveBeenCalledWith({
        where: { user_id: mockUserId },
        data: { last_name: 'Updated', phone: '+2348000000000' },
      });
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: mockUserId,
          entity: 'profile',
          action: 'UPDATE',
        }),
      );
    });

    it('should throw NotFoundException if profile does not exist', async () => {
      model(prisma, 'profile').findUnique.mockResolvedValue(null);

      await expect(service.updateMyProfile(mockUserId, { firstName: 'Test' })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should return existing profile if no fields provided', async () => {
      model(prisma, 'profile').findUnique.mockResolvedValue(mockProfileWithRelations);

      const result = await service.updateMyProfile(mockUserId, {});

      expect(result.firstName).toBe('Adebayo');
      expect(model(prisma, 'profile').update).not.toHaveBeenCalled();
    });

    it('should never touch Supabase Auth — email is managed via church settings', async () => {
      model(prisma, 'profile')
        .findUnique.mockResolvedValueOnce({
          id: mockProfileId,
          user_id: mockUserId,
          church_id: mockChurchId,
          email: 'old@demo.com',
        })
        .mockResolvedValueOnce(mockProfileWithRelations);

      await service.updateMyProfile(mockUserId, { firstName: 'NewName' });

      expect(supabase.client.auth.admin.updateUserById).not.toHaveBeenCalled();
      expect(model(prisma, 'profile').update).toHaveBeenCalledWith({
        where: { user_id: mockUserId },
        data: { first_name: 'NewName' },
      });
    });
  });

  // ─── UPLOAD PROFILE PHOTO ──────────────────────────────────────────

  describe('uploadProfilePhoto', () => {
    it('should upload photo and update avatar_url', async () => {
      model(prisma, 'profile')
        .findUnique.mockResolvedValueOnce({
          id: mockProfileId,
          user_id: mockUserId,
          church_id: mockChurchId,
          avatar_url: null,
        })
        .mockResolvedValueOnce({
          ...mockProfileWithRelations,
          avatar_url: 'https://example.com/avatar.webp',
        });

      model(prisma, 'profile').update.mockResolvedValue({});

      mediaService.uploadImage.mockResolvedValue({
        url: 'https://example.com/avatar.webp',
        path: 'profiles/church/avatar.webp',
        size: 45000,
        contentType: 'image/webp',
      });

      const mockFile: MulterFile = {
        fieldname: 'file',
        originalname: 'avatar.jpg',
        encoding: '7bit',
        mimetype: 'image/jpeg',
        size: 100000,
        buffer: Buffer.from('fake-image'),
      };

      const result = await service.uploadProfilePhoto(mockUserId, mockFile, mockChurchId);

      expect(result.avatarUrl).toBe('https://example.com/avatar.webp');
      expect(mediaService.uploadImage).toHaveBeenCalledWith(mockFile, 'profiles', mockChurchId);
      expect(model(prisma, 'profile').update).toHaveBeenCalledWith({
        where: { user_id: mockUserId },
        data: { avatar_url: 'https://example.com/avatar.webp' },
      });
    });

    it('should delete old avatar before uploading new one', async () => {
      model(prisma, 'profile')
        .findUnique.mockResolvedValueOnce({
          id: mockProfileId,
          user_id: mockUserId,
          church_id: mockChurchId,
          avatar_url: 'https://example.com/old-avatar.webp',
        })
        .mockResolvedValueOnce({
          ...mockProfileWithRelations,
          avatar_url: 'https://example.com/new-avatar.webp',
        });

      model(prisma, 'profile').update.mockResolvedValue({});

      mediaService.uploadImage.mockResolvedValue({
        url: 'https://example.com/new-avatar.webp',
        path: 'profiles/church/new-avatar.webp',
        size: 45000,
        contentType: 'image/webp',
      });

      const mockFile: MulterFile = {
        fieldname: 'file',
        originalname: 'avatar.jpg',
        encoding: '7bit',
        mimetype: 'image/jpeg',
        size: 100000,
        buffer: Buffer.from('fake-image'),
      };

      await service.uploadProfilePhoto(mockUserId, mockFile, mockChurchId);

      expect(mediaService.deleteByUrl).toHaveBeenCalledWith('https://example.com/old-avatar.webp');
    });

    it('should throw NotFoundException if profile does not exist', async () => {
      model(prisma, 'profile').findUnique.mockResolvedValue(null);

      const mockFile: MulterFile = {
        fieldname: 'file',
        originalname: 'avatar.jpg',
        encoding: '7bit',
        mimetype: 'image/jpeg',
        size: 100000,
        buffer: Buffer.from('fake-image'),
      };

      await expect(service.uploadProfilePhoto(mockUserId, mockFile, mockChurchId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ─── LIST PROFILES ─────────────────────────────────────────────────

  // Authenticator lifecycle coverage lives in authenticator.service.spec.ts.

  describe('administrator password recovery', () => {
    beforeEach(() => {
      model(prisma, 'profile').findFirst.mockResolvedValue({
        id: mockProfileId,
        user_id: mockUserId,
      });
      supabase.client.auth.admin.getUserById.mockResolvedValue({
        data: { user: { email: 'staff@example.org' } },
        error: null,
      });
    });
    it('uses the same branded sender as public recovery and records success', async () => {
      await expect(
        service.resetUserPassword(mockProfileId, mockChurchId, mockAdminUserId),
      ).resolves.toEqual({ resetSent: true });
      expect(accountEmails.sendPasswordReset).toHaveBeenCalledWith('staff@example.org');
      expect(audit.log).toHaveBeenCalled();
    });
    it('does not report success or audit delivery when sending fails', async () => {
      accountEmails.sendPasswordReset.mockRejectedValue(new Error('mail unavailable'));
      await expect(
        service.resetUserPassword(mockProfileId, mockChurchId, mockAdminUserId),
      ).rejects.toThrow();
      expect(audit.log).not.toHaveBeenCalled();
    });
    it('does not send for profiles outside the caller scope', async () => {
      model(prisma, 'profile').findFirst.mockResolvedValue(null);
      await expect(
        service.resetUserPassword(mockProfileId, mockChurchId, mockAdminUserId),
      ).rejects.toThrow(NotFoundException);
      expect(accountEmails.sendPasswordReset).not.toHaveBeenCalled();
    });
  });

  describe('listProfiles', () => {
    it('should return paginated profiles', async () => {
      model(prisma, 'profile').findMany.mockResolvedValue([mockProfileWithRelations]);
      model(prisma, 'profile').count.mockResolvedValue(1);

      const result = await service.listProfiles(mockChurchId, {});

      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.data[0].profileId).toBe(mockProfileId);
    });

    it('should apply search filter', async () => {
      model(prisma, 'profile').findMany.mockResolvedValue([]);
      model(prisma, 'profile').count.mockResolvedValue(0);

      await service.listProfiles(mockChurchId, { search: 'Adebayo' });

      expect(model(prisma, 'profile').findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.arrayContaining([
              expect.objectContaining({
                first_name: expect.objectContaining({ contains: 'Adebayo' }),
              }),
            ]),
          }),
        }),
      );
    });

    it('should apply role filter', async () => {
      model(prisma, 'profile').findMany.mockResolvedValue([]);
      model(prisma, 'profile').count.mockResolvedValue(0);

      await service.listProfiles(mockChurchId, { role: 'church_admin' });

      expect(model(prisma, 'profile').findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ role: { has: 'church_admin' } }),
        }),
      );
    });

    it('should apply branch filter', async () => {
      model(prisma, 'profile').findMany.mockResolvedValue([]);
      model(prisma, 'profile').count.mockResolvedValue(0);

      await service.listProfiles(mockChurchId, { branchId: 'branch-1' });

      expect(model(prisma, 'profile').findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ branch_id: 'branch-1' }),
        }),
      );
    });

    it('should use default pagination', async () => {
      model(prisma, 'profile').findMany.mockResolvedValue([]);
      model(prisma, 'profile').count.mockResolvedValue(0);

      await service.listProfiles(mockChurchId, {});

      expect(model(prisma, 'profile').findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 0,
          take: 20,
        }),
      );
    });

    it('should exclude archived profiles by default', async () => {
      model(prisma, 'profile').findMany.mockResolvedValue([]);
      model(prisma, 'profile').count.mockResolvedValue(0);

      await service.listProfiles(mockChurchId, {});

      expect(model(prisma, 'profile').findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ archived_at: null }),
        }),
      );
    });

    it('should list only archived profiles when archived=true', async () => {
      model(prisma, 'profile').findMany.mockResolvedValue([
        { ...mockProfileWithRelations, archived_at: new Date('2026-08-28T10:00:00.000Z') },
      ]);
      model(prisma, 'profile').count.mockResolvedValue(1);

      const result = await service.listProfiles(mockChurchId, { archived: true });

      expect(model(prisma, 'profile').findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ archived_at: { not: null } }),
        }),
      );
      expect(result.data[0].archivedAt).toBe('2026-08-28T10:00:00.000Z');
    });
  });

  // ─── GET PROFILE BY ID ─────────────────────────────────────────────

  describe('getProfileById', () => {
    it('should return profile by ID', async () => {
      model(prisma, 'profile').findUnique.mockResolvedValue(mockProfileWithRelations);

      const result = await service.getProfileById(mockProfileId, mockChurchId);

      expect(result.profileId).toBe(mockProfileId);
    });

    it('should throw NotFoundException if profile does not exist', async () => {
      model(prisma, 'profile').findUnique.mockResolvedValue(null);

      await expect(service.getProfileById('nonexistent', mockChurchId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException if profile belongs to another church', async () => {
      model(prisma, 'profile').findUnique.mockResolvedValue({
        ...mockProfileWithRelations,
        church_id: 'other-church-id',
      });

      await expect(service.getProfileById(mockProfileId, mockChurchId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ─── UPDATE PROFILE ROLE ───────────────────────────────────────────

  describe('updateProfileRole', () => {
    it('should update role successfully', async () => {
      model(prisma, 'profile')
        .findUnique.mockResolvedValueOnce({
          id: mockProfileId,
          user_id: mockUserId,
          church_id: mockChurchId,
          role: ['cell_leader'],
          assigned_roles: [],
        })
        .mockResolvedValueOnce({
          ...mockProfileWithRelations,
          role: ['branch_pastor'],
        });

      model(prisma, 'profile').update.mockResolvedValue({});

      const result = await service.updateProfileRole(
        mockProfileId,
        { role: 'branch_pastor' },
        mockChurchId,
        mockAdminUserId,
        'church_admin',
      );

      expect(result.role).toEqual(['branch_pastor']);
      expect(model(prisma, 'profile').update).toHaveBeenCalledWith({
        where: { id: mockProfileId },
        data: { role: ['branch_pastor'] },
      });
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: mockAdminUserId,
          entity: 'profile',
          action: 'UPDATE',
        }),
      );
    });

    it('should throw NotFoundException if profile does not exist', async () => {
      model(prisma, 'profile').findUnique.mockResolvedValue(null);

      await expect(
        service.updateProfileRole(
          mockProfileId,
          { role: 'cell_leader' },
          mockChurchId,
          mockAdminUserId,
          'church_admin',
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException when modifying super_admin', async () => {
      model(prisma, 'profile').findUnique.mockResolvedValue({
        id: mockProfileId,
        user_id: mockUserId,
        church_id: mockChurchId,
        role: 'super_admin',
        assigned_roles: [],
      });

      await expect(
        service.updateProfileRole(
          mockProfileId,
          { role: 'cell_leader' },
          mockChurchId,
          mockAdminUserId,
          'church_admin',
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw ForbiddenException when trying to self-demotion', async () => {
      model(prisma, 'profile').findUnique.mockResolvedValue({
        id: mockProfileId,
        user_id: mockAdminUserId,
        church_id: mockChurchId,
        role: 'church_admin',
        assigned_roles: [],
      });

      await expect(
        service.updateProfileRole(
          mockProfileId,
          { role: 'cell_leader' },
          mockChurchId,
          mockAdminUserId,
          'church_admin',
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw ForbiddenException when a church_admin tries to assign super_admin', async () => {
      model(prisma, 'profile').findUnique.mockResolvedValue({
        id: mockProfileId,
        user_id: mockUserId,
        church_id: mockChurchId,
        role: 'cell_leader',
        assigned_roles: [],
      });

      await expect(
        service.updateProfileRole(
          mockProfileId,
          { role: 'super_admin' },
          mockChurchId,
          mockAdminUserId,
          'church_admin',
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw ForbiddenException when assigning a role above own rank', async () => {
      model(prisma, 'profile').findUnique.mockResolvedValue({
        id: mockProfileId,
        user_id: mockUserId,
        church_id: mockChurchId,
        role: 'cell_leader',
        assigned_roles: [],
      });

      await expect(
        service.updateProfileRole(
          mockProfileId,
          { role: 'senior_pastor' },
          mockChurchId,
          mockAdminUserId,
          'branch_pastor',
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should allow super_admin to assign the super_admin role', async () => {
      model(prisma, 'profile')
        .findUnique.mockResolvedValueOnce({
          id: mockProfileId,
          user_id: mockUserId,
          church_id: mockChurchId,
          role: ['cell_leader'],
          assigned_roles: [],
        })
        .mockResolvedValueOnce({
          ...mockProfileWithRelations,
          role: ['super_admin'],
        });

      model(prisma, 'profile').update.mockResolvedValue({});

      const result = await service.updateProfileRole(
        mockProfileId,
        { role: 'super_admin' },
        mockChurchId,
        mockAdminUserId,
        'super_admin',
      );

      expect(result.role).toEqual(['super_admin']);
    });
  });

  // ─── UPDATE PROFILE ROLES (MULTI-ROLE) ─────────────────────────────

  describe('updateProfileRoles', () => {
    const baseProfile = {
      id: mockProfileId,
      user_id: mockUserId,
      church_id: mockChurchId,
      branch_id: null,
      role: ['cell_leader'],
      status: 'active',
      first_name: 'Adebayo',
      last_name: 'Ogundimu',
      email: null,
      phone: null,
      avatar_url: null,
      mfa_enabled: false,
      created_at: new Date('2026-07-15T10:00:00.000Z'),
      updated_at: new Date('2026-07-19T14:30:00.000Z'),
    };

    it('orders department_head above cell_leader when both roles are assigned', async () => {
      model(prisma, 'profile').findUnique.mockResolvedValue({ ...baseProfile });
      jest.spyOn(service, 'getProfileById').mockResolvedValue({} as never);
      await service.updateProfileRoles(
        mockProfileId,
        { roles: ['cell_leader', 'department_head'] },
        mockChurchId,
        mockAdminUserId,
        'church_admin',
      );
      expect(model(prisma, 'profile').update).toHaveBeenCalledWith({
        where: { id: mockProfileId },
        data: { role: ['department_head', 'cell_leader'] },
      });
    });

    it('should assign multiple roles ordered by rank descending', async () => {
      model(prisma, 'profile')
        .findUnique.mockResolvedValueOnce({ ...baseProfile })
        .mockResolvedValueOnce({ ...baseProfile, role: ['church_admin', 'treasurer'] });

      const result = await service.updateProfileRoles(
        mockProfileId,
        { roles: ['treasurer', 'church_admin'] },
        mockChurchId,
        mockAdminUserId,
        'super_admin',
      );

      expect(model(prisma, 'profile').update).toHaveBeenCalledWith({
        where: { id: mockProfileId },
        data: { role: ['church_admin', 'treasurer'], is_admin_hq: true },
      });
      expect(result.role).toEqual(['church_admin', 'treasurer']);
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          oldValues: { roles: ['cell_leader'] },
          newValues: { roles: ['church_admin', 'treasurer'] },
        }),
      );
    });

    it('should reject unknown role names with BadRequestException', async () => {
      model(prisma, 'profile').findUnique.mockResolvedValue({ ...baseProfile });
      model(prisma, 'role').findMany.mockResolvedValueOnce([]);

      await expect(
        service.updateProfileRoles(
          mockProfileId,
          { roles: ['space_wizard'] },
          mockChurchId,
          mockAdminUserId,
          'church_admin',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('allows a Church Admin to assign Senior Pastor on Essentials', async () => {
      model(prisma, 'platformSubscription').findUnique.mockResolvedValue({
        plan: 'essentials',
        paid_until: new Date('2099-01-01'),
      });
      model(prisma, 'profile').findUnique.mockResolvedValue({ ...baseProfile });
      await service.updateProfileRoles(
        mockProfileId,
        { roles: ['senior_pastor'] },
        mockChurchId,
        mockAdminUserId,
        'church_admin',
      );
      expect(model(prisma, 'profile').update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ role: ['senior_pastor'] }) }),
      );
    });

    it('should reject roles above the caller rank', async () => {
      model(prisma, 'profile').findUnique.mockResolvedValue({ ...baseProfile });

      await expect(
        service.updateProfileRoles(
          mockProfileId,
          { roles: ['senior_pastor'] },
          mockChurchId,
          mockAdminUserId,
          'branch_pastor',
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should block self role changes but allow no-op self updates', async () => {
      const selfProfile = { ...baseProfile, user_id: mockAdminUserId, role: ['secretary'] };
      model(prisma, 'profile').findUnique.mockResolvedValue({ ...selfProfile });

      await expect(
        service.updateProfileRoles(
          mockProfileId,
          { roles: ['cell_leader'] },
          mockChurchId,
          mockAdminUserId,
          'super_admin',
        ),
      ).rejects.toThrow(ForbiddenException);

      await expect(
        service.updateProfileRoles(
          mockProfileId,
          { roles: ['secretary'] },
          mockChurchId,
          mockAdminUserId,
          'super_admin',
        ),
      ).resolves.toBeDefined();
    });
  });

  // ─── ADMIN UPDATE USER ─────────────────────────────────────────────

  describe('adminUpdateProfile', () => {
    const baseProfile = {
      id: mockProfileId,
      user_id: mockUserId,
      church_id: mockChurchId,
      branch_id: null,
      role: ['secretary'],
      status: 'active',
      first_name: 'Adebayo',
      last_name: 'Ogundimu',
      email: 'adebayo@church.com',
      phone: '+234 803 456 7890',
      avatar_url: null,
      mfa_enabled: false,
      created_at: new Date('2026-07-15T10:00:00.000Z'),
      updated_at: new Date('2026-07-19T14:30:00.000Z'),
    };

    it('does not re-enable HQ on a no-op administrator role update', async () => {
      model(prisma, 'profile').findUnique.mockResolvedValue({
        ...baseProfile,
        role: ['church_admin'],
        is_admin_hq: false,
      });
      jest.spyOn(service, 'getProfileById').mockResolvedValue({} as never);
      await service.updateProfileRoles(
        mockProfileId,
        { roles: ['church_admin'] },
        mockChurchId,
        mockAdminUserId,
        'church_admin',
      );
      expect(model(prisma, 'profile').update).toHaveBeenCalledWith({
        where: { id: mockProfileId },
        data: { role: ['church_admin'] },
      });
    });

    it('rejects invitations that grant more permissions than the caller', async () => {
      permissionsService.getUserPermissions.mockResolvedValue(['church_settings:update']);
      const context = new RequestContextService();
      await expect(
        context.run(
          {
            userId: mockAdminUserId,
            churchId: mockChurchId,
            role: 'custom_editor',
            viewer: {
              church_id: mockChurchId,
              role: 'custom_editor',
              branch_id: 'branch-1',
              permissions: ['profiles:create'],
            },
          },
          () =>
            service.inviteUser(
              {
                email: 'invite@example.com',
                firstName: 'Test',
                lastName: 'User',
                role: 'church_admin',
              },
              mockChurchId,
              mockAdminUserId,
            ),
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(staffInvitations.create).not.toHaveBeenCalled();
    });

    it.each(['senior_pastor', 'church_admin', 'media_team'])(
      'allows a plan-filtered Church Admin to invite %s',
      async (role) => {
        const context = new RequestContextService();
        permissionsService.getUserPermissions.mockResolvedValue([
          'members:read',
          'analytics:dashboard:read',
        ]);
        model(prisma, 'branch').findFirst.mockResolvedValue({ id: 'branch-selected' });
        model(prisma, 'profile').findFirst.mockResolvedValue(null);
        model(prisma, 'role').findFirst.mockResolvedValue({ name: role });
        prisma.$transaction.mockResolvedValue({ id: 'reserved-seat' });
        supabase.client.auth.admin.inviteUserByEmail.mockResolvedValue({
          data: { user: { id: 'new-user' } },
        });
        model(prisma, 'profile').create.mockResolvedValue({
          ...mockProfileWithRelations,
          id: 'invited-profile',
          role: [role],
        });
        await context.run(
          {
            userId: mockAdminUserId,
            churchId: mockChurchId,
            role: 'church_admin',
            viewer: {
              church_id: mockChurchId,
              role: 'church_admin',
              is_admin_hq: true,
              permissions: ['profiles:create', 'members:read'],
            },
          },
          () =>
            service.inviteUser(
              {
                email: 'invite@example.com',
                firstName: 'Test',
                lastName: 'User',
                role,
                branchId: 'branch-selected',
              },
              mockChurchId,
              mockAdminUserId,
            ),
        );
        expect(staffInvitations.create).toHaveBeenCalledWith(
          expect.objectContaining({ branchId: 'branch-selected', role }),
        );
        expect(model(prisma, 'branch').findFirst).toHaveBeenCalledWith({
          where: { id: 'branch-selected', church_id: mockChurchId, archived_at: null },
          select: { id: true },
        });
        expect(model(prisma, 'role').findFirst).toHaveBeenCalledWith({
          where: { name: role, OR: [{ church_id: null }, { church_id: mockChurchId }] },
          select: { name: true },
        });
        expect(model(prisma, 'staffInvitationReservation').deleteMany).toHaveBeenCalledWith({
          where: { id: 'reserved-seat' },
        });
      },
    );

    it.each(['super_admin', 'member', 'foreign_role'])(
      'rejects inviting %s before reserving a seat or sending email',
      async (role) => {
        model(prisma, 'role').findFirst.mockResolvedValue(null);
        await expect(
          service.inviteUser(
            { email: 'invite@example.com', firstName: 'Test', lastName: 'User', role },
            mockChurchId,
            mockAdminUserId,
          ),
        ).rejects.toThrow();
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(staffInvitations.create).not.toHaveBeenCalled();
      },
    );

    it('validates invitation branch ownership before sending an invitation', async () => {
      model(prisma, 'branch').findFirst.mockResolvedValue(null);
      await expect(
        service.inviteUser(
          {
            email: 'invite@example.com',
            firstName: 'Test',
            lastName: 'User',
            role: 'cell_leader',
            branchId: 'foreign-branch',
          },
          mockChurchId,
          mockAdminUserId,
        ),
      ).rejects.toThrow(BadRequestException);
      expect(staffInvitations.create).not.toHaveBeenCalled();
    });

    it('rejects HQ grants from general profile editors before writing', async () => {
      model(prisma, 'profile').findUnique.mockResolvedValue({ ...baseProfile });
      await expect(
        service.adminUpdateProfile(
          mockProfileId,
          { isAdminHq: true },
          mockChurchId,
          mockAdminUserId,
          'secretary',
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(model(prisma, 'profile').update).not.toHaveBeenCalled();
    });

    it('allows authorized administrators to change HQ scope and records the flag', async () => {
      permissionsService.getUserPermissions.mockResolvedValue(['church_settings:update']);
      model(prisma, 'profile').findUnique.mockResolvedValue({ ...baseProfile, is_admin_hq: false });
      await service.adminUpdateProfile(
        mockProfileId,
        { isAdminHq: true },
        mockChurchId,
        mockAdminUserId,
        'church_admin',
      );
      expect(model(prisma, 'profile').update).toHaveBeenCalledWith({
        where: { id: mockProfileId },
        data: { is_admin_hq: true },
      });
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          oldValues: expect.objectContaining({ isAdminHq: false }),
          newValues: expect.objectContaining({ isAdminHq: true }),
        }),
      );
    });

    it('blocks self elevation even with administrator permissions', async () => {
      permissionsService.getUserPermissions.mockResolvedValue(['church_settings:update']);
      model(prisma, 'profile').findUnique.mockResolvedValue({
        ...baseProfile,
        user_id: mockAdminUserId,
        is_admin_hq: false,
      });
      await expect(
        service.adminUpdateProfile(
          mockProfileId,
          { isAdminHq: true },
          mockChurchId,
          mockAdminUserId,
          'church_admin',
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(model(prisma, 'profile').update).not.toHaveBeenCalled();
    });

    it('should update basic fields and audit-log the change', async () => {
      model(prisma, 'profile')
        .findUnique.mockResolvedValueOnce({ ...baseProfile })
        .mockResolvedValueOnce({ ...baseProfile, first_name: 'Chinedu' });
      model(prisma, 'branch').findFirst.mockResolvedValue({ id: 'branch-9' });
      model(prisma, 'profile').update.mockResolvedValue({});

      await service.adminUpdateProfile(
        mockProfileId,
        { firstName: 'Chinedu', branchId: 'branch-9', phone: '+2348000000000' },
        mockChurchId,
        mockAdminUserId,
        'church_admin',
      );

      expect(model(prisma, 'profile').update).toHaveBeenCalledWith({
        where: { id: mockProfileId },
        data: {
          first_name: 'Chinedu',
          phone: '+2348000000000',
          branch_id: 'branch-9',
        },
      });
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'profile', action: 'UPDATE' }),
      );
    });

    it('should sync email changes to Supabase Auth', async () => {
      supabase.client.auth.admin.updateUserById.mockResolvedValue({ error: null });
      model(prisma, 'profile').findUnique.mockResolvedValue({ ...baseProfile });
      model(prisma, 'profile').update.mockResolvedValue({});

      await service.adminUpdateProfile(
        mockProfileId,
        { email: 'new@church.com' },
        mockChurchId,
        mockAdminUserId,
        'church_admin',
      );

      expect(supabase.client.auth.admin.updateUserById).toHaveBeenCalledWith(mockUserId, {
        email: 'new@church.com',
      });
    });

    it('should throw ForbiddenException when a church_admin edits a super_admin', async () => {
      model(prisma, 'profile').findUnique.mockResolvedValue({
        ...baseProfile,
        role: ['super_admin'],
      });

      await expect(
        service.adminUpdateProfile(
          mockProfileId,
          { firstName: 'X' },
          mockChurchId,
          mockAdminUserId,
          'church_admin',
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw BadRequestException when the branch is outside the church', async () => {
      model(prisma, 'profile').findUnique.mockResolvedValue({ ...baseProfile });
      model(prisma, 'branch').findFirst.mockResolvedValue(null);

      await expect(
        service.adminUpdateProfile(
          mockProfileId,
          { branchId: 'branch-other-church' },
          mockChurchId,
          mockAdminUserId,
          'church_admin',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should block self-deactivation', async () => {
      model(prisma, 'profile').findUnique.mockResolvedValue({
        ...baseProfile,
        user_id: mockAdminUserId,
      });

      await expect(
        service.adminUpdateProfile(
          mockProfileId,
          { status: 'inactive' },
          mockChurchId,
          mockAdminUserId,
          'super_admin',
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // ─── SOFT DELETE PROFILE ───────────────────────────────────────────

  describe('deleteUserAccount', () => {
    beforeEach(() => {
      model(prisma, 'profile').findFirst.mockResolvedValue({
        id: mockProfileId,
        user_id: mockUserId,
        church_id: mockChurchId,
        role: ['usher'],
        status: 'active',
      });
      prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(prisma));
    });
    it('disables access, removes Auth and profile, and audits deletion', async () => {
      await service.deleteUserAccount(mockProfileId, mockChurchId, mockAdminUserId);
      expect(model(prisma, 'profile').findFirst).toHaveBeenCalledWith({
        where: { id: mockProfileId, church_id: mockChurchId },
      });
      expect(model(prisma, 'profile').update).toHaveBeenCalledWith({
        where: { id: mockProfileId, church_id: mockChurchId },
        data: { status: 'inactive' },
      });
      expect(model(prisma, 'verifiedMfaSession').deleteMany).toHaveBeenCalledWith({
        where: { user_id: mockUserId },
      });
      expect(supabase.client.auth.admin.deleteUser).toHaveBeenCalledWith(mockUserId);
      expect(model(prisma, 'profile').deleteMany).toHaveBeenCalledWith({
        where: { id: mockProfileId, church_id: mockChurchId },
      });
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'DELETE', newValues: { deleted: true } }),
      );
      expect(model(prisma, 'member').delete).not.toHaveBeenCalled();
    });
    it('never deletes Auth when the access-blocking transaction fails', async () => {
      prisma.$transaction.mockRejectedValue(new Error('database unavailable'));
      await expect(
        service.deleteUserAccount(mockProfileId, mockChurchId, mockAdminUserId),
      ).rejects.toThrow('database unavailable');
      expect(supabase.client.auth.admin.deleteUser).not.toHaveBeenCalled();
      expect(model(prisma, 'profile').deleteMany).not.toHaveBeenCalled();
    });
    it('includes the actor branch restriction in target lookup', async () => {
      const scope = jest
        .spyOn(RequestContextService.prototype, 'branchWhere')
        .mockReturnValue({ branch_id: 'allowed-branch' });
      model(prisma, 'profile').findFirst.mockResolvedValue(null);
      try {
        await expect(
          service.deleteUserAccount(mockProfileId, mockChurchId, mockAdminUserId),
        ).rejects.toThrow(NotFoundException);
        expect(model(prisma, 'profile').findFirst).toHaveBeenCalledWith({
          where: { id: mockProfileId, church_id: mockChurchId, branch_id: 'allowed-branch' },
        });
      } finally {
        scope.mockRestore();
      }
    });
    it('keeps an inactive profile for retry when Auth rejects deletion', async () => {
      supabase.client.auth.admin.deleteUser.mockResolvedValue({ error: { status: 503 } });
      await expect(
        service.deleteUserAccount(mockProfileId, mockChurchId, mockAdminUserId),
      ).rejects.toThrow('remains inactive');
      expect(model(prisma, 'profile').deleteMany).not.toHaveBeenCalled();
    });
    it('allows retry if Auth was already removed', async () => {
      supabase.client.auth.admin.deleteUser.mockResolvedValue({ error: { status: 404 } });
      await expect(
        service.deleteUserAccount(mockProfileId, mockChurchId, mockAdminUserId),
      ).resolves.toBeUndefined();
    });
    it.each([
      ['self', mockAdminUserId, ['church_admin']],
      ['platform', mockUserId, ['super_admin']],
    ])('protects %s accounts', async (_label, userId, role) => {
      model(prisma, 'profile').findFirst.mockResolvedValue({
        id: mockProfileId,
        user_id: userId,
        role,
      });
      await expect(
        service.deleteUserAccount(mockProfileId, mockChurchId, mockAdminUserId),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(supabase.client.auth.admin.deleteUser).not.toHaveBeenCalled();
    });
    it('rejects accounts outside the tenant or branch', async () => {
      model(prisma, 'profile').findFirst.mockResolvedValue(null);
      await expect(
        service.deleteUserAccount(mockProfileId, mockChurchId, mockAdminUserId),
      ).rejects.toThrow(NotFoundException);
      expect(supabase.client.auth.admin.deleteUser).not.toHaveBeenCalled();
    });
  });

  describe('softDeleteProfile', () => {
    it('should deactivate profile successfully', async () => {
      model(prisma, 'profile').findUnique.mockResolvedValue({
        id: mockProfileId,
        user_id: mockUserId,
        church_id: mockChurchId,
        role: 'cell_leader',
        status: 'active',
      });

      await service.softDeleteProfile(mockProfileId, mockChurchId, mockAdminUserId);

      expect(model(prisma, 'profile').update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: mockProfileId },
          data: { status: 'inactive' },
        }),
      );
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: mockAdminUserId,
          entity: 'profile',
          action: 'DELETE',
        }),
      );
    });

    it('should throw NotFoundException if profile does not exist', async () => {
      model(prisma, 'profile').findUnique.mockResolvedValue(null);

      await expect(
        service.softDeleteProfile(mockProfileId, mockChurchId, mockAdminUserId),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException when trying to self-deactivate', async () => {
      model(prisma, 'profile').findUnique.mockResolvedValue({
        id: mockProfileId,
        user_id: mockAdminUserId,
        church_id: mockChurchId,
        role: 'church_admin',
      });

      await expect(
        service.softDeleteProfile(mockProfileId, mockChurchId, mockAdminUserId),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // ─── ARCHIVE PROFILE ───────────────────────────────────────────────

  describe('archiveProfile', () => {
    it('should set archived_at and audit ARCHIVE', async () => {
      model(prisma, 'profile').findFirst.mockResolvedValue(mockProfileWithRelations);
      model(prisma, 'profile').update.mockResolvedValue({});
      model(prisma, 'profile').findUnique.mockResolvedValue({
        ...mockProfileWithRelations,
        archived_at: new Date('2026-08-28T12:00:00.000Z'),
      });

      const result = await service.archiveProfile(mockProfileId, mockChurchId, mockAdminUserId);

      expect(model(prisma, 'profile').update).toHaveBeenCalledWith({
        where: { id: mockProfileId },
        data: { archived_at: expect.any(Date) },
      });
      expect(result.archivedAt).toBe('2026-08-28T12:00:00.000Z');
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'ARCHIVE', entity: 'profile' }),
      );
    });

    it('should throw ConflictException when already archived', async () => {
      model(prisma, 'profile').findFirst.mockResolvedValue({
        ...mockProfileWithRelations,
        archived_at: new Date(),
      });

      await expect(
        service.archiveProfile(mockProfileId, mockChurchId, mockAdminUserId),
      ).rejects.toThrow(ConflictException);
    });

    it('should throw NotFoundException if profile not found', async () => {
      model(prisma, 'profile').findFirst.mockResolvedValue(null);

      await expect(
        service.archiveProfile(mockProfileId, mockChurchId, mockAdminUserId),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ─── RESTORE ARCHIVED PROFILE ──────────────────────────────────────

  describe('restoreArchivedProfile', () => {
    it('should clear archived_at and audit RESTORE', async () => {
      model(prisma, 'profile').findFirst.mockResolvedValue({
        ...mockProfileWithRelations,
        archived_at: new Date('2026-08-27T12:00:00.000Z'),
      });
      model(prisma, 'profile').update.mockResolvedValue({});
      model(prisma, 'profile').findUnique.mockResolvedValue(mockProfileWithRelations);

      const result = await service.restoreArchivedProfile(
        mockProfileId,
        mockChurchId,
        mockAdminUserId,
      );

      expect(model(prisma, 'profile').update).toHaveBeenCalledWith({
        where: { id: mockProfileId },
        data: { archived_at: null },
      });
      expect(result.archivedAt).toBeUndefined();
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'RESTORE', entity: 'profile' }),
      );
    });

    it('should throw ConflictException when not archived', async () => {
      model(prisma, 'profile').findFirst.mockResolvedValue(mockProfileWithRelations);

      await expect(
        service.restoreArchivedProfile(mockProfileId, mockChurchId, mockAdminUserId),
      ).rejects.toThrow(ConflictException);
    });

    it('should throw NotFoundException if profile not found', async () => {
      model(prisma, 'profile').findFirst.mockResolvedValue(null);

      await expect(
        service.restoreArchivedProfile(mockProfileId, mockChurchId, mockAdminUserId),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ─── MUTATION GUARD ON ARCHIVED PROFILE ────────────────────────────

  describe('mutation guard on archived profiles', () => {
    it('should throw NotFoundException when updating the role of an archived profile', async () => {
      model(prisma, 'profile').findUnique.mockResolvedValue({
        id: mockProfileId,
        user_id: mockUserId,
        church_id: mockChurchId,
        role: ['cell_leader'],
        archived_at: new Date('2026-08-28T10:00:00.000Z'),
      });

      await expect(
        service.updateProfileRole(
          mockProfileId,
          { role: 'secretary' },
          mockChurchId,
          mockAdminUserId,
          'church_admin',
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('should allow reactivation (status soft-delete restore) of an archived profile', async () => {
      model(prisma, 'profile').findFirst.mockResolvedValue({
        ...mockProfileWithRelations,
        status: 'inactive',
        archived_at: new Date('2026-08-28T10:00:00.000Z'),
      });
      model(prisma, 'profile').update.mockResolvedValue({});
      model(prisma, 'profile').findUnique.mockResolvedValue(mockProfileWithRelations);

      const result = await service.reactivateProfile(mockProfileId, mockChurchId, mockAdminUserId);

      expect(result.profileId).toBe(mockProfileId);
    });
  });
  describe('effective grant provenance and optional profile data', () => {
    const read = { name: 'members:read', resource: 'members', action: 'read' };
    const update = { name: 'members:update', resource: 'members', action: 'update' };
    const attendance = { name: 'attendance:read', resource: 'attendance', action: 'read' };
    it.each([['custom-a', 'custom-b', 'custom-a'], ['super_admin'], ['church_admin']])(
      'merges and sorts permission provenance while honoring the effective permission filter (%j)',
      async (...roles) => {
        model(prisma, 'profile').findUnique.mockResolvedValue({
          ...mockProfileWithRelations,
          role: roles,
        });
        model(prisma, 'role').findMany.mockResolvedValue(
          roles.map((name) => ({ name, label: name, church_id: null, description: null })),
        );
        permissionsService.getRolePermissions.mockResolvedValue({
          permissions: [update, read, read],
        });
        permissionsService.getAllPermissions.mockResolvedValue([attendance, read]);
        permissionsService.getUserPermissions.mockResolvedValue([
          attendance.name,
          read.name,
          update.name,
        ]);
        const result = await service.getProfileById(mockProfileId, mockChurchId);
        expect(result.effectivePermissions?.map((p) => p.name)).toEqual(
          roles.includes('custom-a')
            ? [read.name, update.name]
            : [attendance.name, read.name, update.name],
        );
        expect(result.effectivePermissions?.find((p) => p.name === read.name)?.grantedBy).toEqual(
          roles.includes('custom-a')
            ? ['custom-a', 'custom-b']
            : roles.includes('super_admin')
              ? ['super_admin']
              : ['church_admin', 'super_admin'],
        );
        expect(result.roles?.map((role) => role.label)).toEqual(roles);
      },
    );
    it('does not report grants that were revoked from the effective role union', async () => {
      model(prisma, 'profile').findUnique.mockResolvedValue({
        ...mockProfileWithRelations,
        role: ['custom'],
      });
      model(prisma, 'role').findMany.mockResolvedValue([]);
      permissionsService.getRolePermissions.mockResolvedValue({ permissions: [read, update] });
      permissionsService.getUserPermissions.mockResolvedValue([read.name]);
      expect(
        (await service.getProfileById(mockProfileId, mockChurchId)).effectivePermissions?.map(
          (p) => p.name,
        ),
      ).toEqual([read.name]);
    });
    it.each([null, { error: { message: 'Unavailable' }, data: null }])(
      'keeps detail readable without optional roles/sign-in data (%j)',
      async (auth) => {
        model(prisma, 'profile').findUnique.mockResolvedValue({
          ...mockProfileWithRelations,
          role: null,
          church: { ...mockProfileWithRelations.church, denomination: null },
          member: {
            id: 'm',
            first_name: 'Ada',
            last_name: 'Guest',
            email: null,
            phone: null,
            photo_url: null,
            date_of_birth: null,
            gender: null,
            address: null,
            status: 'active',
          },
        });
        model(prisma, 'role').findMany.mockResolvedValue([]);
        permissionsService.getUserPermissions.mockResolvedValue([]);
        if (auth) supabase.client.auth.admin.getUserById.mockResolvedValue(auth);
        else supabase.client.auth.admin.getUserById.mockRejectedValue(new Error('Unavailable'));
        const result = await service.getProfileById(mockProfileId, mockChurchId);
        expect(result.role).toEqual([]);
        expect(result.lastSignInAt).toBeUndefined();
        expect(result.member).toMatchObject({
          email: undefined,
          phone: undefined,
          photoUrl: undefined,
          gender: undefined,
          address: undefined,
        });
      },
    );
    it('pins a filtered inactive profile list to the verified branch', async () => {
      model(prisma, 'profile').findMany.mockResolvedValue([]);
      model(prisma, 'profile').count.mockResolvedValue(0);
      await service.listProfiles(
        mockChurchId,
        {
          status: 'inactive',
          role: 'secretary',
          branchId: 'foreign',
          sortBy: 'first_name',
          sortOrder: 'desc',
          search: 'Ada',
          page: 2,
          limit: 4,
        },
        { church_id: mockChurchId, role: 'branch_pastor', branch_id: 'own' },
      );
      expect(model(prisma, 'profile').findMany.mock.calls[0][0]).toMatchObject({
        where: {
          church_id: mockChurchId,
          branch_id: 'own',
          status: 'inactive',
          role: { has: 'secretary' },
        },
        skip: 4,
        take: 4,
        orderBy: [{ first_name: 'desc' }],
      });
    });
  });
});
