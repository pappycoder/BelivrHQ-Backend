import { plainToInstance } from 'class-transformer';
import { UpdateChurchDto } from '../../../src/church/dto/update-church.dto';
import { ForbiddenException } from '@nestjs/common';
import {
  StaffInvitationService,
  StaffInvitationInput,
} from '../../../src/company-email/staff-invitation.service';
import { RequestContextService } from '../../../src/common/services/request-context.service';
import { Test, TestingModule } from '@nestjs/testing';
import { ChurchService } from '../../../src/church/church.service';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { SupabaseService } from '../../../src/supabase/supabase.service';
import { AuditLoggingService } from '../../../src/common/services/audit-logging.service';
import { MediaService } from '../../../src/media/media.service';
import { NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { createPrismaMock } from '../../helpers/prisma-mock.helper';

describe('ChurchService', () => {
  let service: ChurchService;
  let staffInvitations: { create: jest.Mock };
  let prisma: ReturnType<typeof createPrismaMock>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let supabaseClient: Record<string, any> & { auth: { admin: Record<string, jest.Mock> } };
  let auditLog: jest.Mock;
  let mediaDelete: jest.Mock;

  const mockChurch = {
    id: 'church-1',
    name: 'Grace Community Church',
    denomination: 'Pentecostal',
    address: '123 Faith Avenue',
    city: 'Lagos',
    state: 'Lagos',
    country: 'Nigeria',
    phone: '+234 801 234 5678',
    email: 'info@grace.org',
    website: 'https://grace.org',
    logo_url: null,
    created_at: new Date('2024-01-15'),
    updated_at: new Date('2024-06-20'),
    _count: { branches: 3, members: 150 },
  };

  beforeEach(async () => {
    prisma = createPrismaMock();
    prisma.platformSubscription.findUnique.mockResolvedValue({
      plan: 'network',
      paid_until: new Date('2099-01-01'),
    });
    (prisma.$transaction as unknown as jest.Mock).mockResolvedValue({ id: 'seat-reservation' });
    auditLog = jest.fn();
    mediaDelete = jest.fn();

    supabaseClient = {
      auth: {
        admin: {
          inviteUserByEmail: jest.fn(),
          getUserById: jest.fn(),
          listUsers: jest.fn(),
          updateUserById: jest.fn(),
        },
      },
    };

    staffInvitations = {
      create: jest.fn(async (input: StaffInvitationInput) =>
        prisma.profile.create({
          data: {
            user_id: 'auth-user-1',
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
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RequestContextService,
        ChurchService,
        { provide: StaffInvitationService, useValue: staffInvitations },
        { provide: PrismaService, useValue: prisma },
        { provide: SupabaseService, useValue: { client: supabaseClient } },
        { provide: AuditLoggingService, useValue: { log: auditLog } },
        { provide: MediaService, useValue: { deleteByUrl: mediaDelete } },
      ],
    }).compile();

    service = module.get<ChurchService>(ChurchService);
  });

  describe('getChurch', () => {
    it('should return church details', async () => {
      prisma.church.findUnique.mockResolvedValue(mockChurch);

      const result = await service.getChurch('church-1');

      expect(result.churchId).toBe('church-1');
      expect(result.name).toBe('Grace Community Church');
      expect(result.branchCount).toBe(3);
      expect(result.memberCount).toBe(150);
    });

    it('should throw NotFoundException if church not found', async () => {
      prisma.church.findUnique.mockResolvedValue(null);

      await expect(service.getChurch('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateChurch', () => {
    it('should update church details', async () => {
      prisma.church.findUnique.mockResolvedValue(mockChurch);
      prisma.church.update.mockResolvedValue({ ...mockChurch, name: 'New Name' });

      const result = await service.updateChurch('church-1', { name: 'New Name' }, 'user-1');

      expect(result.name).toBe('New Name');
      expect(auditLog).toHaveBeenCalled();
    });

    it('should trim whitespace in church update fields', async () => {
      prisma.church.findUnique.mockResolvedValue(mockChurch);
      prisma.church.update.mockResolvedValue({ ...mockChurch, name: 'Grace Community Church' });

      await service.updateChurch(
        'church-1',
        { name: '  Grace Community Church  ', email: '  info@grace.org  ' },
        'user-1',
      );

      expect(prisma.church.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            name: 'Grace Community Church',
            email: 'info@grace.org',
          }),
        }),
      );
    });

    it('should delete old logo when updating logoUrl', async () => {
      const churchWithLogo = { ...mockChurch, logo_url: 'https://old-logo.jpg' };
      prisma.church.findUnique.mockResolvedValue(churchWithLogo);
      prisma.church.update.mockResolvedValue({
        ...churchWithLogo,
        logo_url: 'https://new-logo.jpg',
      });

      await service.updateChurch('church-1', { logoUrl: 'https://new-logo.jpg' }, 'user-1');

      expect(mediaDelete).toHaveBeenCalledWith('https://old-logo.jpg');
    });

    it('should return existing church if no fields provided', async () => {
      prisma.church.findUnique.mockResolvedValue(mockChurch);

      const result = await service.updateChurch('church-1', {}, 'user-1');

      expect(result.churchId).toBe('church-1');
      expect(prisma.church.update).not.toHaveBeenCalled();
    });
  });

  describe('updateChurchEmail', () => {
    const mockProfile = {
      id: 'profile-1',
      user_id: 'user-1',
      church_id: 'church-1',
      email: 'info@grace.org',
    };

    it('should sync the sign-in email and update profile + church together', async () => {
      prisma.church.findUnique
        .mockResolvedValueOnce(mockChurch)
        .mockResolvedValueOnce({ ...mockChurch, email: 'new@grace.org' });
      prisma.profile.findFirst.mockResolvedValue(mockProfile);
      supabaseClient.auth.admin.updateUserById.mockResolvedValue({ error: null });
      (prisma.$transaction as unknown as jest.Mock).mockResolvedValue([]);

      const result = await service.updateChurchEmail('church-1', 'user-1', {
        email: 'new@grace.org',
      });

      expect(supabaseClient.auth.admin.updateUserById).toHaveBeenCalledWith('user-1', {
        email: 'new@grace.org',
      });
      expect(prisma.$transaction as unknown as jest.Mock).toHaveBeenCalledTimes(1);
      expect(auditLog).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'church', action: 'UPDATE' }),
      );
      expect(result.email).toBe('new@grace.org');
    });

    it('should throw BadRequestException and write nothing when Supabase rejects the email', async () => {
      prisma.church.findUnique.mockResolvedValue(mockChurch);
      prisma.profile.findFirst.mockResolvedValue(mockProfile);
      supabaseClient.auth.admin.updateUserById.mockResolvedValue({
        error: { message: 'already registered' },
      });

      await expect(
        service.updateChurchEmail('church-1', 'user-1', { email: 'taken@example.com' }),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(auditLog).not.toHaveBeenCalled();
    });

    it('should no-op when the email is already aligned everywhere', async () => {
      prisma.church.findUnique.mockResolvedValueOnce(mockChurch).mockResolvedValueOnce(mockChurch);
      prisma.profile.findFirst.mockResolvedValue(mockProfile);

      const result = await service.updateChurchEmail('church-1', 'user-1', {
        email: 'info@grace.org',
      });

      expect(supabaseClient.auth.admin.updateUserById).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(result.email).toBe('info@grace.org');
    });

    it('should throw NotFoundException when the acting admin has no profile', async () => {
      prisma.church.findUnique.mockResolvedValue(mockChurch);
      prisma.profile.findFirst.mockResolvedValue(null);

      await expect(
        service.updateChurchEmail('church-1', 'user-1', { email: 'new@grace.org' }),
      ).rejects.toThrow(NotFoundException);
      expect(supabaseClient.auth.admin.updateUserById).not.toHaveBeenCalled();
    });
  });

  describe('getChurchConfig', () => {
    it('should return config as key-value object', async () => {
      prisma.churchConfig.findMany.mockResolvedValue([
        { key: 'timezone', value: 'Africa/Lagos' },
        { key: 'currency', value: 'NGN' },
      ]);

      const result = await service.getChurchConfig('church-1');

      expect(result.config).toEqual({
        timezone: 'Africa/Lagos',
        currency: 'NGN',
      });
    });
  });

  describe('inviteStaff', () => {
    beforeEach(() => prisma.role.findFirst.mockResolvedValue({ name: 'branch_pastor' }));

    it.each(['super_admin', 'member', 'foreign_role'])(
      'rejects inviting %s before sending email',
      async (role) => {
        prisma.role.findFirst.mockResolvedValue(null);
        await expect(
          service.inviteStaff(
            'church-1',
            { email: 'invite@example.com', firstName: 'Test', lastName: 'User', role },
            'user-1',
          ),
        ).rejects.toThrow();
        expect(staffInvitations.create).not.toHaveBeenCalled();
        expect(prisma.$transaction).not.toHaveBeenCalled();
      },
    );
    it('should invite staff and create profile', async () => {
      prisma.profile.findFirst.mockResolvedValue(null);
      supabaseClient.auth.admin.inviteUserByEmail.mockResolvedValue({
        data: { user: { id: 'auth-user-1' } },
        error: null,
      });
      prisma.profile.create.mockResolvedValue({
        id: 'profile-1',
        user_id: 'auth-user-1',
        church_id: 'church-1',
        branch_id: null,
        role: 'branch_pastor',
        first_name: 'James',
        last_name: 'Adeyemi',
        phone: null,
        created_at: new Date(),
      });
      prisma.branch.findUnique.mockResolvedValue(null);

      const result = await service.inviteStaff(
        'church-1',
        {
          email: 'james@church.org',
          firstName: 'James',
          lastName: 'Adeyemi',
          role: 'branch_pastor',
        },
        'user-1',
      );

      expect(result.email).toBe('james@church.org');
      expect(result.role).toBe('branch_pastor');
      expect(auditLog).toHaveBeenCalled();
    });

    it('should normalize invitation values before creating the profile', async () => {
      prisma.profile.findFirst.mockResolvedValue(null);
      supabaseClient.auth.admin.inviteUserByEmail.mockResolvedValue({
        data: { user: { id: 'auth-user-1' } },
        error: null,
      });
      prisma.profile.create.mockResolvedValue({
        id: 'profile-1',
        user_id: 'auth-user-1',
        church_id: 'church-1',
        branch_id: null,
        role: 'branch_pastor',
        first_name: 'James',
        last_name: 'Adeyemi',
        phone: null,
        created_at: new Date(),
      });
      prisma.branch.findUnique.mockResolvedValue(null);

      await service.inviteStaff(
        'church-1',
        {
          email: '  JAMES@CHURCH.ORG  ',
          firstName: '  James  ',
          lastName: '  Adeyemi  ',
          role: '  branch_pastor  ',
          phone: '  +2348012345678  ',
        },
        'user-1',
      );

      expect(staffInvitations.create).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'james@church.org' }),
      );
      expect(prisma.profile.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            role: ['branch_pastor'],
            first_name: 'James',
            last_name: 'Adeyemi',
            phone: '+2348012345678',
          }),
        }),
      );
    });

    it('should throw ConflictException if email already exists', async () => {
      prisma.profile.findFirst.mockResolvedValue({ id: 'existing', user_id: 'user-exists' });
      supabaseClient.auth.admin.getUserById.mockResolvedValue({
        data: { user: { email: 'james@church.org' } },
      });

      await expect(
        service.inviteStaff(
          'church-1',
          {
            email: 'james@church.org',
            firstName: 'James',
            lastName: 'Adeyemi',
            role: 'branch_pastor',
          },
          'user-1',
        ),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('listStaff', () => {
    it('should return paginated staff list', async () => {
      prisma.profile.findMany.mockResolvedValue([
        {
          id: 'profile-1',
          user_id: 'auth-user-1',
          first_name: 'James',
          last_name: 'Adeyemi',
          phone: null,
          role: 'branch_pastor',
          branch_id: null,
          branch: null,
          created_at: new Date(),
        },
      ]);
      prisma.profile.count.mockResolvedValue(1);
      supabaseClient.auth.admin.listUsers.mockResolvedValue({
        data: { users: [{ id: 'auth-user-1', email: 'james@church.org' }] },
      });

      const result = await service.listStaff('church-1', { page: 1, limit: 20 });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].email).toBe('james@church.org');
      expect(result.total).toBe(1);
    });
  });

  describe('removeStaff', () => {
    it('should soft-delete staff by setting role to removed', async () => {
      prisma.profile.findUnique.mockResolvedValue({
        id: 'profile-1',
        church_id: 'church-1',
        role: 'branch_pastor',
      });
      prisma.profile.update.mockResolvedValue({});

      const result = await service.removeStaff('church-1', 'profile-1', 'user-1');

      expect(result.success).toBe(true);
      expect(prisma.profile.update).toHaveBeenCalledWith({
        where: { id: 'profile-1' },
        data: { role: ['removed'], status: 'inactive', is_admin_hq: false },
      });
    });

    it('should throw NotFoundException if staff not found', async () => {
      prisma.profile.findUnique.mockResolvedValue(null);

      await expect(service.removeStaff('church-1', 'nonexistent', 'user-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
  describe('optional church data and staff administration boundaries', () => {
    it.each(['  Updated  ', '  ', null])(
      'normalizes all supplied contact fields without retaining stale values (%j)',
      async (value) => {
        prisma.church.findUnique.mockResolvedValue(mockChurch);
        prisma.church.update.mockResolvedValue(mockChurch);
        const fields = [
          'name',
          'denomination',
          'address',
          'city',
          'state',
          'country',
          'phone',
          'email',
          'website',
        ];
        await service.updateChurch(
          'church-1',
          plainToInstance(UpdateChurchDto, {
            ...Object.fromEntries(fields.map((field) => [field, value])),
            logoUrl: null,
          }),
          'actor',
        );
        expect(prisma.church.update.mock.calls[0][0].data).toEqual({
          ...Object.fromEntries(fields.map((field) => [field, value?.trim() || ''])),
          logo_url: '',
        });
        expect(auditLog).toHaveBeenCalledWith(
          expect.objectContaining({
            churchId: 'church-1',
            newValues: prisma.church.update.mock.calls[0][0].data,
          }),
        );
      },
    );
    it('preserves legacy empty optional fields and absent count relations', async () => {
      prisma.church.findUnique.mockResolvedValue({
        ...mockChurch,
        denomination: null,
        address: null,
        city: null,
        state: null,
        phone: null,
        email: null,
        website: null,
        _count: null,
      });
      const result = await service.getChurch('church-1');
      expect(result).toMatchObject({ branchCount: 0, memberCount: 0 });
      for (const field of ['denomination', 'address', 'city', 'state', 'phone', 'email', 'website'])
        expect(result).toHaveProperty(field, undefined);
    });
    it.each(['update', 'email', 'archive', 'restore'])(
      'refuses a missing church before %s changes',
      async (operation) => {
        prisma.church.findUnique.mockResolvedValue(null);
        const result =
          operation === 'update'
            ? service.updateChurch('church-1', { name: 'New' }, 'actor')
            : operation === 'email'
              ? service.updateChurchEmail('church-1', 'actor', { email: 'a@example.invalid' })
              : operation === 'archive'
                ? service.archiveChurch('church-1', 'actor')
                : service.restoreChurch('church-1', 'actor');
        await expect(result).rejects.toThrow(NotFoundException);
        expect(prisma.church.update).not.toHaveBeenCalled();
        expect(auditLog).not.toHaveBeenCalled();
      },
    );
    it.each([true, false])(
      'rejects duplicate archive/restore transitions (archived=%s)',
      async (archived) => {
        prisma.church.findUnique.mockResolvedValue({
          ...mockChurch,
          archived_at: archived ? new Date() : null,
        });
        await expect(
          archived
            ? service.archiveChurch('church-1', 'actor')
            : service.restoreChurch('church-1', 'actor'),
        ).rejects.toThrow(ConflictException);
        expect(auditLog).not.toHaveBeenCalled();
      },
    );
    it('returns an empty staff page without querying Auth', async () => {
      prisma.profile.findMany.mockResolvedValue([]);
      prisma.profile.count.mockResolvedValue(0);
      expect(
        await service.listStaff('church-1', { role: 'treasurer', page: 2, limit: 999 }),
      ).toEqual({ data: [], total: 0 });
      expect(prisma.profile.findMany.mock.calls[0][0]).toMatchObject({
        skip: 100,
        take: 100,
        where: { church_id: 'church-1', role: { has: 'treasurer' } },
      });
      expect(supabaseClient.auth.admin.getUserById).not.toHaveBeenCalled();
    });
    it.each([null, { id: 'staff', church_id: 'foreign', role: ['member'] }])(
      'refuses staff role changes and removal outside the tenant (%j)',
      async (profile) => {
        prisma.profile.findUnique.mockResolvedValue(profile);
        await expect(
          service.updateStaffRole('church-1', 'staff', { role: 'treasurer' }, 'actor'),
        ).rejects.toThrow(NotFoundException);
        await expect(service.removeStaff('church-1', 'staff', 'actor')).rejects.toThrow(
          NotFoundException,
        );
        expect(prisma.profile.update).not.toHaveBeenCalled();
      },
    );
    it.each([['super_admin'], ['member']])(
      'refuses protected and self role edits (%j)',
      async (roles) => {
        prisma.profile.findUnique.mockResolvedValue({
          id: 'staff',
          user_id: 'actor',
          church_id: 'church-1',
          role: roles,
        });
        await expect(
          service.updateStaffRole('church-1', 'staff', { role: 'treasurer' }, 'actor'),
        ).rejects.toThrow(ForbiddenException);
        expect(prisma.profile.update).not.toHaveBeenCalled();
      },
    );
    it.each([null, { name: 'super_admin' }])(
      'rejects unknown or system-only requested staff roles (%j)',
      async (role) => {
        prisma.profile.findUnique.mockResolvedValue({
          id: 'staff',
          user_id: 'other',
          church_id: 'church-1',
          role: ['member'],
        });
        prisma.role.findFirst.mockResolvedValue(role);
        await expect(
          service.updateStaffRole(
            'church-1',
            'staff',
            { role: role ? 'super_admin' : 'unknown' },
            'actor',
          ),
        ).rejects.toThrow(BadRequestException);
        expect(prisma.profile.update).not.toHaveBeenCalled();
      },
    );
  });
});
